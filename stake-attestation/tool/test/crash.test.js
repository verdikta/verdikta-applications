// Review focus: crash the commit flow at every step and resume it. Each run is a real process killed with
// SIGKILL at the named step (no finally runs, nothing is flushed but what the tool already fsynced), then
// resumed by a new process. After every resume there must be exactly one claim, one bond paid, the ciphertext
// disclosed, no plaintext published, the keys the ciphertext was made with, and all of it consistent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COMMIT_STEPS, REVEAL_STEPS } from '../src/index.js';
import { closeRpc, readJson, rpcOf, runCli, statePath } from './helpers/cli.js';
import { POC_MARKER, REPORT_MARKER, codeReview, makeClaimDir, makeWorld, sha256 } from './helpers/world.js';

const CHILD = fileURLToPath(new URL('./helpers/crashChild.js', import.meta.url));

let w;
let rpc;
before(async () => {
  w = await makeWorld();
  rpc = await rpcOf(w);
});
after(async () => {
  await closeRpc(w);
  await w.close();
});

function child(verb, dir, listingId, step) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        CRASH_VERB: verb,
        CRASH_STEP: step ?? '',
        CRASH_DIR: dir,
        CRASH_LISTING: String(listingId),
        CRASH_RPC: rpc.url,
        CRASH_CONTRACT: w.address,
        CRASH_GATEWAY: w.ipfs.url,
        CRASH_DEV_KEY: w.builderKey.publicKey,
        VERDIKTA_WALLET_KEY: w.hunterKey,
      },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

async function assertOneClaim(dir, l, countBefore, escrowBefore, price) {
  assert.equal(await w.claimCount(), countBefore + 1n, 'exactly one claim');
  assert.equal(await w.provider.getBalance(w.address), escrowBefore + price, 'one bond and one prepay paid');
  const saved = readJson(statePath(dir));
  const claim = await w.sa.getClaim(saved.claimId);
  const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
  const ciphertext = fs.readFileSync(statePath(dir, 'ciphertext.age'));
  const keys = readJson(statePath(dir, 'keys.json'));
  assert.equal(claim.archiveHash, sha256(archive));
  assert.equal(claim.ciphertextSha256, sha256(ciphertext));
  assert.notEqual(claim.ciphertextCid, '');
  assert.ok(w.ipfs.store.get(claim.ciphertextCid).equals(ciphertext), 'the pinned bytes are the hashed bytes');
  assert.equal(codeReview.verifyDisclosure({ plaintext: new Uint8Array(archive), ciphertext: new Uint8Array(ciphertext), archiveSha256: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, contentKey: keys.contentKey, ephemeralKey: keys.ephemeralKey, disclosureKey: l.recipient }).ok, true, 'the keys on disk are the ones the ciphertext was made with');
  return { saved, claim, archive, ciphertext, keys };
}

function assertNoPlaintextPublished(from) {
  for (const u of w.ipfs.uploads.slice(from)) {
    assert.ok(!u.bytes.includes(REPORT_MARKER) && !u.bytes.includes(POC_MARKER), 'no plaintext left the machine');
  }
}

test('every commit step is on the list, in order, in a clean run', async () => {
  const l = await w.listing();
  const seen = [];
  await w.hunter({ onStep: (s) => seen.push(s) }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true });
  assert.deepEqual(seen, [...COMMIT_STEPS]);
});

for (const step of COMMIT_STEPS) {
  test(`commit killed at ${step}, then resumed: one claim, one bond, disclosed, nothing plain published`, async () => {
    const l = await w.listing();
    const dir = makeClaimDir();
    const countBefore = await w.claimCount();
    const escrowBefore = await w.provider.getBalance(w.address);
    const price = await w.sa.commitPrice(l.listingId);
    const uploadsBefore = w.ipfs.uploads.length;
    const killed = await child('commit', dir, l.listingId, step);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    const keysAtCrash = fs.existsSync(statePath(dir, 'state.json')) && fs.existsSync(statePath(dir, 'keys.json')) ? fs.readFileSync(statePath(dir, 'keys.json'), 'utf8') : null;

    const resumed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    await assertOneClaim(dir, l, countBefore, escrowBefore, price);
    assertNoPlaintextPublished(uploadsBefore);
    if (keysAtCrash !== null) assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keysAtCrash, 'the same keys');

    // and a third run is a no-op
    const again = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(await w.claimCount(), countBefore + 1n);
  });
}

test('a torn write: a leftover temp file and no state file are ignored, nothing sent, and a fresh draw follows', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const killed = await child('commit', dir, l.listingId, 'prepare:keys');
  assert.equal(killed.signal, 'SIGKILL');
  fs.writeFileSync(statePath(dir, 'keys.json.tmp-123'), 'half a key', { mode: 0o600 });
  const count = await w.claimCount();
  const resumed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(await w.claimCount(), count + 1n);
  assert.equal(fs.existsSync(statePath(dir, 'keys.json.tmp-123')), false);
});

test('a pending commit on resume: the same bytes again, never a second transaction', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  await w.rpc('evm_setAutomine', [false]);
  try {
    const stop = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(stop.code, 'TX_PENDING');
    const first = readJson(statePath(dir)).commitTx.hash;
    const stop2 = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(stop2.code, 'TX_PENDING');
    assert.equal(readJson(statePath(dir)).commitTx.hash, first);
    const pending = await w.rpc('eth_getBlockByNumber', ['pending', false]);
    assert.equal(pending.transactions.length, 1, 'one transaction waits');
    await w.mine();
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(await w.claimCount(), count + 1n);
});

test('the saved transaction\'s nonce was used by something else and no claim exists: sign again, once', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  const killed = await child('commit', dir, l.listingId, 'commit:signed');
  assert.equal(killed.signal, 'SIGKILL');
  await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(await w.claimCount(), count + 1n);
});

test('the same commit went out another way (a sped-up copy from the wallet): adopt that claim, never pay twice', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  const killed = await child('commit', dir, l.listingId, 'commit:signed');
  assert.equal(killed.signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const price = await w.sa.commitPrice(l.listingId);
  await (await w.sa.connect(w.hunterWallet).commit(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price, gasPrice: 10n ** 10n })).wait();
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(await w.claimCount(), count + 1n, 'one claim, the one that exists');
  assert.equal(r.claimId, count + 1n);
});

test('an adopted claim must be as deep as one of ours before the ciphertext is pinned', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const killed = await child('commit', dir, l.listingId, 'prepare:saved');
  assert.equal(killed.signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  await (await w.sa.connect(w.hunterWallet).commit(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  const uploads = w.ipfs.uploads.length;
  let waits = 0;
  const r = await w.hunter({ confirmations: 3, sleep: async () => { waits += 1; assert.equal(w.ipfs.uploads.length, uploads); await w.mine(); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.ok(waits >= 2);
});

test('an RPC that lags behind its own receipt does not make a second commit', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  const lag = { hide: false, calls: 0 };
  const laggy = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'getTransactionReceipt') {
        return async (h) => {
          if (lag.hide && lag.calls < 3) {
            lag.calls += 1;
            return null;
          }
          return target.getTransactionReceipt(h);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const killed = await child('commit', dir, l.listingId, 'commit:sent');
  assert.equal(killed.signal, 'SIGKILL');
  lag.hide = true;
  const r = await w.hunter({ provider: laggy, receiptGraceMs: 2000 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(await w.claimCount(), count + 1n);
});

test('a state file someone removed after a sent commit: the keys that commit needs are set aside, never overwritten', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const keys = fs.readFileSync(statePath(dir, 'keys.json'));
  fs.rmSync(statePath(dir));
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const kept = fs.readdirSync(`${dir}/.verdikta-claim`).filter((n) => n.startsWith('keys.json.set-aside-'));
  assert.equal(kept.length, 1);
  assert.ok(fs.readFileSync(statePath(dir, kept[0])).equals(keys));
  assert.equal(fs.statSync(statePath(dir, kept[0])).mode & 0o777, 0o600);
});

test('a state file in pieces is a refusal, not a fresh start that would draw new keys over a sent commit', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  fs.writeFileSync(statePath(dir), '{"version":1,', { mode: 0o600 });
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'STATE_INVALID');
  assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys);
});

test('every reveal step is on the list, in order, in a clean run', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const seen = [];
  await w.hunter({ onStep: (s) => seen.push(s) }).reveal({ claimDir: dir });
  assert.deepEqual(seen, [...REVEAL_STEPS]);
});

for (const step of REVEAL_STEPS) {
  test(`reveal killed at ${step}, then resumed: revealed once, with the keys, the on-chain hash the plaintext's`, async () => {
    const l = await w.listing();
    const dir = makeClaimDir();
    const r0 = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    const killed = await child('reveal', dir, l.listingId, step);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    const resumed = await runCli(w, ['reveal', dir]);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    const claim = await w.sa.getClaim(r0.claimId);
    const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
    assert.equal(claim.state, 2n, 'Revealed');
    assert.ok(w.ipfs.store.get(claim.bcid).equals(archive));
    assert.equal(sha256(w.ipfs.store.get(claim.bcid)), claim.archiveHash);
    const keys = readJson(statePath(dir, 'keys.json'));
    assert.equal(claim.contentKey, keys.contentKey);
    assert.equal(claim.ephemeralKey, keys.ephemeralKey);
    const again = await runCli(w, ['reveal', dir]);
    assert.equal(again.code, 0, again.stderr);
  });
}
