// Acceptance 3: reveal refuses before Revealable or out of commit order; pins the plaintext (bCID); sends
// reveal with the keys and any prepay top-up. The E1 line the contract writes opens the same bytes
// arbiters will check, and no RPC sees a real key before the plaintext is pinned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { closeRpc, readJson, rpcOf, runCli, statePath } from './helpers/cli.js';
import { codeReview, formsOf, makeClaimDir, makeWorld, sha256, vectorOf, JUSTIFICATION_CID } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => {
  await closeRpc(w);
  await w.close();
});

const committed = async (over = {}, dir = makeClaimDir()) => {
  const l = await w.listing(over);
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  return { l, dir, claimId: r.claimId, ciphertextCid: r.ciphertextCid };
};

test('before Revealable: refused, with the time, and the plaintext stays on this machine', async () => {
  const { dir, claimId } = await committed({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'NOT_REVEALABLE_YET' && /after/.test(e.message));
  assert.equal(w.ipfs.uploads.length, uploads);
  assert.equal((await w.sa.getClaim(claimId)).state, 0n);
});

test('out of commit order: refused while an earlier claim is unresolved, naming it; goes through once it is', async () => {
  const l = await w.listing();
  const first = makeClaimDir();
  const second = makeClaimDir();
  const a = await w.hunter().commit({ claimDir: first, listingId: l.listingId, acknowledge: true });
  const b = await w.hunter().commit({ claimDir: second, listingId: l.listingId, acknowledge: true });
  assert.equal(await w.sa.claimState(b.claimId), 1n, 'the lens says Revealable: that alone is not "may reveal"');
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().reveal({ claimDir: second }), (e) => e.code === 'OUT_OF_ORDER' && e.message.includes(String(a.claimId)));
  assert.equal(w.ipfs.uploads.length, uploads);
  await w.hunter().reveal({ claimDir: first });
  const req = (await w.sa.getClaim(a.claimId)).requestId;
  await (await w.aggregator.scriptResult(req, vectorOf('INVALID'), JUSTIFICATION_CID)).wait();
  await (await w.sa.finalize(a.claimId)).wait();
  await (await w.sa.settle(a.claimId)).wait();
  const r = await w.hunter().reveal({ claimDir: second });
  assert.equal(r.state, 'Revealed');
});

test('a release or a roll-forward makes it revealable at once, as the lens says', async () => {
  const { dir, claimId } = await committed({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  await (await w.sa.connect(w.maker).release(claimId)).wait();
  assert.equal((await w.hunter().reveal({ claimDir: dir })).state, 'Revealed');
});

test('past the reveal window: refused, nothing pinned', async () => {
  const { dir } = await committed();
  await w.increase(8 * 86400);
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'REVEAL_WINDOW_OVER');
  assert.equal(w.ipfs.uploads.length, uploads);
});

test('reveal: the bCID pinned, the keys and any top-up sent, and the addendum\'s line opens what was committed', async () => {
  const { l, dir, claimId, ciphertextCid } = await committed();
  await (await w.aggregator.setFeeMultiplier(5n)).wait();
  try {
    const topUp = await w.sa.revealTopUp(claimId);
    assert.ok(topUp > 0n);
    const r = await w.hunter().reveal({ claimDir: dir });
    assert.equal(r.topUpWei, topUp);
    const claim = await w.sa.getClaim(claimId);
    const keys = readJson(statePath(dir, 'keys.json'));
    const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
    assert.equal(claim.state, 2n);
    assert.equal(claim.contentKey, keys.contentKey);
    assert.equal(claim.ephemeralKey, keys.ephemeralKey);
    assert.equal(claim.bcid, r.bcid);
    assert.equal(sha256(w.ipfs.store.get(claim.bcid)), claim.archiveHash);
    assert.ok(w.ipfs.store.get(claim.bcid).equals(archive));
    assert.equal(claim.prepayWei, 5n * 120000000000000n);
    const cids = await w.aggregator.getRequestCids(claim.requestId);
    assert.equal(cids[0], l.listingCid);
    assert.equal(cids[1], claim.bcid);
    // what every arbiter's disclosure gate runs, on what is now public
    const gate = codeReview.verifyDisclosure({ plaintext: new Uint8Array(w.ipfs.store.get(claim.bcid)), ciphertext: new Uint8Array(w.ipfs.store.get(ciphertextCid)), archiveSha256: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, contentKey: claim.contentKey, ephemeralKey: claim.ephemeralKey, disclosureKey: l.spec.stake.disclosureKey });
    assert.equal(gate.ok, true);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('no real key in any RPC call before the signed reveal, whatever is dry-run', async () => {
  const { dir } = await committed();
  const rpc = await rpcOf(w);
  rpc.calls.length = 0;
  const keys = readJson(statePath(dir, 'keys.json'));
  const r = await runCli(w, ['reveal', dir]);
  assert.equal(r.code, 0, r.stderr);
  const secret = [...formsOf(keys.contentKey), ...formsOf(keys.ephemeralKey)];
  const carrying = rpc.calls.filter((c) => secret.some((s) => JSON.stringify(c).includes(s)));
  assert.ok(carrying.length > 0, 'the reveal itself carries them');
  for (const c of carrying) assert.equal(c.method, 'eth_sendRawTransaction', `${c.method} saw a real key`);
  const firstRaw = rpc.calls.findIndex((c) => c.method === 'eth_sendRawTransaction');
  assert.ok(firstRaw >= 0);
});

test('the reveal is sent with enough gas for the request, so a refusal is the aggregator\'s and not the gas limit\'s', async () => {
  const { dir, claimId } = await committed();
  await w.hunter().reveal({ claimDir: dir });
  const txHash = readJson(statePath(dir)).revealTx.hash;
  const tx = await w.provider.getTransaction(txHash);
  assert.ok(tx.gasLimit >= await w.sa.SUBMISSION_GAS_NEEDED());
  assert.equal((await w.sa.getClaim(claimId)).roundStarted, true);
});

test('a wallet that cannot pay the gas limit and top-up is stopped before the plaintext is pinned', async () => {
  const { dir } = await committed();
  const uploads = w.ipfs.uploads.length;
  const { ethers } = await import('ethers');
  const sink = ethers.Wallet.createRandom().address;
  const balance = await w.provider.getBalance(w.hunterWallet.address);
  await w.rpc('hardhat_setBalance', [w.hunterWallet.address, '0x1000']);
  try {
    await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'INSUFFICIENT_FUNDS');
    assert.equal(w.ipfs.uploads.length, uploads);
  } finally {
    await w.rpc('hardhat_setBalance', [w.hunterWallet.address, `0x${balance.toString(16)}`]);
  }
  assert.ok(sink);
});

test('a refused request: the reveal stands, RoundFailed, the tool says so; retrigger takes it on', async () => {
  const { dir, claimId } = await committed();
  await (await w.aggregator.setPaused(true)).wait();
  const refused = await w.hunter().reveal({ claimDir: dir });
  assert.equal(refused.state, 'RoundFailed');
  assert.match(refused.next, /retrigger/);
  await (await w.aggregator.setPaused(false)).wait();
  const again = await w.hunter().reveal({ claimDir: dir });
  assert.equal(again.state, 'RoundFailed', 'a plain re-run changes nothing');
  const r = await w.hunter().reveal({ claimDir: dir, retrigger: true });
  assert.equal(r.state, 'Revealed');
  assert.notEqual((await w.sa.getClaim(claimId)).requestId, `0x${'00'.repeat(32)}`);
});

test('reveal knows only its own folder: no state, a refusal; another wallet, a refusal', async () => {
  await assert.rejects(w.hunter().reveal({ claimDir: makeClaimDir() }), (e) => e.code === 'NO_CLAIM_HERE');
  const { dir } = await committed();
  const { ethers } = await import('ethers');
  await assert.rejects(w.hunter({ signer: new ethers.Wallet(w.keyOf(7), w.provider) }).reveal({ claimDir: dir }), (e) => e.code === 'STATE_MISMATCH');
});

test('reveal on a claim that was committed but never disclosed: finish the disclosure first, no plaintext', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'commit:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'NOT_DISCLOSED' && /commit/.test(e.message));
  assert.equal(w.ipfs.uploads.length, uploads);
});

test('an already revealed claim is a no-op, and an expired one says so', async () => {
  const { dir } = await committed();
  await w.hunter().reveal({ claimDir: dir });
  const uploads = w.ipfs.uploads.length;
  const again = await w.hunter().reveal({ claimDir: dir });
  assert.equal(again.state, 'Revealed');
  assert.equal(w.ipfs.uploads.length, uploads);
  const late = await committed();
  await w.increase(8 * 86400);
  await (await w.sa.expire(late.claimId)).wait();
  await assert.rejects(w.hunter().reveal({ claimDir: late.dir }), (e) => e.code === 'CLAIM_ENDED');
});
