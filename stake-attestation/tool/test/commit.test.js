// Acceptance 2 and 6: commit (erratum E5) builds the archive, hashes it, draws fresh keys, encrypts to the
// listing archive's key, refusing when the on-chain copy differs, writes keys and ciphertext beside the
// archive (0600), sends commit with bond + the live maxTotalFee, and only after it is mined pins the
// ciphertext and discloses within the window. It refuses a listing the builder did not sign, and prints
// P9's warning and the §8.6 diligence text before any commit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LISTING_WARNING } from '@verdikta/stake-attestation-shared/listing-warning';

import { statePath } from './helpers/cli.js';
import { FINDING, buildArchives, codeReview, makeClaimDir, makeWorld, sha256, specFor, tmpDir } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => { await w.close(); });

const notAClaim = async (dir) => assert.equal(fs.existsSync(path.join(dir, '.verdikta-claim', 'keys.json')), false, 'no keys were drawn');

test('the happy path: everything the chain holds is what the disk holds, and the maker can read it', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const price = await w.sa.commitPrice(l.listingId);
  const before_ = await w.provider.getBalance(w.address);
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  const claim = await w.sa.getClaim(r.claimId);
  assert.equal(claim.hunter, w.hunterWallet.address);
  assert.equal(claim.listingId, l.listingId);
  const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
  const ciphertext = fs.readFileSync(statePath(dir, 'ciphertext.age'));
  assert.equal(claim.archiveHash, sha256(archive));
  assert.equal(claim.ciphertextSha256, sha256(ciphertext));
  assert.equal(claim.ciphertextCid, r.ciphertextCid);
  assert.ok(claim.disclosedAt > 0n);
  assert.equal(claim.bondWei + claim.prepayWei, price, 'exactly bond + the live fee');
  assert.equal(await w.provider.getBalance(w.address) - before_, price);
  assert.equal(r.valueWei, price);
  // the stock tool's view: the disclosed bytes open with the maker's identity and hash to the commitment
  const opened = codeReview.decryptDisclosure(new Uint8Array(w.ipfs.store.get(claim.ciphertextCid)), l.identity);
  assert.equal(sha256(opened), claim.archiveHash);
  const keys = JSON.parse(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'));
  assert.deepEqual(codeReview.verifyDisclosure({ plaintext: new Uint8Array(archive), ciphertext: new Uint8Array(ciphertext), archiveSha256: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, contentKey: keys.contentKey, ephemeralKey: keys.ephemeralKey, disclosureKey: l.params.disclosureKey.replace('0x', '') ? l.recipient : '' }).ok, true);
  for (const f of ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json']) {
    assert.equal(fs.statSync(statePath(dir, f)).mode & 0o777, 0o600, f);
  }
  assert.equal(fs.statSync(path.join(dir, '.verdikta-claim')).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(path.join(dir, '.verdikta-claim', '.gitignore'), 'utf8'), /\*/);
});

test('the archive is the claim contract: manifest, primary, finding, report, patches; common and the EA\'s checks accept it', async () => {
  const { buildClaimArchive } = await import('../src/index.js');
  const { zipDirectory, readZipMember } = await import('@verdikta/stake-attestation-shared/zip-read');
  const report = `# ${'long '.repeat(3000)}`;
  const built = buildClaimArchive({ finding: Buffer.from(JSON.stringify(FINDING)), report: Buffer.from(report), pocPatch: Buffer.from('diff --git a/t b/t\n'), fixPatch: Buffer.from('fix') });
  const entries = zipDirectory(built);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'primary_query.json', 'finding.json', 'report.md', 'poc.patch', 'fix.patch']);
  const primary = JSON.parse(readZipMember(built, entries.get('primary_query.json'), 1e6).toString());
  assert.ok(primary.query.length >= 10 && primary.query.length <= 10000, 'a query the bCID rule takes (common: 10 to 10,000 characters)');
  assert.equal(report.startsWith(primary.query), true, 'the query is the report text');
  assert.equal(readZipMember(built, entries.get('report.md'), 1e6).toString(), report);
  assert.ok(buildClaimArchive({ finding: Buffer.from('{}'), report: Buffer.from(report), pocPatch: Buffer.from('p') }).length > 0);
  assert.ok(built.equals(buildClaimArchive({ finding: Buffer.from(JSON.stringify(FINDING)), report: Buffer.from(report), pocPatch: Buffer.from('diff --git a/t b/t\n'), fixPatch: Buffer.from('fix') })), 'the same claim, the same bytes');
});

test('what would settle INVALID for a broken archive is refused before anything is drawn', async () => {
  const l = await w.listing();
  const cases = [
    [{ finding: 'not json' }, 'FINDING_INVALID'],
    [{ finding: { ...FINDING, affectedPaths: ['lib/x.sol'] } }, 'FINDING_INVALID'],
    [{ report: '   \n' }, 'REPORT_INVALID'],
    [{ report: 'short' }, 'REPORT_INVALID'],
    [{ report: Buffer.from([0xff, 0xfe, 0x00]) }, 'REPORT_INVALID'],
    [{ poc: 'this is prose, not a patch' }, 'POC_INVALID'],
    [{ poc: `diff --git a/t b/t\n${'x'.repeat(2000001)}` }, 'POC_INVALID'],
  ];
  for (const [input, code] of cases) {
    const dir = makeClaimDir(input);
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === code, code);
    await notAClaim(dir);
  }
  const noFile = tmpDir();
  await assert.rejects(w.hunter().commit({ claimDir: noFile, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FINDING_INVALID');
});

test('fresh keys for every commit, never all zero, and two claims of one archive share nothing but its hash', async () => {
  const l = await w.listing();
  const a = makeClaimDir();
  const b = makeClaimDir();
  await w.hunter().commit({ claimDir: a, listingId: l.listingId, acknowledge: true });
  await w.hunter().commit({ claimDir: b, listingId: l.listingId, acknowledge: true });
  const ka = JSON.parse(fs.readFileSync(statePath(a, 'keys.json'), 'utf8'));
  const kb = JSON.parse(fs.readFileSync(statePath(b, 'keys.json'), 'utf8'));
  assert.notEqual(ka.contentKey, kb.contentKey);
  assert.notEqual(ka.ephemeralKey, kb.ephemeralKey);
  assert.equal(fs.readFileSync(statePath(a, 'archive.zip')).equals(fs.readFileSync(statePath(b, 'archive.zip'))), true);
  assert.equal(fs.readFileSync(statePath(a, 'ciphertext.age')).equals(fs.readFileSync(statePath(b, 'ciphertext.age'))), false);
});

test('the warning and the diligence text come before any transaction, and nothing is sent without the acknowledgement', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const notices = [];
  const count = await w.claimCount();
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.equal(await w.claimCount(), count);
  const text = notices.join('\n');
  assert.ok(text.includes(LISTING_WARNING.proofFirst));
  assert.ok(text.includes(LISTING_WARNING.elsewhere));
  for (const needle of [/scope/, /known issues/, /rubric/, /run .?check.? before/i, /prepay is spent whatever the verdict/, /bond is forfeited on INVALID/, /returned on DUPLICATE/, /committed hash/, /fixed version/]) assert.match(text, needle);
  assert.match(text, /date/);
  assert.match(text, /tamper flag/i);
  assert.match(text, /abstain/i);
  assert.match(text, /base fees/);

  const order = [];
  const r = await w.hunter({ onNotice: () => order.push('notice'), onStep: (s) => order.push(s) }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.ok(order.indexOf('notice') < order.indexOf('commit:signed'));
});

test('a listing the builder did not sign is refused: no keys, no transaction, no pin', async () => {
  const other = codeReview.createDevBuilderKey();
  const cases = [
    ['another builder', { signWith: other }, 'NOT_SIGNED_BY_BUILDER'],
    ['archives swapped', { listingBytes: (a) => a.dispute, disputeBytes: (a) => a.listing }, 'ARCHIVE_MISMATCH'],
    ['not a zip', { listingBytes: () => Buffer.from('nothing like a zip file at all, not one bit of it') }, 'ARCHIVE_INVALID'],
    ['repackaged around another panel', { listingBytes: (a, spec) => {
      const again = buildArchives(spec, w.builderKey);
      return Buffer.concat([again.listing, Buffer.from('trailing')]);
    } }, 'ARCHIVE_INVALID'],
    ['a dispute archive of other signed files', { disputeBytes: (a, spec) => buildArchives({ ...spec, limits: { ...spec.limits, buildSeconds: 14 } }, w.builderKey).dispute }, 'ARCHIVE_MISMATCH'],
  ];
  for (const [name, over, code] of cases) {
    const l = await w.listing(over);
    const dir = makeClaimDir();
    const count = await w.claimCount();
    const uploads = w.ipfs.uploads.length;
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === code, name);
    assert.equal(await w.claimCount(), count, name);
    assert.equal(w.ipfs.uploads.length, uploads, name);
    await notAClaim(dir);
  }
});

test('dev keys count only on a testnet chain and only when given', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await assert.rejects(w.hunter({ devKeys: null }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'NOT_SIGNED_BY_BUILDER');
  await notAClaim(dir);
});

test('the on-chain disclosure key differs from the archive\'s: refused, nothing encrypted to it (Q36)', async () => {
  const replay = codeReview.generateDisclosureKeyPair();
  const key = `0x${Buffer.from(codeReview.parseDisclosureKey(replay.recipient)).toString('hex')}`;
  const l = await w.listing({ paramsOver: { disclosureKey: key } });
  const dir = makeClaimDir();
  const uploads = w.ipfs.uploads.length;
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'ARCHIVE_MISMATCH');
  assert.equal(w.ipfs.uploads.length, uploads);
  await notAClaim(dir);
});

test('on-chain terms other than the signed ones are refused too: another bond, award or window', async () => {
  for (const paramsOver of [{ bondWei: 1n }, { revealWindow: 90 * 86400 }, { awards: [0n, 1n, 2n, 3n] }, { artifact: { kind: 0, repo: 'https://github.com/other/vault', baseCommit: 'a'.repeat(40), chainId: 0n, addr: '0x0000000000000000000000000000000000000000' } }]) {
    const l = await w.listing({ paramsOver });
    const dir = makeClaimDir();
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'ARCHIVE_MISMATCH', Object.keys(paramsOver)[0]);
    await notAClaim(dir);
  }
});

test('a listing that takes no commits, or does not allow this hunter, is refused with the contract\'s reason', async () => {
  const unfunded = await w.listing({ fund: false });
  await assert.rejects(w.hunter().commit({ claimDir: makeClaimDir(), listingId: unfunded.listingId, acknowledge: true }), (e) => e.code === 'LISTING_NOT_ACCEPTING');
  const invited = await w.listing({ allowlist: [w.signers[7].address] });
  await assert.rejects(w.hunter().commit({ claimDir: makeClaimDir(), listingId: invited.listingId, acknowledge: true }), (e) => e.code === 'NOT_ALLOWED');
  await assert.rejects(w.hunter().commit({ claimDir: makeClaimDir(), listingId: 99999n, acknowledge: true }), (e) => e.code === 'LISTING_NOT_FOUND');
});

test('keys and ciphertext are on disk at 0600 at the moment the commit is broadcast, and no pin has happened', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const seen = [];
  const uploads = w.ipfs.uploads.length;
  const onStep = (step) => {
    if (step !== 'commit:signed') return;
    for (const f of ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json']) {
      const st = fs.statSync(statePath(dir, f));
      seen.push([f, st.mode & 0o777]);
    }
    const saved = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    assert.match(saved.commitTx.raw, /^0x/, 'the signed transaction is saved before it is broadcast');
    assert.equal(w.ipfs.uploads.length, uploads);
  };
  await w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.deepEqual(seen, [['archive.zip', 0o600], ['keys.json', 0o600], ['ciphertext.age', 0o600], ['state.json', 0o600]]);
});

test('umask 0 still writes 0600', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const old = process.umask(0);
  try {
    await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  } finally {
    process.umask(old);
  }
  assert.equal(fs.statSync(statePath(dir, 'keys.json')).mode & 0o777, 0o600);
});

test('a key file with wider modes on resume is a refusal, not a silent chmod; a symlink too', async () => {
  const l = await w.listing();
  for (const attack of ['chmod', 'symlink']) {
    const dir = makeClaimDir();
    const onStep = (step) => {
      if (step === 'prepare:saved') throw new Error('crash');
    };
    await w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
    const file = statePath(dir, 'keys.json');
    if (attack === 'chmod') {
      fs.chmodSync(file, 0o644);
    } else {
      const copy = `${file}.elsewhere`;
      fs.renameSync(file, copy);
      fs.symlinkSync(copy, file);
    }
    const count = await w.claimCount();
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FILE_NOT_PRIVATE', attack);
    assert.equal(await w.claimCount(), count, attack);
  }
});

test('the state folder itself must be private: a wider folder, or a link, is refused', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  fs.mkdirSync(path.join(dir, '.verdikta-claim'), { mode: 0o755 });
  fs.chmodSync(path.join(dir, '.verdikta-claim'), 0o755);
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FILE_NOT_PRIVATE');
  const other = makeClaimDir();
  fs.symlinkSync(tmpDir(), path.join(other, '.verdikta-claim'));
  await assert.rejects(w.hunter().commit({ claimDir: other, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FILE_NOT_PRIVATE');
});

test('the live fee: a rise before the read is paid, and the prepay goes up with it', async () => {
  const l = await w.listing();
  await (await w.aggregator.setFeeMultiplier(5n)).wait();
  try {
    const dir = makeClaimDir();
    const price = await w.sa.commitPrice(l.listingId);
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    const claim = await w.sa.getClaim(r.claimId);
    assert.equal(claim.bondWei + claim.prepayWei, price);
    assert.equal(claim.prepayWei, 5n * 120000000000000n);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('a fee that rises after the read: the commit reverts, nothing is pinned, a re-run prices again', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const uploads = w.ipfs.uploads.length;
  const count = await w.claimCount();
  const onStep = async (step) => {
    if (step === 'commit:signed') await (await w.aggregator.setFeeMultiplier(6n)).wait();
  };
  try {
    await assert.rejects(w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'COMMIT_REVERTED' && /payment below bond/.test(e.message));
    assert.equal(w.ipfs.uploads.length, uploads);
    assert.equal(await w.claimCount(), count);
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(await w.claimCount(), count + 1n);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('a maker who closes first (a pending commit front-run): the commit reverts and the ciphertext is never published', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const uploads = w.ipfs.uploads.length;
  const onStep = async (step) => {
    if (step === 'commit:signed') await (await w.sa.connect(w.maker).close(l.listingId)).wait();
  };
  await assert.rejects(w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'COMMIT_REVERTED' && /not accepting commits/.test(e.message));
  assert.equal(w.ipfs.uploads.length, uploads, 'the maker learns nothing');
});

test('roll forward between commit and disclose: the claim still discloses and gets a fix window of its own', async () => {
  const l = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const successor = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const dir = makeClaimDir();
  const onStep = async (step) => {
    if (step === 'commit:saved') await (await w.sa.connect(w.maker).rollForward(l.listingId, successor.listingId)).wait();
  };
  const r = await w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const claim = await w.sa.getClaim(r.claimId);
  assert.equal(claim.disclosedAfterRoll, true);
  assert.equal(claim.fixWindowEnd - claim.disclosedAt, 14n * 86400n);
});

test('the hour runs out: no pin, because publishing would buy nothing; the tool says who can expire it and what happens', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'commit:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const uploads = w.ipfs.uploads.length;
  await w.increase(await w.sa.DISCLOSE_WINDOW());
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId }), (e) => e.code === 'DISCLOSE_WINDOW_OVER' && /bond/.test(e.message) && /prepay/.test(e.message));
  assert.equal(w.ipfs.uploads.length, uploads);
});

test('the last second of the hour still discloses, on the chain\'s clock and not the laptop\'s', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'commit:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const saved = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  const claim = await w.sa.getClaim(saved.claimId);
  await w.rpc('evm_setNextBlockTimestamp', [Number(claim.committedAt) + 3598]);
  await w.mine();
  const r = await w.hunter({ now: () => 0 }).commit({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
});

test('a wallet that cannot pay for commit and disclose is refused before signing', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { ethers } = await import('ethers');
  const poor = ethers.Wallet.createRandom().connect(w.provider);
  await (await w.signers[8].sendTransaction({ to: poor.address, value: await w.sa.commitPrice(l.listingId) })).wait();
  const count = await w.claimCount();
  await assert.rejects(w.hunter({ signer: poor }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'INSUFFICIENT_FUNDS');
  assert.equal(await w.claimCount(), count);
});

test('a claim folder is bound to its wallet, listing, chain and contract', async () => {
  const l = await w.listing();
  const other = await w.listing();
  const dir = makeClaimDir();
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: other.listingId, acknowledge: true }), (e) => e.code === 'STATE_MISMATCH');
  const { ethers } = await import('ethers');
  await assert.rejects(w.hunter({ signer: new ethers.Wallet(w.keyOf(7), w.provider) }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'STATE_MISMATCH');
  await assert.rejects(w.hunter({ contract: w.signers[9].address }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'STATE_MISMATCH' || e.code === 'NOT_THE_CONTRACT');
});

test('inputs changed after a prepared commit: refused unless --restart, and --restart only before any signature', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'prepare:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const firstKeys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  fs.appendFileSync(path.join(dir, 'report.md'), 'one more line\n');
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'INPUTS_CHANGED');
  assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), firstKeys, 'the keys are not redrawn');
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true, restart: true });
  assert.equal(r.stage, 'disclosed');
  assert.notEqual(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), firstKeys);
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true, restart: true }), (e) => e.code === 'RESTART_REFUSED');
  assert.ok(fs.existsSync(statePath(dir, 'keys.json')), 'the keys of a sent commit are never removed');
});

test('a second run after success changes nothing', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const first = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const count = await w.claimCount();
  const uploads = w.ipfs.uploads.length;
  const again = await w.hunter().commit({ claimDir: dir, listingId: l.listingId });
  assert.equal(again.claimId, first.claimId);
  assert.equal(await w.claimCount(), count);
  assert.equal(w.ipfs.uploads.length, uploads);
});

test('two runs on one folder at once: the second is refused by the lock, and a dead holder\'s lock does not block a resume', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  fs.mkdirSync(path.join(dir, '.verdikta-claim'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.verdikta-claim', 'lock'), String(process.ppid), { mode: 0o600 });
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'FOLDER_BUSY');
  fs.writeFileSync(path.join(dir, '.verdikta-claim', 'lock'), '999999', { mode: 0o600 });
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(fs.existsSync(path.join(dir, '.verdikta-claim', 'lock')), false);
});

test('specFor is what common accepts', () => {
  assert.equal(codeReview.validateCodeReviewSpec(specFor({ baseCommit: 'a'.repeat(40), recipient: codeReview.generateDisclosureKeyPair().recipient })).ok, true);
});
