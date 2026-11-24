// Node P43 (issue #230): a late claim from the hunter's tool, `verdikta-attest commit <claim-dir> --listing <id> --late`
// (design §13.2, decision D6). The contract takes one on a listing whose stake has ended (Rolled, or Closed after it
// opened) or that its maker holds (node P39): commit-shaped, judged, recorded under the record's `later`, no award.
//
//   - it calls lateClaim with the archive commitments an ordinary commit sends, then pins and discloses as one does;
//   - without --yes it sends nothing, and says the terms, the price and its three warnings;
//   - the wrong kind for the listing is refused before anything is pinned or sent, either way round;
//   - status, reveal, claim and appeal work on it, and status says it is a late claim with no award;
//   - a stopped run resumed never pays twice, at every step;
//   - against a contract with no hold it works where it works on chain today.
//
// An ordinary commit sends what it sent before: the same call, the same value, the same state file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

import { LISTING_WARNING } from '@verdikta/stake-attestation-shared/listing-warning';
import { wordingProblems } from '@verdikta/stake-attestation-shared';

import { STAKE_ATTESTATION_ABI } from '../src/abi.js';
import { run } from '../src/cli.js';
import { COMMIT_STEPS, ERROR_TEXTS, KNOWN_REVERTS, USAGE, buildClaimArchive, commitNotice, readClaimInputs } from '../src/index.js';
import { appealNotice } from '../src/notices.js';
import { closeRpc, readJson, rpcOf, runCli, statePath } from './helpers/cli.js';
import { JUSTIFICATION_CID, codeReview, makeClaimDir, makeWorld, sha256, vectorOf } from './helpers/world.js';

const CHILD = fileURLToPath(new URL('./helpers/crashChild.js', import.meta.url));
const iface = new ethers.Interface(STAKE_ATTESTATION_ABI);
const eth = (wei) => `${ethers.formatEther(wei)} ETH`;
const LONG = { stake: { fixWindowDays: 14, disclosureGraceHours: 48 } };

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

const asMaker = () => w.sa.connect(w.maker);

/** A listing that opened and then rolled forward to a fresh one of the same maker. */
async function rolled(over = {}) {
  const l = await w.listing(over);
  const successor = await w.listing();
  await (await asMaker().rollForward(l.listingId, successor.listingId)).wait();
  return { ...l, successor: successor.listingId };
}

/** A listing that opened and was then closed, with nothing pending. */
async function closed(over = {}) {
  const l = await w.listing(over);
  await (await asMaker().close(l.listingId)).wait();
  return l;
}

/** A listing its maker holds (node P39): Open still, no commit taken any more. */
async function held(over = {}) {
  const l = await w.listing(over);
  await (await asMaker().hold(l.listingId)).wait();
  return l;
}

/** What a refusal must leave as it was: the claims, the pin target, the wallet's nonce. */
async function mark() {
  return { claims: await w.claimCount(), uploads: w.ipfs.uploads.length, nonce: await w.provider.getTransactionCount(w.hunterWallet.address) };
}

async function assertNothingSent(m, dir, label = '') {
  assert.equal(await w.claimCount(), m.claims, `${label}: no claim was made`);
  assert.equal(w.ipfs.uploads.length, m.uploads, `${label}: nothing was pinned`);
  assert.equal(await w.provider.getTransactionCount(w.hunterWallet.address), m.nonce, `${label}: no transaction was sent`);
  if (dir) assert.equal(fs.existsSync(statePath(dir, 'keys.json')), false, `${label}: no keys were drawn`);
}

const eventsOf = async (hash) => (await w.provider.getTransactionReceipt(hash)).logs.map((x) => iface.parseLog(x)?.name);
/** A late claim sent in full: `commit --late --yes`. */
const late = (o) => w.hunter().commit({ late: true, acknowledge: true, ...o });

// ------------------------------------------------------------------------------------------ the late commit's calls

test('commit --late calls lateClaim with the archive commitments an ordinary commit sends, then pins and discloses as one does', async () => {
  const l = await rolled();
  const open = await w.listing();
  const dir = makeClaimDir();
  const twin = makeClaimDir(); // the same claim files, committed the ordinary way
  const price = await w.sa.commitPrice(l.listingId);
  const uploads = w.ipfs.uploads.length;
  const steps = [];
  let uploadsWhenMined = null;
  const onStep = (s) => {
    steps.push(s);
    if (s === 'commit:mined') uploadsWhenMined = w.ipfs.uploads.length;
  };
  const r = await w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.deepEqual(steps, [...COMMIT_STEPS], 'the steps of a commit, in a commit\'s order');
  assert.equal(uploadsWhenMined, uploads, 'nothing is pinned before the late claim is mined');

  // the call: lateClaim(listingId, archiveHash, ciphertextSha256), carrying commitPrice
  const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
  const ciphertext = fs.readFileSync(statePath(dir, 'ciphertext.age'));
  const tx = await w.provider.getTransaction(r.commitTx);
  assert.equal(tx.to, w.address);
  assert.equal(tx.data, iface.encodeFunctionData('lateClaim', [l.listingId, sha256(archive), sha256(ciphertext)]));
  assert.equal(tx.value, price, 'what commitPrice quotes, as for a commit');
  assert.deepEqual(await eventsOf(r.commitTx), ['LateClaim']);

  // the claim it made
  const claim = await w.sa.getClaim(r.claimId);
  assert.equal(claim.late, true);
  assert.equal(claim.hunter, w.hunterWallet.address);
  assert.equal(claim.listingId, l.listingId);
  assert.equal(claim.archiveHash, sha256(archive));
  assert.equal(claim.ciphertextSha256, sha256(ciphertext));
  assert.equal(claim.bondWei + claim.prepayWei, price);
  assert.equal(r.valueWei, price);

  // the archive is an ordinary commit's: the same files give the same bytes and the same commitment
  const o = await w.hunter().commit({ claimDir: twin, listingId: open.listingId, acknowledge: true });
  assert.ok(archive.equals(fs.readFileSync(statePath(twin, 'archive.zip'))), 'the same archive bytes as an ordinary commit of these files');
  assert.equal((await w.sa.getClaim(o.claimId)).archiveHash, claim.archiveHash);
  assert.ok(archive.equals(buildClaimArchive(readClaimInputs(dir))));

  // pinned and disclosed as an ordinary commit is: the ciphertext at the pin target, its CID on the chain, the maker reads it
  assert.ok(claim.disclosedAt > 0n);
  assert.equal(claim.ciphertextCid, r.ciphertextCid);
  assert.ok(w.ipfs.store.get(claim.ciphertextCid).equals(ciphertext), 'the pinned bytes are the hashed bytes');
  assert.equal(sha256(codeReview.decryptDisclosure(new Uint8Array(w.ipfs.store.get(claim.ciphertextCid)), l.identity)), claim.archiveHash);
  const disclose = await w.provider.getTransaction(r.discloseTx);
  assert.equal(disclose.data, iface.encodeFunctionData('disclose', [r.claimId, claim.ciphertextCid]));
  for (const f of ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json']) assert.equal(fs.statSync(statePath(dir, f)).mode & 0o777, 0o600, f);

  // recorded under `later`: never one of the stake's own claims, never pending
  const on = await w.sa.getListing(l.listingId);
  assert.equal(on.lateClaims, 1n);
  assert.equal(on.claimsCommitted, 0n);
  assert.equal(on.pendingClaims, 0n);
  assert.equal(readJson(statePath(dir)).late, true, 'the folder says what kind of claim it holds');
});

test('an ordinary commit sends what it sent before: commit(listingId, archiveHash, ciphertextSha256) with commitPrice, and its folder names no kind', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const price = await w.sa.commitPrice(l.listingId);
  const notices = [];
  const r = await w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const tx = await w.provider.getTransaction(r.commitTx);
  assert.equal(tx.data, iface.encodeFunctionData('commit', [l.listingId, sha256(fs.readFileSync(statePath(dir, 'archive.zip'))), sha256(fs.readFileSync(statePath(dir, 'ciphertext.age')))]));
  assert.equal(tx.value, price);
  assert.equal(tx.to, w.address);
  assert.deepEqual(await eventsOf(r.commitTx), ['Committed']);
  assert.equal(r.late, false);
  assert.equal((await w.sa.getClaim(r.claimId)).late, false);
  // state.json is an ordinary commit's, key for key
  assert.deepEqual(Object.keys(readJson(statePath(dir))), ['version', 'stage', 'chainId', 'contract', 'hunter', 'listingId', 'archiveSha256', 'ciphertextSha256', 'disclosureKey', 'startBlock', 'commitTx', 'claimId', 'ciphertextCid', 'discloseTx', 'told']);
  // and what it says before it pays names no late claim
  const text = notices.join('\n');
  assert.match(text, /^Awards: /m);
  assert.match(text, /^This commit sends /m);
  assert.doesNotMatch(text, /late claim/i);
});

// ------------------------------------------------------------------------------------------------ without --yes

test('commit --late without --yes sends nothing: the terms, the price, no award, the bond forfeited on INVALID, the prepay spent on the evaluation', async () => {
  const l = await rolled(LONG);
  const dir = makeClaimDir();
  const m = await mark();
  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT' && e.exitCode === 3);
  await assertNothingSent(m, dir, 'the library');
  const text = notices.join('\n');
  const price = await w.sa.commitPrice(l.listingId);
  const on = await w.sa.getListing(l.listingId);

  // the price, as the contract quotes it now
  assert.ok(text.includes(`This late claim sends ${eth(price)}: the bond ${eth(on.bondWei)} and the prepay ${eth(price - on.bondWei)}, the live maximum fee.`), text);
  // the three warnings, said plainly
  assert.match(text, /A late claim pays no award/);
  assert.match(text, /The bond is forfeited on INVALID/);
  assert.match(text, /The prepay is spent on the evaluation/);
  // the terms: who reads the proof first, the listing, its windows, where the claim stands in commit order
  assert.ok(text.includes(LISTING_WARNING.proofFirst));
  assert.ok(text.includes(LISTING_WARNING.elsewhere));
  assert.match(text, new RegExp(`Listing ${l.listingId}\\b[^\\n]*Rolled`));
  assert.ok(text.includes(l.spec.repo) && text.includes(l.spec.baseCommit));
  assert.ok(text.includes(`The fix window is ${on.fixWindow} s from your disclosure, the reveal window ${on.revealWindow} s, the dispute window ${on.disputeWindow} s.`));
  assert.match(text, /No other claim on this listing is open now, so a late claim sent now would be first in commit order\./);
  assert.match(text, /Disclosure key: age1/);
  assert.match(text, /Read the scope, the known issues and the rubric before working\./);
  assert.match(text, /Run check before committing/);
  // and nothing an ordinary commit says of an award
  assert.doesNotMatch(text, /^Awards: /m);
  assert.doesNotMatch(text, /The award is for the committed hash/);
  assert.doesNotMatch(text, /^This commit sends /m);

  // the CLI: the same on stdout, exit 3, and still nothing sent
  const dry = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late']);
  assert.equal(dry.code, 3, dry.stderr);
  assert.match(dry.stdout, /A late claim pays no award/);
  assert.match(dry.stdout, /The bond is forfeited on INVALID/);
  assert.match(dry.stdout, /The prepay is spent on the evaluation/);
  assert.ok(dry.stdout.includes(`This late claim sends ${eth(price)}`));
  assert.match(dry.stderr, /^verdikta-attest: NEEDS_ACKNOWLEDGEMENT: /);
  await assertNothingSent(m, dir, 'the CLI');
  assert.equal(fs.existsSync(statePath(dir)), false, 'a dry run saves no state');
});

test('the late claim\'s warnings are true of every listing it is said on: an invited one is open to every hunter, and the notice says so', async () => {
  const l = await closed({ allowlist: [w.signers[7].address] });
  const dir = makeClaimDir();
  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.match(notices.join('\n'), /invited[^\n]*a late claim is open to every hunter/);
  // lateClaim has no allowlist: the hunter is not on the list, and the claim is taken
  assert.equal(await w.sa.isAllowed(l.listingId, w.hunterWallet.address), false);
  const r = await late({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal((await w.sa.getClaim(r.claimId)).late, true);
});

// -------------------------------------------------------------------------------------------------- the refusals

test('--late is refused before anything is pinned or sent on a listing that takes ordinary commits, and on one that takes no claim at all', async () => {
  const open = await w.listing();
  const unfunded = await w.listing({ fund: false });
  const closedUnfunded = await w.listing({ fund: false });
  await (await asMaker().close(closedUnfunded.listingId)).wait();
  const cases = [
    ['an Open listing, which takes commits', open, 'LISTING_TAKES_COMMITS'],
    ['a listing never funded', unfunded, 'NO_LATE_CLAIMS'],
    ['a listing closed before it opened', closedUnfunded, 'NO_LATE_CLAIMS'],
  ];
  for (const [name, l, code] of cases) {
    const dir = makeClaimDir();
    const m = await mark();
    const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, code, name);
    assert.equal(err.exitCode, 1, name);
    assert.match(err.message, /Nothing was pinned or sent\./, name);
    assert.match(err.message, new RegExp(`Listing ${l.listingId}\\.`), name);
    await assertNothingSent(m, dir, name);
    // without --yes too: a refusal, never a briefing for a claim the contract would not take
    assert.equal((await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: true }).catch((e) => e)).code, code, `${name}, no --yes`);
    await assertNothingSent(m, dir, `${name}, no --yes`);
  }
  assert.match(ERROR_TEXTS.LISTING_TAKES_COMMITS, /without --late/);

  // a listing that lapsed (its paid period over) and is not held takes neither
  const lapsed = await w.listing();
  await w.rpc('evm_setNextBlockTimestamp', [Number((await w.sa.getListing(lapsed.listingId)).fundedUntil)]);
  await w.mine();
  assert.equal(await w.sa.acceptsCommits(lapsed.listingId), false);
  assert.equal(await w.sa.acceptsLateClaims(lapsed.listingId), false);
  const m = await mark();
  const dir = makeClaimDir();
  await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: lapsed.listingId, late: true, acknowledge: true }), (e) => e.code === 'NO_LATE_CLAIMS');
  await assertNothingSent(m, dir, 'a lapsed listing');

  // the CLI: exit 1, the code and its fixed text on stderr
  const fresh = await w.listing();
  const cliDir = makeClaimDir();
  const m2 = await mark();
  const cli = await runCli(w, ['commit', cliDir, '--listing', String(fresh.listingId), '--late', '--yes']);
  assert.equal(cli.code, 1, cli.stdout);
  assert.ok(cli.stderr.startsWith(`verdikta-attest: LISTING_TAKES_COMMITS: ${ERROR_TEXTS.LISTING_TAKES_COMMITS}`), cli.stderr);
  await assertNothingSent(m2, cliDir, 'the CLI');
});

test('an ordinary commit on a listing that takes late claims only is refused, before anything is pinned or sent, with a text that names --late', async () => {
  for (const [name, make] of [['rolled forward', rolled], ['closed after it opened', closed], ['held by its maker', held]]) {
    const l = await make();
    assert.equal(await w.sa.acceptsLateClaims(l.listingId), true, name);
    const dir = makeClaimDir();
    const m = await mark();
    const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_CLAIMS_ONLY', name);
    assert.equal(err.exitCode, 1, name);
    assert.match(err.message, /--late/, name);
    assert.match(err.message, /no award/, name);
    assert.match(err.message, /Nothing was pinned or sent\./, name);
    await assertNothingSent(m, dir, name);
    assert.equal((await w.hunter().commit({ claimDir: dir, listingId: l.listingId }).catch((e) => e)).code, 'LATE_CLAIMS_ONLY', `${name}, no --yes`);
    await assertNothingSent(m, dir, `${name}, no --yes`);
  }
  // the CLI
  const l = await rolled();
  const dir = makeClaimDir();
  const m = await mark();
  const cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(cli.code, 1, cli.stdout);
  assert.ok(cli.stderr.startsWith(`verdikta-attest: LATE_CLAIMS_ONLY: ${ERROR_TEXTS.LATE_CLAIMS_ONLY}`), cli.stderr);
  assert.match(cli.stderr, /commit --late/);
  await assertNothingSent(m, dir, 'the CLI');
  // a listing that takes neither kind is refused as it was
  const unfunded = await w.listing({ fund: false });
  await assert.rejects(w.hunter().commit({ claimDir: makeClaimDir(), listingId: unfunded.listingId, acknowledge: true }), (e) => e.code === 'LISTING_NOT_ACCEPTING');
});

test('the contract\'s own refusal of a late claim is on the allow-list, the only text repeated from a failure', () => {
  assert.ok(KNOWN_REVERTS.includes('not accepting late claims'));
});

// ------------------------------------------------------------------------------------------------ commit order

test('before it pays, commit --late says how many claims on the listing are open ahead of it, late claims and the stake\'s own', async () => {
  const l = await w.listing(LONG);
  const ordinary = await w.hunter().commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true });
  await (await asMaker().hold(l.listingId)).wait();
  const said = async (dir) => {
    const notices = [];
    await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
    return notices.join('\n');
  };
  // behind the claim committed before the hold
  const first = makeClaimDir();
  let text = await said(first);
  assert.ok(text.includes(`Open claims on this listing now: 1, the earliest claim ${ordinary.claimId}.`), text);
  assert.match(text, /yours can be revealed only once every claim committed before it is settled or expired/);
  const a = await late({ claimDir: first, listingId: l.listingId });
  assert.equal(a.waitsFor, ordinary.claimId);
  assert.equal(a.revealDeadlineEarliest, true);
  // and then behind that late claim too: pendingClaims counts only the stake's own, the notice counts both
  assert.equal((await w.sa.getListing(l.listingId)).pendingClaims, 1n);
  text = await said(makeClaimDir());
  assert.ok(text.includes(`Open claims on this listing now: 2, the earliest claim ${ordinary.claimId} (1 of them a late claim).`), text);
});

// ------------------------------------------------------------------------- status, reveal, claim, appeal on one

async function revealedLate(make = rolled) {
  const l = await make();
  const dir = makeClaimDir();
  const { claimId } = await late({ claimDir: dir, listingId: l.listingId });
  await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  return { l, dir, claimId };
}
const script = async (claimId, outcome, { panel = false } = {}) => {
  const c = await w.sa.getClaim(claimId);
  await (await w.aggregator.scriptResult(panel ? c.disputeRequestId : c.requestId, vectorOf(outcome), JUSTIFICATION_CID)).wait();
};

test('status, reveal and claim work on a late claim as on any claim: status says it is a late claim with no award, and a valid one settles with the bond back and nothing from the escrow', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const committed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late', '--yes']);
  assert.equal(committed.code, 0, committed.stderr);
  const { claimId } = readJson(statePath(dir));
  assert.match(committed.stdout, new RegExp(`^Late claim ${claimId} on listing ${l.listingId}: disclosed\\.$`, 'm'));
  assert.match(committed.stdout, /A late claim: [^\n]*no award/);

  // status: by the folder and by the id, with and without --json
  const reader = w.hunter({ signer: undefined });
  for (const target of [{ claimDir: dir }, { claimId: BigInt(claimId) }]) {
    const s = await reader.status(target);
    assert.equal(s.late, true);
    assert.equal(s.claimId, BigInt(claimId));
  }
  let cli = await runCli(w, ['status', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`^Late claim ${claimId} on listing ${l.listingId}: `, 'm'));
  assert.match(cli.stdout, /A late claim: [^\n]*no award/);
  assert.match(cli.stdout, /When it settles, its bond comes back unless the outcome is INVALID/);
  assert.equal(JSON.parse((await runCli(w, ['status', claimId, '--json'])).stdout).late, true);

  // reveal: a dry run first, then the reveal
  cli = await runCli(w, ['reveal', dir]);
  assert.equal(cli.code, 3, cli.stderr);
  cli = await runCli(w, ['reveal', dir, '--yes']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`Claim ${claimId}: Revealed\\.`));
  await script(claimId, 'HIGH');

  // claim: finalize now, settle once the dispute window is over
  cli = await runCli(w, ['claim', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Sent finalize: /);
  assert.match(cli.stdout, new RegExp(`^Late claim ${claimId} on listing ${l.listingId}: Judged HIGH`, 'm'));
  assert.match(cli.stdout, /A late claim: [^\n]*no award/);
  const on = await w.sa.getListing(l.listingId);
  await w.increase(on.disputeWindow);
  const held0 = await w.provider.getBalance(w.address);
  cli = await runCli(w, ['claim', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Sent settle: /);
  assert.match(cli.stdout, new RegExp(`^Late claim ${claimId} on listing ${l.listingId}: Settled HIGH`, 'm'));
  assert.match(cli.stdout, /Settled event: HIGH, paid 0\.0 ETH, owed 0\.0 ETH/);
  assert.match(cli.stdout, /Bond: returned to the hunter/);
  assert.match(cli.stdout, /A late claim: [^\n]*no award/);
  const c = await w.sa.getClaim(claimId);
  assert.equal(c.paidWei, 0n);
  assert.equal(c.owedWei, 0n);
  assert.equal(held0 - await w.provider.getBalance(w.address), c.bondWei, 'the bond left the contract, and nothing else');
  const after_ = await w.sa.getListing(l.listingId);
  assert.equal(after_.escrowWei, on.escrowWei, 'the escrow paid nothing');
  assert.equal(after_.lateOutcomeCounts[4], 1n, 'counted under later, as HIGH');
});

test('an INVALID late claim: the bond goes to the maker, and status and claim say so', async () => {
  const { dir, claimId, l } = await revealedLate(closed);
  await script(claimId, 'INVALID');
  let r = await w.hunter().claim({ claimDir: dir });
  assert.equal(r.state, 'Judged');
  assert.equal(r.outcome, 'INVALID');
  assert.equal(r.late, true);
  await w.increase((await w.sa.getListing(l.listingId)).disputeWindow);
  r = await w.hunter().claim({ claimDir: dir });
  assert.equal(r.state, 'Settled');
  assert.equal(r.bond, 'forfeited');
  assert.equal(r.late, true);
  assert.equal((await w.sa.getListing(l.listingId)).lateOutcomeCounts[0], 1n);
});

test('appeal works on a late claim: its notice says an overturned INVALID pays no award, and the panel\'s verdict settles it with the bond back', async () => {
  const { dir, claimId, l } = await revealedLate();
  await script(claimId, 'INVALID');
  await (await w.sa.finalize(claimId)).wait();
  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).appeal({ claimDir: dir }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  const text = notices.join('\n');
  assert.match(text, /a late claim pays no award/);
  assert.doesNotMatch(text, /a counted class with its award/);
  assert.ok(text.includes(eth(await w.sa.disputeFee(l.listingId))));
  // an ordinary claim's notice says what it said
  assert.match(appealNotice({ action: 'appeal', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n }), /overturned, the panel's outcome settles at once, a counted class with its award\./);

  const r = await w.hunter().appeal({ claimDir: dir, acknowledge: true });
  assert.equal(r.action, 'appeal');
  assert.equal(r.state, 'Disputed');
  assert.equal(r.disputeKind, 'Appeal');
  await script(claimId, 'HIGH', { panel: true });
  const done = await w.hunter().claim({ claimDir: dir });
  assert.equal(done.state, 'Settled');
  assert.equal(done.outcome, 'HIGH');
  assert.equal(done.bond, 'returned');
  assert.equal(done.late, true);
  const c = await w.sa.getClaim(claimId);
  assert.equal(c.paidWei, 0n);
  assert.equal(c.owedWei, 0n);
  assert.equal((await w.sa.getListing(l.listingId)).lateAppealsOverturned, 1n);
});

// ------------------------------------------------------------------------------------ a stopped run, resumed

function child(dir, listingId, step, { lateClaim = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        CRASH_VERB: 'commit',
        CRASH_LATE: lateClaim ? '1' : '',
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

async function assertOneLateClaim(dir, l, countBefore, heldBefore, price) {
  assert.equal(await w.claimCount(), countBefore + 1n, 'exactly one claim');
  assert.equal(await w.provider.getBalance(w.address), heldBefore + price, 'one bond and one prepay paid');
  const saved = readJson(statePath(dir));
  const claim = await w.sa.getClaim(saved.claimId);
  const archive = fs.readFileSync(statePath(dir, 'archive.zip'));
  const ciphertext = fs.readFileSync(statePath(dir, 'ciphertext.age'));
  const keys = readJson(statePath(dir, 'keys.json'));
  assert.equal(claim.late, true, 'a late claim, never a commit');
  assert.equal(claim.archiveHash, sha256(archive));
  assert.equal(claim.ciphertextSha256, sha256(ciphertext));
  assert.notEqual(claim.ciphertextCid, '');
  assert.ok(w.ipfs.store.get(claim.ciphertextCid).equals(ciphertext), 'the pinned bytes are the hashed bytes');
  assert.equal(codeReview.verifyDisclosure({ plaintext: new Uint8Array(archive), ciphertext: new Uint8Array(ciphertext), archiveSha256: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, contentKey: keys.contentKey, ephemeralKey: keys.ephemeralKey, disclosureKey: l.recipient }).ok, true, 'the keys on disk are the ones the ciphertext was made with');
  const on = await w.sa.getListing(l.listingId);
  assert.equal(on.lateClaims, 1n);
  assert.equal(on.claimsCommitted, 0n);
  assert.equal(saved.late, true);
  return { saved, claim };
}

for (const step of COMMIT_STEPS) {
  test(`commit --late killed at ${step}, then resumed: one late claim, one bond, disclosed`, async () => {
    const l = await rolled();
    const dir = makeClaimDir();
    const countBefore = await w.claimCount();
    const heldBefore = await w.provider.getBalance(w.address);
    const price = await w.sa.commitPrice(l.listingId);
    const killed = await child(dir, l.listingId, step);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    const keysAtCrash = fs.existsSync(statePath(dir, 'state.json')) && fs.existsSync(statePath(dir, 'keys.json')) ? fs.readFileSync(statePath(dir, 'keys.json'), 'utf8') : null;

    const resumed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late', '--yes']);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    await assertOneLateClaim(dir, l, countBefore, heldBefore, price);
    if (keysAtCrash !== null) assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keysAtCrash, 'the same keys');

    // a third run changes nothing, with the flag or without it
    for (const args of [['--late'], []]) {
      const again = await runCli(w, ['commit', dir, '--listing', String(l.listingId), ...args]);
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /^Late claim /m);
      assert.equal(await w.claimCount(), countBefore + 1n);
    }
  });
}

test('a stopped late claim resumed without --late: before anything is signed it is refused with the text that names --late; once signed, the saved late claim goes on, never a commit', async () => {
  // prepared, nothing signed: the flag still decides, and an ordinary commit is not taken here
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  const refused = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /^verdikta-attest: LATE_CLAIMS_ONLY: [^\n]*--late/);
  assert.equal(await w.claimCount(), count);
  const ok = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late', '--yes']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(await w.claimCount(), count + 1n);
  assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys, 'the keys drawn before the stop');

  // signed and saved, not sent: the saved bytes are a lateClaim, and a run without the flag sends those
  const l2 = await rolled();
  const dir2 = makeClaimDir();
  assert.equal((await child(dir2, l2.listingId, 'commit:signed')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir2));
  assert.equal(saved.stage, 'commit-signed');
  assert.equal(saved.late, true);
  assert.equal(ethers.Transaction.from(saved.commitTx.raw).data.slice(0, 10), iface.getFunction('lateClaim').selector);
  const resumed = await runCli(w, ['commit', dir2, '--listing', String(l2.listingId)]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /^Late claim /m);
  assert.match(resumed.stdout, /is a late claim: this run goes on with it as that, and it pays no award\./);
  assert.equal(await w.claimCount(), count + 2n);
  const claim = await w.sa.getClaim(readJson(statePath(dir2)).claimId);
  assert.equal(claim.late, true);
  assert.equal((await w.provider.getTransactionReceipt(saved.commitTx.hash)).status, 1, 'the saved transaction is the one that was mined');
});

test('--late on a folder whose ordinary commit is already on the chain changes nothing: the run goes on with that claim and says what it is', async () => {
  const l = await w.listing(LONG);
  const dir = makeClaimDir();
  assert.equal((await child(dir, l.listingId, 'commit:saved', { lateClaim: false })).signal, 'SIGKILL');
  const count = await w.claimCount();
  // the maker holds the listing between the commit and the disclose: the commit made before it is a commit still
  await (await asMaker().hold(l.listingId)).wait();
  const notices = [];
  const r = await w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, false);
  assert.equal(await w.claimCount(), count);
  assert.match(notices.join('\n'), /an ordinary commit[^\n]*--late changes nothing/);
  assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false);
});

test('a pending late claim on resume: the same bytes again, never a second transaction', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  await w.rpc('evm_setAutomine', [false]);
  try {
    const stop = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(stop.code, 'TX_PENDING');
    const first = readJson(statePath(dir)).commitTx.hash;
    const stop2 = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(stop2.code, 'TX_PENDING');
    assert.equal(readJson(statePath(dir)).commitTx.hash, first);
    const pending = await w.rpc('eth_getBlockByNumber', ['pending', false]);
    assert.equal(pending.transactions.length, 1, 'one transaction waits');
    await w.mine();
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.equal(await w.claimCount(), count + 1n);
});

test('the saved late claim\'s nonce went to something else and no claim exists: signed again once, as a late claim', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'commit:signed')).signal, 'SIGKILL');
  await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
  const r = await late({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.equal(await w.claimCount(), count + 1n);
  assert.deepEqual(await eventsOf(r.commitTx), ['LateClaim']);
});

test('the same late claim went out another way: that claim is adopted, signed or not, and no second bond is paid', async () => {
  for (const step of ['prepare:saved', 'commit:signed']) {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    assert.equal((await child(dir, l.listingId, step)).signal, 'SIGKILL', step);
    const saved = readJson(statePath(dir));
    const price = await w.sa.commitPrice(l.listingId);
    const other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price, gasPrice: 10n ** 10n })).wait();
    const heldNow = await w.provider.getBalance(w.address);
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed', step);
    assert.equal(r.claimId, count + 1n, step);
    assert.equal(r.late, true, step);
    // the transaction it names is the one that made the claim, not the saved one that never did
    assert.equal(r.commitTx, other.hash, step);
    assert.notEqual(saved.commitTx?.hash, other.hash, step);
    assert.deepEqual(readJson(statePath(dir)).commitTx, { hash: other.hash }, step);
    assert.equal(await w.claimCount(), count + 1n, `${step}: one claim, the one that exists`);
    assert.equal(await w.provider.getBalance(w.address), heldNow, `${step}: nothing more was paid`);
    assert.equal(readJson(statePath(dir)).late, true, step);
  }
});

// Round 1 of the review: a claim with the folder's hashes that is already on the chain, sent some other way, has its
// bond. So it is found before anything can refuse the run or remove the keys it needs.
test('a prepared folder whose claim is already on the chain is adopted before the flag, the wallet\'s balance or --restart is asked', async () => {
  // no --late on the resume: adopted, never refused for the flag
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
    const saved = readJson(statePath(dir));
    const other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    const cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId)]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /^Late claim /m);
    assert.match(cli.stdout, /is a late claim: this run goes on with it as that/);
    assert.equal(await w.claimCount(), count + 1n);
    assert.deepEqual(readJson(statePath(dir)).commitTx, { hash: other.hash });
    assert.notEqual((await w.sa.getClaim(count + 1n)).ciphertextCid, '', 'disclosed');
  }
  // --restart: refused, and the keys that claim needs stay where they are
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
    const saved = readJson(statePath(dir));
    const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
    await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    await assert.rejects(late({ claimDir: dir, listingId: l.listingId, restart: true }), (e) => e.code === 'RESTART_REFUSED');
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys, 'the keys of the claim on the chain');
    assert.equal(readJson(statePath(dir)).stage, 'committed');
    assert.equal((await late({ claimDir: dir, listingId: l.listingId })).stage, 'disclosed');
    assert.equal(await w.claimCount(), count + 1n);
  }
  // a wallet with enough for the disclosure and not for a second claim: no check of the price stands in the way
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    const price = await w.sa.commitPrice(l.listingId);
    const poor = ethers.Wallet.createRandom().connect(w.provider);
    const { maxFeePerGas } = await w.provider.getFeeData();
    await (await w.signers[8].sendTransaction({ to: poor.address, value: price + 1_200_000n * maxFeePerGas })).wait();
    const crash = (step) => { if (step === 'prepare:saved') throw new Error('crash'); };
    await w.hunter({ signer: poor, onStep: crash }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch(() => {});
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    await (await w.sa.connect(poor).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price })).wait();
    assert.ok(await w.provider.getBalance(poor.address) < price, 'it could not pay for a second claim');
    const r = await w.hunter({ signer: poor }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, count + 1n);
    assert.equal(await w.claimCount(), count + 1n);
  }
});

test('a late claim sent some other way and not mined yet: nothing is signed while the wallet has a transaction pending, and once it is mined that claim is adopted', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const price = await w.sa.commitPrice(l.listingId);
  let other;
  await w.rpc('evm_setAutomine', [false]);
  try {
    other = await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price });
    // run twice: the refusal leaves nothing behind that a second run could send
    for (const run of ['first', 'second']) {
      const err = await late({ claimDir: dir, listingId: l.listingId }).catch((e) => e);
      assert.equal(err.code, 'WALLET_BUSY', run);
      assert.equal(err.exitCode, 4, 'run the same command again');
      assert.match(err.message, /second bond/);
      assert.match(err.message, /Nothing was sent\./);
    }
    // nor are its keys removed: --restart is refused the same way, with --late or without it, since a prepared
    // folder names no kind and the claim that is not mined yet has no log to be found by
    const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
    for (const flag of [true, false]) {
      const restart = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: flag, restart: true, acknowledge: true }).catch((e) => e);
      assert.equal(restart.code, 'WALLET_BUSY', `--restart, late ${flag}`);
      assert.match(restart.message, /--restart would remove the keys it needs/);
      assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys, `--restart, late ${flag}: the keys stay`);
    }
    const now = readJson(statePath(dir));
    assert.equal(now.stage, 'prepared');
    assert.equal(now.commitTx ?? null, null, 'nothing was signed');
    assert.equal((await w.rpc('eth_getBlockByNumber', ['pending', false])).transactions.length, 1, 'only the one sent the other way waits');
    await w.mine();
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
  const r = await late({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.commitTx, other.hash);
  assert.equal(await w.claimCount(), count + 1n, 'one claim, one bond');
});

// Rounds 2 and 3: the same claim may be mined at any moment of the run. The wallet's nonce and the logs are read at one
// block and the pending count after them, so one mined by then is seen and nothing is signed; and the late claim is
// signed at that nonce, so one mined after it leaves the signature at a used nonce, and the claim is adopted.
/** A provider that runs `inject` once, right after its first `method` call that `when` accepts. */
function injecting(method, inject, when = () => true) {
  let done = false;
  return new Proxy(w.provider, {
    get(target, prop) {
      if (prop === method) {
        return async (...args) => {
          const answer = await target[method](...args);
          if (!done && when(...args)) {
            done = true;
            await inject();
          }
          return answer;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('a late claim sent some other way and mined in the middle of the run: during the log scan nothing is signed; after the last read the signature is at a used nonce, and the claim is adopted', async () => {
  const sendOther = async (l, dir) => {
    const saved = readJson(statePath(dir));
    return (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  };
  // mined while the logs are read: the pending count, read after them, is above the nonce
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    const price = await w.sa.commitPrice(l.listingId);
    const heldBefore = await w.provider.getBalance(w.address);
    let other = null;
    const provider = injecting('getLogs', async () => { other = await sendOther(l, dir); }, () => fs.existsSync(statePath(dir)));
    const err = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.ok(other, 'the other one went out during the scan');
    assert.equal(err.code, 'WALLET_BUSY', err.message);
    assert.equal(readJson(statePath(dir)).commitTx ?? null, null, 'nothing was signed');
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.commitTx, other.hash);
    assert.equal(await w.claimCount(), count + 1n, 'one claim');
    assert.equal(await w.provider.getBalance(w.address), heldBefore + price, 'one bond and one prepay');
  }
  // mined after every read, just before the signature: the late claim is signed at a nonce that is used by then
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    const price = await w.sa.commitPrice(l.listingId);
    const heldBefore = await w.provider.getBalance(w.address);
    let other = null;
    const provider = injecting('estimateGas', async () => { other = await sendOther(l, dir); });
    const r = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.ok(other, 'the other one went out before the signature');
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, count + 1n);
    assert.equal(r.commitTx, other.hash, 'the claim on the chain is the one that was sent the other way');
    assert.equal(await w.claimCount(), count + 1n, 'one claim');
    assert.equal(await w.provider.getBalance(w.address), heldBefore + price, 'one bond and one prepay');
    assert.equal((await w.sa.getListing(l.listingId)).lateClaims, 1n);
  }
});

// Round 3: a provider may answer the head from a short memory of its own, behind the nonce it then reads. The nonce is
// read at the block the logs are read to, so a head that is behind is behind for both, and the pending count shows it.
test('a head that is behind the chain is behind for the nonce and the logs alike: a claim mined past it is not signed beside', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  let behind = null;
  let other = null;
  const provider = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'getBlockNumber') return async () => behind ?? target.getBlockNumber();
      if (prop === 'send') return async (method, params) => (behind !== null && method === 'eth_blockNumber' ? `0x${behind.toString(16)}` : target.send(method, params));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const onStep = async (step) => {
    if (step !== 'prepare:saved') return;
    // the same late claim is mined in the next block, and the provider goes on answering the block before it
    behind = await w.provider.getBlockNumber();
    const saved = readJson(statePath(dir));
    other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  };
  const err = await w.hunter({ provider, onStep }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
  assert.ok(other.blockNumber > behind, 'the claim is past the head the provider answers');
  assert.equal(err.code, 'WALLET_BUSY', err.message);
  assert.equal(readJson(statePath(dir)).commitTx ?? null, null, 'nothing was signed');
  assert.equal(await w.claimCount(), count + 1n);
  // once the provider has caught up, the claim is found and adopted
  behind = null;
  const r = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, late: true });
  assert.equal(r.commitTx, other.hash);
  assert.equal(await w.claimCount(), count + 1n, 'one claim, one bond');
});

// Round 3: --restart removes the keys, so it is held to the same reads.
test('--restart while the same claim is mined in the middle of its checks: the keys stay', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  let other = null;
  const provider = injecting('getLogs', async () => {
    other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  });
  for (const flag of [false, true]) {
    const err = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, late: flag, restart: true, acknowledge: true }).catch((e) => e);
    // the first run sees it by the pending count, the second by its log
    assert.equal(err.code, flag ? 'RESTART_REFUSED' : 'WALLET_BUSY', `late ${flag}: ${err.message}`);
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys, `late ${flag}: the keys of the claim on the chain`);
  }
  assert.ok(other);
  const r = await late({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.commitTx, other.hash);
  assert.equal(await w.claimCount(), count + 1n);
});

// Round 2: an adopted claim is as deep as the chain has it when it is adopted, not as its log said at first.
test('a claim found by its log and then moved to a later block by a reorganization is not pinned until it is deep enough where it is now', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const price = await w.sa.commitPrice(l.listingId);
  const send = async () => (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price })).wait();
  const snapshot = await w.rpc('evm_snapshot');
  const first = await send();
  const uploads = w.ipfs.uploads.length;
  let moved = null;
  let depthWhenAdopted = null;
  const hunter = w.hunter({
    confirmations: 2,
    sleep: async () => {
      if (depthWhenAdopted !== null) return;
      assert.equal(w.ipfs.uploads.length, uploads, 'no pin while it waits');
      if (moved) {
        await w.mine();
        return;
      }
      // the reorganization: the claim's block is gone, an empty one stands at its height, the claim is in the next
      await w.rpc('evm_revert', [snapshot]);
      await w.mine();
      moved = await send();
    },
    onStep: async (step) => {
      if (step !== 'commit:saved') return;
      const receipt = await w.provider.getTransactionReceipt(readJson(statePath(dir)).commitTx.hash);
      depthWhenAdopted = (await w.provider.getBlockNumber()) - receipt.blockNumber + 1;
      assert.equal(w.ipfs.uploads.length, uploads, 'nothing pinned before it is adopted');
    },
  });
  const r = await hunter.commit({ claimDir: dir, listingId: l.listingId, late: true });
  assert.equal(r.stage, 'disclosed');
  assert.ok(moved, 'the claim was moved');
  assert.equal(moved.blockNumber, first.blockNumber + 1, 'to the block after the one its log first named');
  assert.equal(r.commitTx, moved.hash);
  assert.ok(depthWhenAdopted >= 2, `adopted at depth ${depthWhenAdopted}, where it is now`);
});

// Round 3: the same, when the claim is moved between the read of its log and the read of the head: its depth by the
// numbers is enough, and the block its log named is no longer the block at that height.
test('a claim moved by a reorganization right after its log was read is not adopted on that log: its block no longer has the hash the log gave', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const price = await w.sa.commitPrice(l.listingId);
  const send = async () => (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price })).wait();
  const snapshot = await w.rpc('evm_snapshot');
  const first = await send();
  const uploads = w.ipfs.uploads.length;
  let moved = null;
  let depthWhenAdopted = null;
  // the log is read with the claim in its first block; then that block is replaced by an empty one, and the claim is
  // mined in the next: the head is one block further, so the depth by the numbers is two
  const provider = injecting('getLogs', async () => {
    await w.rpc('evm_revert', [snapshot]);
    await w.mine();
    moved = await send();
  });
  const hunter = w.hunter({
    provider,
    confirmations: 2,
    sleep: async () => { if (depthWhenAdopted === null) await w.mine(); },
    onStep: async (step) => {
      if (step !== 'commit:saved') return;
      const receipt = await w.provider.getTransactionReceipt(readJson(statePath(dir)).commitTx.hash);
      depthWhenAdopted = (await w.provider.getBlockNumber()) - receipt.blockNumber + 1;
      assert.equal(w.ipfs.uploads.length, uploads, 'nothing pinned before it is adopted');
    },
  });
  const r = await hunter.commit({ claimDir: dir, listingId: l.listingId, late: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(moved.blockNumber, first.blockNumber + 1);
  assert.notEqual(moved.blockHash, first.blockHash);
  assert.equal(r.commitTx, moved.hash, 'adopted as the transaction it is now');
  assert.ok(depthWhenAdopted >= 2, `adopted at depth ${depthWhenAdopted}, where it is now`);
});

test('an ordinary commit is signed as it always was while another transaction of the wallet is pending', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  await w.rpc('evm_setAutomine', [false]);
  try {
    await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n });
    const stop = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(stop.code, 'TX_PENDING', 'signed and sent behind it, as before');
    assert.equal(readJson(statePath(dir)).stage, 'commit-signed');
    assert.equal((await w.rpc('eth_getBlockByNumber', ['pending', false])).transactions.length, 2);
    await w.mine();
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
  assert.equal((await w.hunter().commit({ claimDir: dir, listingId: l.listingId })).stage, 'disclosed');
  assert.equal(await w.claimCount(), count + 1n);
});

test('a fee that moves between the terms and the signature is said before it is signed: the amount printed is the amount sent', async () => {
  try {
    for (const [name, make, lateClaim] of [['a late claim', rolled, true], ['a commit', () => w.listing(), false]]) {
      await (await w.aggregator.setFeeMultiplier(3n)).wait();
      const l = await make();
      const dir = makeClaimDir();
      const quoted = await w.sa.commitPrice(l.listingId);
      const said = [];
      const onStep = async (step) => {
        said.push(step);
        if (step === 'prepare:saved') await (await w.aggregator.setFeeMultiplier(5n)).wait();
      };
      const r = await w.hunter({ onStep, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: lateClaim, acknowledge: true });
      const price = await w.sa.commitPrice(l.listingId);
      assert.ok(price > quoted, name);
      assert.equal((await w.provider.getTransaction(r.commitTx)).value, price, name);
      const line = `The live fee moved since the terms above were said: this ${lateClaim ? 'late claim' : 'commit'} sends ${eth(price)} now, not ${eth(quoted)}.`;
      assert.ok(said.includes(line), `${name}: ${said.filter((t) => /moved/.test(t)).join(' | ')}`);
      assert.ok(said.indexOf(line) < said.indexOf('commit:signed'), `${name}: said before it is signed`);
      assert.ok(said.some((t) => t.includes(`sends ${eth(quoted)}: the bond`)), `${name}: the terms named the first price`);
    }
    // a fee that did not move adds no line
    const l = await rolled();
    const quiet = [];
    await w.hunter({ onNotice: (t) => quiet.push(t) }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, late: true, acknowledge: true });
    assert.doesNotMatch(quiet.join('\n'), /The live fee moved/);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('the nonce goes to another transaction while the first send waits, and no claim comes of it: the run says so, discloses nothing, and a run again signs anew', async () => {
  for (const [name, make, lateClaim] of [['a late claim', rolled, true], ['a commit', () => w.listing(), false]]) {
    const l = await make();
    const dir = makeClaimDir();
    const m = await mark();
    const notices = [];
    const onStep = async (step) => {
      if (step === 'commit:signed') await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
    };
    const err = await w.hunter({ onStep, onNotice: (t) => notices.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: lateClaim, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'COMMIT_REPLACED', `${name}: ${err.message}`);
    assert.match(err.message, /no claim exists and nothing was pinned/, name);
    assert.doesNotMatch(notices.join('\n'), /undefined/, `${name}: no notice of a claim that does not exist`);
    assert.equal(await w.claimCount(), m.claims, name);
    assert.equal(w.ipfs.uploads.length, m.uploads, name);
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared', name);
    assert.equal(saved.commitTx, null, name);
    assert.equal(Object.hasOwn(saved, 'late'), false, `${name}: a prepared folder names no kind`);
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateClaim, acknowledge: true });
    assert.equal(r.stage, 'disclosed', name);
    assert.equal(r.late, lateClaim, name);
    assert.equal(await w.claimCount(), m.claims + 1n, name);
  }
});

test('an RPC that does not answer whether the listing takes late claims is said as that; a lens that cannot say leaves the refusal a commit always had', async () => {
  const l = await rolled();
  const selector = iface.getFunction('acceptsLateClaims').selector;
  const failing = (message) => new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'call') return async (tx, ...rest) => {
        if (String(tx?.data ?? '').startsWith(selector)) throw new Error(message);
        return target.call(tx, ...rest);
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const m = await mark();
  const down = await w.hunter({ provider: failing('socket hang up') }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(down.code, 'RPC_UNAVAILABLE');
  const noLens = await w.hunter({ provider: failing('execution reverted: unknown function') }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(noLens.code, 'LISTING_NOT_ACCEPTING');
  await assertNothingSent(m, null, 'either way');
});

test('a saved late claim that may not have gone out is not sent if the keys it needs are gone', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  assert.equal((await child(dir, l.listingId, 'commit:signed')).signal, 'SIGKILL');
  const count = await w.claimCount();
  fs.rmSync(statePath(dir, 'keys.json'));
  const err = await late({ claimDir: dir, listingId: l.listingId }).catch((e) => e);
  assert.equal(err.code, 'FILE_MISSING');
  assert.equal(await w.claimCount(), count, 'it did not pay');
});

// --------------------------------------------------------------------------------------- a contract with no hold

// The contract live today has no hold. Its ABI differs from this one by exactly what the hold added, heldAt, hold and
// the Held event (node P39 changed no other function, event or struct), and its lens's acceptsLateClaims says Rolled,
// or Closed after it opened. A call of heldAt or hold there reaches the fallback, which reverts with "unknown
// function". This provider answers those two as that contract does, and keeps the name of every function called, so a
// test can say both that the tool went through it and that it never asked for the hold.
function withoutHold() {
  const missing = new Set(['heldAt', 'hold']);
  const asked = [];
  const called = new Set();
  const refuse = (target, prop) => async (tx, ...rest) => {
    const name = String(tx?.to ?? '').toLowerCase() === w.address.toLowerCase() ? iface.getFunction(String(tx.data ?? '').slice(0, 10))?.name : null;
    if (name) called.add(name);
    if (!missing.has(name)) return target[prop](tx, ...rest);
    asked.push(name);
    throw Object.assign(new Error('execution reverted: unknown function'), { code: 'CALL_EXCEPTION', reason: 'unknown function' });
  };
  const provider = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'call' || prop === 'estimateGas') return refuse(target, prop);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { provider, asked, called };
}

test('against a contract with no hold, a late claim works on a Rolled listing and on one Closed after it opened, and the tool never asks for the hold', async () => {
  const old = withoutHold();
  // the stand-in answers as that contract does
  await assert.rejects(old.provider.call({ to: w.address, data: iface.encodeFunctionData('heldAt', [1n]) }), /unknown function/);
  assert.deepEqual(old.asked, ['heldAt']);
  old.asked.length = 0;
  old.called.clear();
  const hunter = (o = {}) => w.hunter({ provider: old.provider, ...o });
  for (const [name, make] of [['Rolled', rolled], ['Closed after it opened', closed]]) {
    const l = await make();
    const dir = makeClaimDir();
    const m = await mark();
    // an ordinary commit there is refused with the text that names --late
    await assert.rejects(hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'LATE_CLAIMS_ONLY', name);
    // the dry run, then the late claim, then its life
    await assert.rejects(hunter().commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT', name);
    await assertNothingSent(m, dir, name);
    const r = await hunter().commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed', name);
    assert.equal(r.late, true, name);
    assert.equal((await w.sa.getClaim(r.claimId)).late, true, name);
    assert.equal((await hunter({ signer: undefined }).status({ claimDir: dir })).late, true, name);
    assert.equal((await hunter().reveal({ claimDir: dir, acknowledge: true })).state, 'Revealed', name);
    await script(r.claimId, 'DUPLICATE');
    const done = await hunter().claim({ claimDir: dir });
    assert.equal(done.state, 'Settled', name);
    assert.equal(done.outcome, 'DUPLICATE', name);
    assert.equal(done.bond, 'returned', name);
  }
  // and nothing about an ordinary commit asks for it either
  const open = await w.listing();
  const o = await hunter().commit({ claimDir: makeClaimDir(), listingId: open.listingId, acknowledge: true });
  assert.equal(o.late, false);
  await assert.rejects(hunter().commit({ claimDir: makeClaimDir(), listingId: open.listingId, late: true, acknowledge: true }), (e) => e.code === 'LISTING_TAKES_COMMITS');
  assert.deepEqual(old.asked, [], 'no read or call of the hold, which that contract does not have');
  // and it did go through this provider: the reads and the calls a late claim's life makes
  for (const name of ['commitPrice', 'acceptsLateClaims', 'acceptsCommits', 'isAllowed', 'getListing', 'lateClaim', 'commit', 'disclose', 'getClaim', 'claimState', 'claimTimes', 'reveal', 'finalize', 'settle']) assert.ok(old.called.has(name), `${name} was called through it`);
});

// ------------------------------------------------------------------------------------------- the help, the words

test('--help describes the late claim: the flag on commit\'s own line, when a listing takes one, what it costs and what it pays', () => {
  assert.match(USAGE, /^ {2}commit <claim-dir> --listing <id> \[--late\] \[--yes\] \[--restart\] \[--accept-unread-pin\]$/m);
  const flat = USAGE.replace(/\s+/g, ' ');
  assert.match(flat, /--late files a late claim/);
  assert.match(flat, /its stake has rolled forward, or closed after it opened, or its maker holds it/);
  assert.match(flat, /pays no award/);
  assert.match(flat, /costs what a commit costs/);
  assert.match(flat, /the bond is forfeited on INVALID/);
  assert.match(flat, /the prepay is spent on the evaluation/);
  assert.match(flat, /without --yes it prints[^.]*sends nothing/);
});

test('--late is a flag the CLI\'s parser takes, on commit', async () => {
  let stderr = '';
  const io = { stdout: { write: () => {} }, stderr: { write: (s) => { stderr += s; } } };
  const code = await run(['commit', 'no-such-folder', '--late'], io, {});
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /unknown option/);
  assert.match(stderr, /commit needs an IPFS gateway/);
});

test('the late claim\'s notice and the new refusals pass the wording check, and each refusal says nothing was pinned or sent', () => {
  const terms = { listingId: 7n, state: 'Rolled', successor: 9n, bondWei: 1n, priceWei: 2n, feeWei: 1n, awards: [0n, 1n, 2n, 3n], lowestClass: 'MEDIUM', invited: true, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40), pendingClaims: 1n, lateOpenClaims: 2n, headClaim: 5n, late: true };
  const notice = commitNotice(terms);
  assert.match(notice, /A late claim pays no award/);
  assert.match(notice, /rolled forward to listing 9/);
  assert.match(notice, /Open claims on this listing now: 3, the earliest claim 5 \(2 of them late claims\)\./);
  const texts = [notice, commitNotice({ ...terms, pendingClaims: 0n, lateOpenClaims: 0n, headClaim: 0n, state: 'Closed', successor: 0n, invited: false }), appealNotice({ action: 'appeal', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n, late: true }), appealNotice({ action: 'retrigger', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n, late: true })];
  for (const text of texts) assert.deepEqual(wordingProblems(text), [], text);
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS']) {
    assert.equal(typeof ERROR_TEXTS[code], 'string', code);
    assert.deepEqual(wordingProblems(ERROR_TEXTS[code]), [], code);
    assert.match(ERROR_TEXTS[code], /Nothing was pinned or sent\.$/, code);
  }
  // an ordinary commit's notice is the one it was, whatever a caller leaves out
  const { late: _late, lateOpenClaims: _n, successor: _s, ...ordinary } = { ...terms, invited: false };
  assert.equal(commitNotice(ordinary), commitNotice({ ...ordinary, late: false }));
  assert.doesNotMatch(commitNotice(ordinary), /late claim/i);
  assert.match(commitNotice(ordinary), /^This commit sends /m);
});

test('the README\'s hunter section shows the command and says what a late claim is', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('\n## The hunter tool\n');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  assert.match(section, /^verdikta-attest commit \.\/claim --listing 12 --late --yes\b/m);
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /`commit --late`/);
  assert.match(flat, /`lateClaim`/);
  assert.match(flat, /`acceptsLateClaims`/);
  assert.match(flat, /no award/);
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS']) assert.ok(flat.includes(`\`${code}\``), code);
});
