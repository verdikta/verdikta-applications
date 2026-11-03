// Review focus: hashed bytes = pinned bytes. Attacks on the pin target, the gateway and the disk. In each one
// the tool either ends with a chain whose hashes are what is served, or stops before a transaction that
// would commit it to anything else.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readJson, statePath } from './helpers/cli.js';
import { treeCidOf } from './helpers/ipfs.js';
import { REPORT_MARKER, makeClaimDir, makeWorld, sha256 } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => { await w.close(); });
beforeEach(() => { for (const k of Object.keys(w.ipfs.faults)) w.ipfs.faults[k] = false; });

async function committedNotPinned(over = {}) {
  const l = await w.listing(over);
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'commit:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  return { l, dir, claimId: readJson(statePath(dir)).claimId };
}

const pinnedAndDisclosed = async (claimId) => {
  const claim = await w.sa.getClaim(claimId);
  return { disclosed: claim.disclosedAt !== 0n, claim };
};

test('a pin target that answers the CID of other bytes: refused, no disclose', async () => {
  const { dir, claimId } = await committedNotPinned();
  w.ipfs.faults.lieCid = true;
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'PIN_CID_MISMATCH');
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
});

test('a pin target that stores other bytes under the true CID: the read-back catches it, no disclose', async () => {
  const { dir, claimId } = await committedNotPinned();
  w.ipfs.faults.storeOther = true;
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'PIN_READBACK_MISMATCH');
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
  w.ipfs.faults.storeOther = false;
  const r = await w.hunter().commit({ claimDir: dir });
  assert.equal(r.stage, 'disclosed');
  assert.equal(sha256(w.ipfs.store.get(r.ciphertextCid)), (await w.sa.getClaim(claimId)).ciphertextSha256);
});

test('a gateway that serves other bytes: the read-back catches it', async () => {
  const { dir, claimId } = await committedNotPinned();
  w.ipfs.faults.serveOther = true;
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'PIN_READBACK_MISMATCH');
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
});

test('a multi-block CID cannot be recomputed here: it is held to the read-back alone', async () => {
  const { dir, claimId } = await committedNotPinned();
  w.ipfs.faults.treeCid = true;
  const r = await w.hunter().commit({ claimDir: dir });
  const claim = await w.sa.getClaim(claimId);
  assert.equal(claim.ciphertextCid, treeCidOf(fs.readFileSync(statePath(dir, 'ciphertext.age'))));
  assert.equal(r.stage, 'disclosed');
  assert.ok(w.ipfs.reads.includes(claim.ciphertextCid), 'read back');
  const other = await committedNotPinned();
  w.ipfs.faults.storeOther = true;
  await assert.rejects(w.hunter().commit({ claimDir: other.dir }), (e) => e.code === 'PIN_READBACK_MISMATCH');
});

test('the gateway is down: a resumable stop with the time left, then the same flow; an override only for a CID computed here', async () => {
  const { dir, claimId } = await committedNotPinned();
  w.ipfs.faults.gatewayDown = true;
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'PIN_NOT_READABLE' && /before/.test(e.message));
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
  const notices = [];
  const r = await w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, acceptUnreadPin: true });
  assert.equal(r.stage, 'disclosed');
  assert.match(notices.join('\n'), /could not be read back/);
  w.ipfs.faults.gatewayDown = false;
  const tree = await committedNotPinned();
  w.ipfs.faults.gatewayDown = true;
  w.ipfs.faults.treeCid = true;
  await assert.rejects(w.hunter().commit({ claimDir: tree.dir, acceptUnreadPin: true }), (e) => e.code === 'PIN_NOT_READABLE', 'no override when nothing here can recompute the CID');
});

test('the pin target is down: a resumable stop that never quotes it, then the flow finishes', async () => {
  const { dir } = await committedNotPinned();
  w.ipfs.faults.pinDown = true;
  w.ipfs.faults.echo = true;
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'PIN_FAILED' && !/refused:/.test(e.message));
  w.ipfs.faults.pinDown = false;
  assert.equal((await w.hunter().commit({ claimDir: dir })).stage, 'disclosed');
});

test('the ciphertext changed on disk after the commit: refused before any upload, because the chain holds the hash', async () => {
  const { dir, claimId } = await committedNotPinned();
  const uploads = w.ipfs.uploads.length;
  const file = statePath(dir, 'ciphertext.age');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'FILE_CHANGED');
  assert.equal(w.ipfs.uploads.length, uploads);
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
});

test('the state file edited to match other bytes changes nothing: the on-chain hash is the one compared', async () => {
  const { dir, claimId } = await committedNotPinned();
  const uploads = w.ipfs.uploads.length;
  const file = statePath(dir, 'ciphertext.age');
  const bytes = fs.readFileSync(file);
  bytes[0] ^= 1;
  fs.writeFileSync(file, bytes);
  const saved = readJson(statePath(dir));
  saved.ciphertextSha256 = sha256(bytes);
  fs.writeFileSync(statePath(dir), JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(w.hunter().commit({ claimDir: dir }), (e) => e.code === 'FILE_CHANGED' || e.code === 'CLAIM_MISMATCH');
  assert.equal(w.ipfs.uploads.length, uploads);
  assert.equal((await pinnedAndDisclosed(claimId)).disclosed, false);
});

test('before the commit: archive, ciphertext or keys changed on disk are caught before signing', async () => {
  for (const name of ['archive.zip', 'ciphertext.age', 'keys.json']) {
    const l = await w.listing();
    const dir = makeClaimDir();
    await w.hunter({ onStep: (s) => { if (s === 'prepare:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
    const file = statePath(dir, name);
    if (name === 'keys.json') {
      const keys = readJson(file);
      keys.contentKey = `0x${'ab'.repeat(16)}`;
      fs.writeFileSync(file, JSON.stringify(keys));
    } else {
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      fs.writeFileSync(file, bytes);
    }
    const count = await w.claimCount();
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FILE_CHANGED', name);
    assert.equal(await w.claimCount(), count, name);
  }
});

test('reveal: the archive changed on disk: refused before the plaintext is pinned, and no keys are sent', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const uploads = w.ipfs.uploads.length;
  const file = statePath(dir, 'archive.zip');
  const bytes = fs.readFileSync(file);
  bytes[20] ^= 1;
  fs.writeFileSync(file, bytes);
  await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'FILE_CHANGED');
  assert.equal(w.ipfs.uploads.length, uploads);
  assert.equal((await w.sa.getClaim(claimId)).state, 0n);
});

test('reveal: keys that do not reproduce the ciphertext are caught here, not at the arbiters\' gate', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const keys = readJson(statePath(dir, 'keys.json'));
  keys.ephemeralKey = `0x${'cd'.repeat(32)}`;
  fs.writeFileSync(statePath(dir, 'keys.json'), JSON.stringify(keys));
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'FILE_CHANGED');
  assert.equal(w.ipfs.uploads.length, uploads);
  assert.equal((await w.sa.getClaim(claimId)).state, 0n);
});

test('reveal: a lying pin target or gateway for the plaintext: no reveal, no keys on-chain', async () => {
  for (const fault of ['lieCid', 'storeOther', 'serveOther']) {
    const l = await w.listing();
    const dir = makeClaimDir();
    const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    w.ipfs.faults[fault] = true;
    await assert.rejects(w.hunter().reveal({ claimDir: dir }), (e) => e.code === 'PIN_CID_MISMATCH' || e.code === 'PIN_READBACK_MISMATCH', fault);
    w.ipfs.faults[fault] = false;
    assert.equal((await w.sa.getClaim(claimId)).state, 0n, fault);
  }
});

test('reveal: the disclosed ciphertext is no longer served: pinned again from disk first, so arbiters can read it', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId, ciphertextCid } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  w.ipfs.drop(ciphertextCid);
  const r = await w.hunter().reveal({ claimDir: dir });
  assert.equal(r.state, 'Revealed');
  assert.equal(sha256(w.ipfs.store.get(ciphertextCid)), (await w.sa.getClaim(claimId)).ciphertextSha256);
});

test('nothing plain is uploaded by commit, and the plaintext only at reveal', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const start = w.ipfs.uploads.length;
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(w.ipfs.uploads.length, start + 1);
  assert.ok(!w.ipfs.uploads[start].bytes.includes(REPORT_MARKER));
  assert.equal(sha256(w.ipfs.uploads[start].bytes), readJson(statePath(dir)).ciphertextSha256);
  await w.hunter().reveal({ claimDir: dir });
  assert.equal(w.ipfs.uploads.length, start + 2);
  assert.ok(w.ipfs.uploads[start + 1].bytes.includes(REPORT_MARKER));
  assert.equal(sha256(w.ipfs.uploads[start + 1].bytes), readJson(statePath(dir)).archiveSha256);
});
