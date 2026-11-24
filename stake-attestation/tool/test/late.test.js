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
/** A provider (the world's, or `over`) that runs `inject` once, right after its first `method` call that `when` accepts. */
function injecting(method, inject, when = () => true, over = w.provider) {
  let done = false;
  return new Proxy(over, {
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
    const provider = injecting('send', async () => { other = await sendOther(l, dir); }, (method) => method === 'eth_getLogs' && fs.existsSync(statePath(dir)));
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
      if (prop === 'send') {
        return async (method, params) => {
          if (behind === null) return target.send(method, params);
          if (method === 'eth_blockNumber') return `0x${behind.toString(16)}`;
          if (method === 'eth_getBlockByNumber' && params[0] === 'latest') return target.send(method, [`0x${behind.toString(16)}`, params[1]]);
          return target.send(method, params);
        };
      }
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

// Round 10: a prepared folder is scanned before a resume and before --restart, so on an RPC that caps eth_getLogs
// below the range a folder has grown to, neither could go on. A page that is refused is asked for again in halves.
test('an RPC that caps eth_getLogs below the blocks a prepared folder is old: the scan goes on in smaller pages, for a resume and for --restart', async () => {
  try {
    // an ordinary commit's folder, ten blocks old, and a cap of three: --restart starts over
    {
      const l = await w.listing();
      const dir = makeClaimDir();
      const count = await w.claimCount();
      assert.equal((await child(dir, l.listingId, 'prepare:saved', { lateClaim: false })).signal, 'SIGKILL');
      const old = readJson(statePath(dir));
      await w.mine(10);
      w.logLimits.maxBlocks = 3;
      w.logLimits.calls.length = 0;
      const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, restart: true, acknowledge: true });
      assert.equal(r.stage, 'disclosed');
      assert.notEqual(r.ciphertextSha256, old.ciphertextSha256, 'new keys');
      assert.equal(await w.claimCount(), count + 1n);
      const asked = w.logLimits.calls.filter((c) => c.fromBlock !== undefined);
      assert.ok(asked.some((c) => c.refused), 'the first page was refused');
      assert.ok(asked.filter((c) => !c.refused).every((c) => c.blocks <= 3), 'and every page answered is within the cap');
      w.logLimits.maxBlocks = null;
    }
    // a late claim's folder, whose claim was sent some other way seven blocks on: found past the first pages, adopted
    {
      const l = await rolled();
      const dir = makeClaimDir();
      const count = await w.claimCount();
      assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
      const saved = readJson(statePath(dir));
      await w.mine(7);
      const other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
      await w.mine(2);
      w.logLimits.maxBlocks = 3;
      const r = await late({ claimDir: dir, listingId: l.listingId });
      assert.equal(r.stage, 'disclosed');
      assert.equal(r.commitTx, other.hash);
      assert.equal(await w.claimCount(), count + 1n, 'one claim');
    }
  } finally {
    w.logLimits.maxBlocks = null;
    w.logLimits.calls.length = 0;
  }
});

// Round 7: a run without --yes on a prepared folder is a dry run only while no claim of its hashes is on the chain.
test('a prepared folder whose claim is on the chain already is under way: a run without --yes adopts and discloses it, as it resumes a signed one', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  // before: nothing on the chain, so nothing is sent without --yes
  const dry = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late']);
  assert.equal(dry.code, 3, dry.stderr);
  assert.equal(await w.claimCount(), count);
  await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  const uploads = w.ipfs.uploads.length;
  const run = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^Late claim \d+ on listing \d+: disclosed\.$/m);
  assert.equal(w.ipfs.uploads.length, uploads + 1, 'the ciphertext was pinned');
  assert.notEqual((await w.sa.getClaim(count + 1n)).ciphertextCid, '');
  // and the help says so
  assert.match(USAGE.replace(/\s+/g, ' '), /a claim of the folder's two hashes that is on the chain already, sent some other way, is under way like a signed one: any run adopts it and discloses it, --yes or not/);
});

// Round 4: a height is not a block. A reorganization between the read of the nonce and the read of the logs has them
// read on different forks: the nonce counts the claim, the logs no longer hold it, and it is back in the pool. The
// block both were read at is read again, by its hash, and a run that saw it change signs nothing.
test('a reorganization between the nonce and the logs: the block they were read at is no longer that block, and nothing is signed', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  const price = await w.sa.commitPrice(l.listingId);
  const sendOther = async () => {
    const saved = readJson(statePath(dir));
    return w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price });
  };
  let snapshot = null;
  let first = null;
  let pendingAgain = null;
  // the nonce at a block, not the pending count: the read a reorganization comes right after
  const atBlock = (method, params) => method === 'eth_getTransactionCount' && params[1] !== 'pending';
  const reorganize = async () => {
    await w.rpc('evm_revert', [snapshot]);
    await w.mine();
    await w.rpc('evm_setAutomine', [false]);
    pendingAgain = await sendOther();
  };
  // the same late claim is mined right after the folder is prepared: the head the run reads holds it
  const onStep = async (step) => {
    if (step !== 'prepare:saved') return;
    snapshot = await w.rpc('evm_snapshot');
    first = await (await sendOther()).wait();
  };
  // the nonce is read at that block and counts it; then the block is replaced by an empty one, and the claim is back
  // in the pool, not mined
  // a provider as a library caller may hand in: ethers answers a repeated request from memory for a while (250 ms
  // unless told otherwise; a minute here, so that the run again below is sure to be inside it)
  const remembering = new ethers.BrowserProvider({ request: (call) => w.hre.network.provider.request(call) }, 31337, { cacheTimeout: 60_000, staticNetwork: true });
  const provider = injecting('send', reorganize, atBlock, remembering);
  try {
    const err = await w.hunter({ provider, onStep, waitMs: 300 }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.ok(pendingAgain, 'the reorganization happened between the two reads');
    assert.equal(err.code, 'RPC_UNAVAILABLE', err.message);
    assert.match(err.message, /reorganized while it was read/);
    assert.equal(readJson(statePath(dir)).commitTx ?? null, null, 'nothing was signed');
    assert.equal((await w.rpc('eth_getBlockByNumber', ['pending', false])).transactions.length, 1, 'only the claim that came back to the pool waits');
    assert.notEqual((await w.provider.getBlock(first.blockNumber)).hash, first.blockHash, 'the block at that height is another block');
    // Round 5: a run again at once, through a provider that still remembers what it answered a moment ago. Every
    // read that decides is the node's own, so the nonce is the new fork's, below the pending count: nothing is signed.
    const again = await w.hunter({ provider: remembering, waitMs: 300 }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(again.code, 'WALLET_BUSY', again.message);
    assert.equal(readJson(statePath(dir)).commitTx ?? null, null, 'nothing was signed');
    assert.equal((await w.rpc('eth_getBlockByNumber', ['pending', false])).transactions.length, 1);
    await w.mine();
  } finally {
    await w.rpc('evm_setAutomine', [true]);
  }
  const r = await late({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.commitTx, pendingAgain.hash);
  assert.equal(await w.claimCount(), count + 1n, 'one claim, one bond');
});

// Round 4: no read can see a claim that someone holds signed and has not sent yet. So --restart deletes nothing: the
// prepared files are set aside, and a claim of the old hashes that turns up later still has its keys on this disk.
test('--restart sets the prepared files aside and deletes nothing: a claim of the old hashes sent afterwards can still be disclosed from them', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const folder = `${dir}/.verdikta-claim`;
  const old = { state: readJson(statePath(dir)) };
  const prepared = ['archive.zip', 'keys.json', 'ciphertext.age', 'anchor.json', 'state.json'];
  for (const name of prepared) old[name] = fs.readFileSync(statePath(dir, name));
  // --restart: new keys, a late claim of the new hashes, and every old file still there under one stamp
  const r = await late({ claimDir: dir, listingId: l.listingId, restart: true });
  assert.equal(r.stage, 'disclosed');
  assert.notEqual(r.ciphertextSha256, old.state.ciphertextSha256, 'new keys, so another ciphertext');
  const aside = fs.readdirSync(folder).filter((n) => n.includes('.set-aside-'));
  const stamps = new Set(aside.map((n) => n.split('.set-aside-')[1]));
  assert.equal(stamps.size, 1, aside.join(', '));
  // the new claim has an anchor of its own, of the block it was prepared at
  assert.deepEqual(anchorOf(dir).head, await blockId(readJson(statePath(dir)).startBlock));
  for (const name of prepared) {
    const kept = `${name}.set-aside-${[...stamps][0]}`;
    assert.ok(aside.includes(kept), kept);
    assert.ok(fs.readFileSync(statePath(dir, kept)).equals(old[name]), `${name}: byte for byte`);
    assert.equal(fs.statSync(statePath(dir, kept)).mode & 0o777, 0o600, kept);
  }
  // the old hashes' claim, held by another client and sent only now: its keys were not destroyed, and they open it
  await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, old.state.archiveSha256, old.state.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  assert.equal(await w.claimCount(), count + 2n);
  const claim = await w.sa.getClaim(count + 2n);
  const keys = JSON.parse(old['keys.json'].toString('utf8'));
  assert.equal(codeReview.verifyDisclosure({ plaintext: new Uint8Array(old['archive.zip']), ciphertext: new Uint8Array(old['ciphertext.age']), archiveSha256: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, contentKey: keys.contentKey, ephemeralKey: keys.ephemeralKey, disclosureKey: l.recipient }).ok, true, 'the files set aside are the ones that claim needs');
});

// Round 5: a --restart that stops half way. The four files are copied before any original is removed, and state.json
// is removed first, so the folder is either the prepared claim it was, whole, or no claim with the whole set aside.
test('--restart stopped half way: while copying, the prepared claim is whole and can still be adopted; after the state is gone, the whole set stands under one stamp', async () => {
  const names = ['archive.zip', 'keys.json', 'ciphertext.age', 'anchor.json', 'state.json'];
  const prepared = async () => {
    const l = await rolled();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
    const old = { state: readJson(statePath(dir)) };
    for (const name of names) old[name] = fs.readFileSync(statePath(dir, name));
    return { l, dir, old };
  };
  const asideOf = (dir) => fs.readdirSync(`${dir}/.verdikta-claim`).filter((n) => n.includes('.set-aside-'));

  // stopped while the copies are written: the second one fails
  {
    const { l, dir, old } = await prepared();
    const count = await w.claimCount();
    const real = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).includes('keys.json.set-aside-')) throw Object.assign(new Error('stopped'), { code: 'EIO' });
      return real(from, to);
    };
    try {
      await assert.rejects(late({ claimDir: dir, listingId: l.listingId, restart: true }), (e) => e.code === 'FILE_ERROR');
    } finally {
      fs.renameSync = real;
    }
    for (const name of names) assert.ok(fs.readFileSync(statePath(dir, name)).equals(old[name]), `${name} is where it was`);
    // the old hashes' claim is mined meanwhile: the folder still holds everything it needs, and it is adopted
    await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, old.state.archiveSha256, old.state.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.ciphertextSha256, old.state.ciphertextSha256, 'the claim of the old hashes, disclosed with its own files');
    assert.equal(await w.claimCount(), count + 1n);
  }
  // stopped after state.json is gone, before the others are removed
  {
    const { l, dir, old } = await prepared();
    const real = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (String(target).endsWith('/archive.zip')) throw Object.assign(new Error('stopped'), { code: 'EIO' });
      return real(target, options);
    };
    try {
      await assert.rejects(late({ claimDir: dir, listingId: l.listingId, restart: true }));
    } finally {
      fs.rmSync = real;
    }
    assert.equal(fs.existsSync(statePath(dir)), false, 'the folder holds no claim');
    const stamps = new Set(asideOf(dir).map((n) => n.split('.set-aside-')[1]));
    assert.equal(stamps.size, 1, 'one stamp');
    for (const name of names) assert.ok(fs.readFileSync(statePath(dir, `${name}.set-aside-${[...stamps][0]}`)).equals(old[name]), `${name}: the whole set, byte for byte`);
    // a run again starts over, and the set under that stamp is still whole
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed');
    assert.notEqual(r.ciphertextSha256, old.state.ciphertextSha256);
    for (const name of names) assert.ok(fs.readFileSync(statePath(dir, `${name}.set-aside-${[...stamps][0]}`)).equals(old[name]), `${name} after the run`);
  }
});

// Round 3: --restart starts over with new keys, so it is held to the same reads.
test('--restart while the same claim is mined in the middle of its checks: the keys stay', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  let other = null;
  const provider = injecting('send', async () => {
    other = await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
  }, (method) => method === 'eth_getLogs');
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
  const provider = injecting('send', async () => {
    await w.rpc('evm_revert', [snapshot]);
    await w.mine();
    moved = await send();
  }, (method) => method === 'eth_getLogs');
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

// ------------------------------------------------------------------------------------------------- the anchor

// A design review settled rounds 7 to 10 (R7-F1, R8-F1): a claim of a folder's hashes that a reorganization mined below
// the block the folder was prepared at. The bound of the log scan is proven, not guessed. At preparation, before any
// key is drawn, the folder saves an anchor in a file of its own: the head and the node's finalized block, each by
// number and hash. The folder's hashes do not exist before its keys do, so while the block at startBlock still has the
// saved hash, every claim of them is above it; and when it has another, a scan from the saved finalized block, held to
// its hash, is complete whatever happened above it. Where neither can be shown, a late claim is not signed.
const ANCHOR = 'anchor.json';
const anchorOf = (dir) => readJson(statePath(dir, ANCHOR));
const blockId = async (n) => {
  const b = await w.provider.getBlock(n);
  return { number: b.number, hash: b.hash };
};

/** A provider that names `at()` as the node's finalized block (the test chain names its own head); null: it names none. */
function finalizedAt(at, over = w.provider) {
  return new Proxy(over, {
    get(target, prop) {
      if (prop === 'send') {
        return async (method, params) => {
          if (method !== 'eth_getBlockByNumber' || params[0] !== 'finalized') return target.send(method, params);
          if (at() === null) throw Object.assign(new Error('invalid block tag: finalized'), { code: -32602 });
          return target.send(method, [`0x${at().toString(16)}`, params[1]]);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** A provider whose node refuses the logs of any range that starts below block `below()`, as one that keeps no older logs does. */
function noLogsBelow(below, over = w.provider) {
  return new Proxy(over, {
    get(target, prop) {
      if (prop === 'send') {
        return async (method, params) => {
          if (method === 'eth_getLogs' && Number(BigInt(params[0].fromBlock)) < below()) throw Object.assign(new Error('history unavailable'), { code: -32000 });
          return target.send(method, params);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * A folder prepared and left there (nothing signed), and the chain then rolled back under the block it was prepared
 * at: `gap` blocks under it, and above the block the node named as finalized. `finalized: 'none'`: the node named
 * none; 'head': it named its head, as the test chain does, so the rollback goes under that block too. With `claim`,
 * the same two hashes, sent by another client, are mined in the new fork's first block, below the old height; without
 * it a transaction of another wallet is, so that the fork is another one.
 */
async function rolledBackUnder({ make = rolled, lateClaim = true, claim = true, finalized = 'below', gap = 3 } = {}) {
  const l = await make();
  const dir = makeClaimDir();
  const finalizedBlock = await w.provider.getBlockNumber();
  await w.mine(2);
  const snapshot = await w.rpc('evm_snapshot');
  await w.mine(gap);
  const provider = finalized === 'head' ? w.provider : finalizedAt(() => (finalized === 'none' ? null : finalizedBlock));
  const crash = (step) => { if (step === 'prepare:saved') throw new Error('crash'); };
  await w.hunter({ provider, onStep: crash }).commit({ claimDir: dir, listingId: l.listingId, late: lateClaim, acknowledge: true }).catch(() => {});
  const saved = readJson(statePath(dir));
  assert.equal(saved.stage, 'prepared');
  const was = await blockId(saved.startBlock);
  await w.rpc('evm_revert', [snapshot]);
  let other = null;
  if (claim) {
    const price = await w.sa.commitPrice(l.listingId);
    other = await (await w.sa.connect(w.hunterWallet)[lateClaim ? 'lateClaim' : 'commit'](l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price })).wait();
    assert.ok(other.blockNumber < saved.startBlock, 'the claim is below the block the folder was prepared at');
  } else {
    await (await w.signers[8].sendTransaction({ to: w.signers[8].address, value: 0n })).wait();
  }
  return { l, dir, saved, other, finalizedBlock, was };
}

/** Mines until the chain is past the height the folder was prepared at, where another block now stands. */
async function pastStart({ saved, was }) {
  while (await w.provider.getBlockNumber() <= saved.startBlock) await w.mine();
  assert.notEqual((await blockId(saved.startBlock)).hash, was.hash, 'that height holds another block');
}

const unproven = (e) => e.code === 'START_UNPROVEN' && e.exitCode === 1
  && /Nothing was signed, pinned or set aside\./.test(e.message) && /in a new folder/.test(e.message) && /keys stay where they are/.test(e.message);

test('preparing a claim saves an anchor before any key is drawn: the head and the finalized block, by number and hash, in a file of its own', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  await w.mine(4);
  const finalizedBlock = (await w.provider.getBlockNumber()) - 3;
  let whenArchived = null;
  const onStep = (step) => {
    if (step === 'prepare:archive') whenArchived = { anchor: fs.existsSync(statePath(dir, ANCHOR)), keys: fs.existsSync(statePath(dir, 'keys.json')) };
  };
  await w.hunter({ provider: finalizedAt(() => finalizedBlock), onStep }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
  assert.deepEqual(whenArchived, { anchor: true, keys: false }, 'the anchor is on the disk before the keys exist');
  const saved = readJson(statePath(dir));
  assert.deepEqual(anchorOf(dir), { version: 1, head: await blockId(saved.startBlock), finalized: await blockId(finalizedBlock) });
  assert.equal(fs.statSync(statePath(dir, ANCHOR)).mode & 0o777, 0o600);
  // state.json holds none of it: a late claim's has `late`, and nothing else an ordinary commit's has not
  assert.deepEqual(Object.keys(saved), ['version', 'stage', 'chainId', 'contract', 'hunter', 'listingId', 'archiveSha256', 'ciphertextSha256', 'disclosureKey', 'startBlock', 'commitTx', 'late', 'claimId', 'ciphertextCid', 'discloseTx', 'told']);

  // a node that serves no finalized block: the head's alone, and the commit goes on
  const none = makeClaimDir();
  const r = await w.hunter({ provider: finalizedAt(() => null) }).commit({ claimDir: none, listingId: l.listingId, late: true, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.deepEqual(anchorOf(none), { version: 1, head: await blockId(readJson(statePath(none)).startBlock), finalized: null });

  // an ordinary commit's folder gets one too, on the test chain's own answer (its head)
  const open = await w.listing();
  const ordinary = makeClaimDir();
  await w.hunter().commit({ claimDir: ordinary, listingId: open.listingId, acknowledge: true });
  const start = await blockId(readJson(statePath(ordinary)).startBlock);
  assert.deepEqual(anchorOf(ordinary), { version: 1, head: start, finalized: start });
});

test('the chain rolled back under a prepared folder, above the finalized block it saved: the logs are read from that block, and a claim of its hashes below the old height is adopted with its own transaction', async () => {
  const adopted = async (c, run) => {
    const count = await w.claimCount();
    const heldNow = await w.provider.getBalance(w.address);
    const r = await run();
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, count, 'the claim that was there');
    assert.equal(r.commitTx, c.other.hash, 'with the transaction that made it');
    assert.deepEqual(readJson(statePath(c.dir)).commitTx, { hash: c.other.hash });
    assert.equal(await w.claimCount(), count, 'no second claim');
    assert.equal(await w.provider.getBalance(w.address), heldNow, 'no second bond');
  };
  // the chain past the old height again (R7-F1)
  {
    const c = await rolledBackUnder();
    assert.deepEqual(anchorOf(c.dir), { version: 1, head: c.was, finalized: await blockId(c.finalizedBlock) });
    await pastStart(c);
    await adopted(c, () => late({ claimDir: c.dir, listingId: c.l.listingId }));
  }
  // the head still below the height the folder was prepared at (R8-F2)
  {
    const c = await rolledBackUnder();
    assert.ok(await w.provider.getBlockNumber() < c.saved.startBlock, 'the chain is shorter than it was');
    await adopted(c, () => late({ claimDir: c.dir, listingId: c.l.listingId }));
  }
  // the claim more than one page of logs below the old height (R8-F1)
  {
    const c = await rolledBackUnder({ gap: 10 });
    assert.ok(c.saved.startBlock - c.other.blockNumber > 3);
    await pastStart(c);
    await adopted(c, () => w.hunter({ logPageBlocks: 3 }).commit({ claimDir: c.dir, listingId: c.l.listingId, late: true, acknowledge: true }));
  }
  // through an RPC that takes three blocks of logs at a time (R8-F3)
  {
    const c = await rolledBackUnder({ gap: 10 });
    await pastStart(c);
    w.logLimits.maxBlocks = 3;
    try {
      await adopted(c, () => late({ claimDir: c.dir, listingId: c.l.listingId }));
    } finally {
      w.logLimits.maxBlocks = null;
      w.logLimits.calls.length = 0;
    }
  }
  // and without --yes: it is read before anything is asked
  {
    const c = await rolledBackUnder();
    await pastStart(c);
    const count = await w.claimCount();
    const cli = await runCli(w, ['commit', c.dir, '--listing', String(c.l.listingId), '--late']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /^Late claim \d+ on listing \d+: disclosed\.$/m);
    assert.equal(await w.claimCount(), count);
    assert.deepEqual(readJson(statePath(c.dir)).commitTx, { hash: c.other.hash });
  }
});

test('the same rollback with no claim of the hashes on the chain: the scan from the finalized block is complete, so the late claim is signed', async () => {
  const c = await rolledBackUnder({ claim: false });
  await pastStart(c);
  const count = await w.claimCount();
  const r = await late({ claimDir: c.dir, listingId: c.l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.ciphertextSha256, c.saved.ciphertextSha256, 'the prepared hashes');
  assert.equal(await w.claimCount(), count + 1n);
  assert.deepEqual(await eventsOf(r.commitTx), ['LateClaim']);
});

test('--restart --late against a claim of the folder\'s hashes below the old height: RESTART_REFUSED with the keys in place and nothing paid, while it is open and once it has expired', async () => {
  for (const expired of [false, true]) {
    const c = await rolledBackUnder();
    await pastStart(c);
    const claimId = await w.claimCount();
    if (expired) {
      await w.increase(await w.sa.DISCLOSE_WINDOW());
      await (await w.sa.expire(claimId)).wait();
      assert.equal(Number((await w.sa.getClaim(claimId)).state), 6, 'Expired: no queue of open claims holds it, the logs do');
    }
    const keys = fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8');
    const m = await mark();
    const err = await late({ claimDir: c.dir, listingId: c.l.listingId, restart: true }).catch((e) => e);
    assert.equal(err.code, 'RESTART_REFUSED', `expired ${expired}: ${err.message}`);
    assert.equal(fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8'), keys, 'the active keys');
    assert.deepEqual(fs.readdirSync(`${c.dir}/.verdikta-claim`).filter((n) => n.includes('.set-aside-')), [], 'nothing was set aside');
    await assertNothingSent(m, null, `expired ${expired}`);
    const now = readJson(statePath(c.dir));
    assert.equal(now.claimId, String(claimId));
    assert.deepEqual(now.commitTx, { hash: c.other.hash });
  }
});

test('where nothing proves the bound, a late claim is not signed and --restart --late sets nothing aside: START_UNPROVEN says why and what to do', async () => {
  // (a run removes the lock a killed one left: every other file of the folder is what it was)
  const filesOf = (dir) => fs.readdirSync(`${dir}/.verdikta-claim`).filter((n) => !n.startsWith('lock.')).sort();
  const refused = async (c, why, { provider, says } = {}) => {
    const files = filesOf(c.dir);
    const keys = fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8');
    // with --yes, with --restart, and with neither: no terms are said for a late claim that would not be signed
    for (const [restart, acknowledge] of [[false, true], [true, true], [false, false]]) {
      const m = await mark();
      const err = await w.hunter(provider ? { provider } : {}).commit({ claimDir: c.dir, listingId: c.l.listingId, late: true, restart, acknowledge }).catch((e) => e);
      assert.ok(unproven(err), `${why}, restart ${restart}, --yes ${acknowledge}: ${err.code}: ${err.message}`);
      if (says) assert.match(err.message, says, why);
      await assertNothingSent(m, null, why);
      assert.equal(readJson(statePath(c.dir)).commitTx ?? null, null, 'nothing was signed');
      assert.deepEqual(filesOf(c.dir), files, 'nothing was set aside');
      assert.equal(fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8'), keys, 'the keys stay where they are');
    }
  };
  // a folder with no anchor (one an earlier version prepared), and a real rollback under it
  {
    const c = await rolledBackUnder({ claim: false });
    fs.rmSync(statePath(c.dir, ANCHOR));
    await pastStart(c);
    await refused(c, 'no anchor');
  }
  // the node named no finalized block when the folder was prepared, and the chain was rolled back under it
  {
    const c = await rolledBackUnder({ claim: false, finalized: 'none' });
    assert.equal(anchorOf(c.dir).finalized, null);
    await pastStart(c);
    await refused(c, 'no finalized block saved');
  }
  // the rollback went under the finalized block the folder saved (the test chain names its head as finalized)
  {
    const c = await rolledBackUnder({ claim: false, finalized: 'head' });
    assert.deepEqual(anchorOf(c.dir).finalized, c.was);
    await pastStart(c);
    await refused(c, 'the finalized block is gone');
  }
  // the finalized block stands, and the node does not give the logs between it and the old height: the scan that
  // would prove the bound cannot be read through, and the logs above prove nothing
  {
    const c = await rolledBackUnder({ claim: false });
    await pastStart(c);
    const provider = noLogsBelow(() => c.saved.startBlock);
    await refused(c, 'the scan cannot be read through', { provider, says: /could not all be read/ });
    // the same folder through a node that gives them: the scan is complete, and the late claim is signed
    const count = await w.claimCount();
    assert.equal((await late({ claimDir: c.dir, listingId: c.l.listingId })).ciphertextSha256, c.saved.ciphertextSha256);
    assert.equal(await w.claimCount(), count + 1n);
  }
  // and where that unread stretch holds the claim, it is still not signed beside it
  {
    const c = await rolledBackUnder();
    await pastStart(c);
    await refused(c, 'the claim is in the stretch that cannot be read', { provider: noLogsBelow(() => c.saved.startBlock), says: /could not all be read/ });
  }
  // an anchor that does not name the block state.json says the folder was prepared at
  {
    const l = await rolled();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
    const anchor = anchorOf(dir);
    fs.writeFileSync(statePath(dir, ANCHOR), `${JSON.stringify({ ...anchor, head: { ...anchor.head, number: anchor.head.number - 1 } }, null, 2)}\n`, { mode: 0o600 });
    await refused({ l, dir }, 'another head');
  }
  // and a folder with no anchor is refused with nothing reorganized under it too: it cannot show that
  {
    const l = await rolled();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
    fs.rmSync(statePath(dir, ANCHOR));
    await refused({ l, dir }, 'no anchor, no rollback');
    // a new folder with the same claim files is the way on
    const fresh = makeClaimDir();
    assert.equal((await late({ claimDir: fresh, listingId: l.listingId })).stage, 'disclosed');
  }
});

test('an ordinary commit is never refused for its anchor: without one it resumes and restarts as it did, and with one --restart finds a commit below the old height', async () => {
  // no anchor, the chain rolled back under the folder: a resume signs, as it always did
  {
    const c = await rolledBackUnder({ make: () => w.listing(), lateClaim: false, claim: false });
    fs.rmSync(statePath(c.dir, ANCHOR));
    await pastStart(c);
    const count = await w.claimCount();
    const r = await w.hunter().commit({ claimDir: c.dir, listingId: c.l.listingId, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.ciphertextSha256, c.saved.ciphertextSha256);
    assert.equal(await w.claimCount(), count + 1n);
  }
  // no anchor, and --restart: new keys, as it always did
  {
    const c = await rolledBackUnder({ make: () => w.listing(), lateClaim: false, claim: false });
    fs.rmSync(statePath(c.dir, ANCHOR));
    await pastStart(c);
    const count = await w.claimCount();
    const r = await w.hunter().commit({ claimDir: c.dir, listingId: c.l.listingId, restart: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.notEqual(r.ciphertextSha256, c.saved.ciphertextSha256);
    assert.equal(await w.claimCount(), count + 1n);
  }
  // an anchor, a rollback, and a node that does not give the logs below the old height: --restart goes on as it did
  {
    const c = await rolledBackUnder({ make: () => w.listing(), lateClaim: false, claim: false });
    await pastStart(c);
    const count = await w.claimCount();
    const provider = noLogsBelow(() => c.saved.startBlock);
    const r = await w.hunter({ provider }).commit({ claimDir: c.dir, listingId: c.l.listingId, restart: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.notEqual(r.ciphertextSha256, c.saved.ciphertextSha256);
    assert.equal(await w.claimCount(), count + 1n);
  }
  // an anchor that proves the bound, and the folder's own commit below the old height: --restart is refused, the keys stay
  {
    const c = await rolledBackUnder({ make: () => w.listing(), lateClaim: false });
    await pastStart(c);
    const count = await w.claimCount();
    const keys = fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8');
    await assert.rejects(w.hunter().commit({ claimDir: c.dir, listingId: c.l.listingId, restart: true, acknowledge: true }), (e) => e.code === 'RESTART_REFUSED');
    assert.equal(fs.readFileSync(statePath(c.dir, 'keys.json'), 'utf8'), keys);
    assert.equal(await w.claimCount(), count);
    assert.deepEqual(readJson(statePath(c.dir)).commitTx, { hash: c.other.hash });
  }
});

test('an ordinary commit on a fresh folder, through an RPC that takes three blocks of logs: its log requests are what they were, one range from the block it was prepared at', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.mine(6);
  w.logLimits.maxBlocks = 3;
  w.logLimits.calls.length = 0;
  try {
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    const saved = readJson(statePath(dir));
    const asked = w.logLimits.calls.filter((c) => c.fromBlock !== undefined);
    assert.equal(asked.length, 1, 'one request for logs');
    assert.equal(asked[0].refused, false);
    assert.equal(asked[0].fromBlock, saved.startBlock);
    assert.ok(asked[0].blocks <= 3);
    assert.deepEqual(Object.keys(saved), ['version', 'stage', 'chainId', 'contract', 'hunter', 'listingId', 'archiveSha256', 'ciphertextSha256', 'disclosureKey', 'startBlock', 'commitTx', 'claimId', 'ciphertextCid', 'discloseTx', 'told']);
  } finally {
    w.logLimits.maxBlocks = null;
    w.logLimits.calls.length = 0;
  }
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
