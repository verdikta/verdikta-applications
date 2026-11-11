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
  // A claim round's INVALID waits out its appeal window unless its hunter settles it, which
  // waives the appeal (erratum E7, node P16): the hunter does, so the clock is as before.
  await (await w.sa.connect(w.hunterWallet).settle(a.claimId)).wait();
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
  const r = await w.hunter().reveal({ claimDir: dir, retrigger: true, acknowledge: true });
  assert.equal(r.state, 'Revealed');
  assert.notEqual((await w.sa.getClaim(claimId)).requestId, `0x${'00'.repeat(32)}`);
  // what it answers is the transaction it sent, not the first reveal's (found by the local round, P7)
  assert.notEqual(r.tx, refused.tx);
  assert.equal(w.sa.interface.parseTransaction(await w.provider.getTransaction(r.tx)).name, 'retrigger');
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

// Node P19: reveal --retrigger pays a fresh round's prepay (the lens's retriggerTopUp), so, as commit and appeal, it
// prints what it costs and sends nothing without --yes (the library: `acknowledge`).
const failedRound = async () => {
  const { dir, claimId } = await committed();
  await w.hunter().reveal({ claimDir: dir });
  await w.increase(await w.aggregator.responseTimeoutSeconds() + 1n);
  await (await w.sa.finalize(claimId)).wait();
  assert.equal(await w.sa.claimState(claimId), ROUND_FAILED);
  return { dir, claimId };
};
const ROUND_FAILED = 7n; // the lens's claimState
const nonceOf = () => w.provider.getTransactionCount(w.hunterWallet.address, 'latest');

test('reveal --retrigger prints the top-up it sends and sends nothing without --yes, as commit and appeal', async () => {
  const { dir, claimId } = await failedRound();
  const topUp = await w.sa.retriggerTopUp(claimId);
  assert.ok(topUp > 0n, 'a round that ran spent its prepay: a fresh one in full');
  const notices = [];
  const nonce = await nonceOf();
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).reveal({ claimDir: dir, retrigger: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT' && e.exitCode === 3);
  const text = notices.join('\n');
  assert.ok(text.includes(`${w.hre.ethers.formatEther(topUp)} ETH`), 'the cost, in ETH');
  assert.match(text, /Re-trigger claim/);
  assert.match(text, /base fees/, 'what a round that fails again costs');
  assert.match(text, new RegExp(String(await w.sa.retriggerDeadline(claimId))), 'until when');
  assert.equal(await nonceOf(), nonce, 'nothing sent');
  assert.equal(await w.sa.claimState(claimId), ROUND_FAILED);
  assert.equal(readJson(statePath(dir)).retriggerTx ?? null, null, 'nothing signed');

  const cli = await runCli(w, ['reveal', dir, '--retrigger']);
  assert.equal(cli.code, 3, cli.stderr);
  assert.ok(cli.stdout.includes(`${w.hre.ethers.formatEther(topUp)} ETH`));
  assert.match(cli.stderr, /--yes/);
  assert.equal(await nonceOf(), nonce);
  assert.equal(await w.sa.claimState(claimId), ROUND_FAILED);

  const yes = await runCli(w, ['reveal', dir, '--retrigger', '--yes', '--json']);
  assert.equal(yes.code, 0, yes.stderr);
  const r = JSON.parse(yes.stdout);
  assert.equal(r.state, 'Revealed');
  const tx = await w.provider.getTransaction(r.tx);
  assert.equal(w.sa.interface.parseTransaction(tx).name, 'retrigger');
  assert.equal(tx.value, topUp, 'the amount printed is the amount sent');
});

test('a re-trigger signed by a run that stopped before sending it asks for --yes again; bytes the node holds are only waited for', async () => {
  const { dir, claimId } = await failedRound();
  const topUp = await w.sa.retriggerTopUp(claimId);
  const nonce = await w.provider.getTransactionCount(w.hunterWallet.address, 'pending');
  const fee = await w.provider.getFeeData();
  const raw = await w.hunterWallet.signTransaction({
    type: 2, chainId: 31337n, nonce, to: w.address, data: w.sa.interface.encodeFunctionData('retrigger', [claimId]), value: topUp, gasLimit: 12_000_000n,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
  });
  const rec = { hash: w.hre.ethers.Transaction.from(raw).hash, raw, nonce, from: w.hunterWallet.address, value: topUp.toString(), gasLimit: '12000000' };
  const file = statePath(dir);
  fs.writeFileSync(file, `${JSON.stringify({ ...readJson(file), retriggerTx: rec }, null, 2)}\n`, { mode: 0o600 });

  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).reveal({ claimDir: dir, retrigger: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.ok(notices.join('\n').includes(`${w.hre.ethers.formatEther(topUp)} ETH`));
  assert.equal(await w.provider.getTransaction(rec.hash), null, 'not sent');
  assert.equal(readJson(file).retriggerTx.hash, rec.hash, 'kept');

  // once the node holds them, nothing more is sent by this run, so nothing needs --yes
  await w.rpc('evm_setAutomine', [false]);
  try {
    await w.provider.broadcastTransaction(rec.raw);
    const waiting = w.hunter().reveal({ claimDir: dir, retrigger: true });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    await w.rpc('evm_mine', []);
    const r = await waiting;
    assert.equal(r.tx, rec.hash, 'the saved bytes, not a second call');
    assert.equal(r.state, 'Revealed');
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
});

test('reveal --retrigger needs somewhere to say its cost', async () => {
  const { dir } = await failedRound();
  await assert.rejects(w.hunter({ onNotice: undefined }).reveal({ claimDir: dir, retrigger: true, acknowledge: true }), (e) => e.code === 'USAGE');
});
