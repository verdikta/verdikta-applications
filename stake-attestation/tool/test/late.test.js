// Node P43 (issue #230): a late claim from the hunter's tool, `verdikta-attest commit <claim-dir> --listing <id> --late`
// (design §13.2, decision D6). The contract takes one on a listing whose stake has ended (Rolled, or Closed after it
// opened) or that its maker holds (node P39): commit-shaped, judged, recorded under the record's `later`, no award.
//
// The change is additive. A late claim is an ordinary commit's flow with what --late itself adds:
//
//   - it calls lateClaim with the archive commitments a commit sends, then pins and discloses as one does;
//   - without --yes it sends nothing, and says the terms, the price and its three warnings;
//   - the wrong kind for the listing is refused before anything is pinned or sent, either way round;
//   - --restart never starts a late claim over: a changed one goes in a new folder;
//   - the price it signs is the price its notice quoted;
//   - a prepared late claim whose two hashes already have a claim on the chain is found before the listing is asked;
//   - status, reveal, claim and appeal work on it, and status says it is a late claim with no award;
//   - a stopped run goes on with what the folder holds, with --late or without it.
//
// And an ordinary commit does, sends and says what it did: the first tests below hold that.
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
import * as notices from '../src/notices.js';
import { closeRpc, readJson, rpcOf, runCli, statePath } from './helpers/cli.js';
import { JUSTIFICATION_CID, codeReview, makeClaimDir, makeWorld, sha256, vectorOf } from './helpers/world.js';

const CHILD = fileURLToPath(new URL('./helpers/lateChild.js', import.meta.url));
const iface = new ethers.Interface(STAKE_ATTESTATION_ABI);
const eth = (wei) => `${ethers.formatEther(wei)} ETH`;
const LONG = { stake: { fixWindowDays: 14, disclosureGraceHours: 48 } };
const FILES = ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json'];

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

/** The folder's four files, byte for byte: what a refusal must not touch. */
const filesOf = (dir) => Object.fromEntries(FILES.map((f) => [f, fs.existsSync(statePath(dir, f)) ? fs.readFileSync(statePath(dir, f)).toString('base64') : null]));

const eventsOf = async (hash) => (await w.provider.getTransactionReceipt(hash)).logs.map((x) => iface.parseLog(x)?.name);
/** A late claim sent in full: `commit --late --yes`. */
const late = (o) => w.hunter().commit({ late: true, acknowledge: true, ...o });

const TOPIC_NAMES = new Map(['Committed', 'LateClaim'].map((name) => [iface.getEvent(name).topicHash, name]));

/**
 * The world's provider, keeping what goes through it to the contract, in order: each read and estimate by the
 * function's name, each log search by the events it asks for, each transaction sent by the function it calls.
 */
function recorded() {
  const seen = [];
  const nameOf = (data) => iface.getFunction(String(data ?? '').slice(0, 10))?.name ?? '?';
  const ours = (tx) => String(tx?.to ?? '').toLowerCase() === w.address.toLowerCase();
  const provider = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'call' || prop === 'estimateGas') {
        return async (tx, ...rest) => {
          if (ours(tx)) seen.push(`${prop === 'call' ? 'read' : 'estimate'} ${nameOf(tx.data)}`);
          return target[prop](tx, ...rest);
        };
      }
      if (prop === 'getLogs') {
        return async (filter) => {
          seen.push(`logs ${[filter.topics[0]].flat().map((t) => TOPIC_NAMES.get(t) ?? t).join('|')}`);
          return target.getLogs(filter);
        };
      }
      if (prop === 'broadcastTransaction') {
        return async (raw) => {
          seen.push(`send ${nameOf(ethers.Transaction.from(raw).data)}`);
          return target.broadcastTransaction(raw);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { provider, seen };
}

// --------------------------------------------------------------------------------- an ordinary commit is as it was

// What an ordinary commit asks of the contract and sends to it, in order, on the base this change was made on
// (claude/stake-attestation at d0bb1f2). Recorded there with recorded(), before anything of --late was written.
const ORDINARY_COMMIT_CALLS = Object.freeze([
  'read getListing', 'read artifactHashOf', 'read commitPrice', 'read acceptsCommits', 'read isAllowed',
  'logs Committed', 'read commitPrice', 'read acceptsCommits', 'read isAllowed', 'estimate commit', 'send commit',
  'read getClaim', 'read getClaim', 'read claimTimes', 'estimate disclose', 'send disclose',
  'read getClaim', 'read getClaim', 'read claimTimes', 'read getListing', 'read claimState',
]);

test('an ordinary commit asks the contract what it asked and sends what it sent, in the same order: nothing of a late claim is read or looked for', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const price = await w.sa.commitPrice(l.listingId);
  const said = [];
  const { provider, seen } = recorded();
  const r = await w.hunter({ provider, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.deepEqual(seen, [...ORDINARY_COMMIT_CALLS]);
  assert.ok(!seen.some((s) => /acceptsLateClaims|lateClaim|LateClaim/.test(s)), 'no read of the late claim\'s rule, and no search for its event');

  // the call, the value and the event
  const tx = await w.provider.getTransaction(r.commitTx);
  assert.equal(tx.data, iface.encodeFunctionData('commit', [l.listingId, sha256(fs.readFileSync(statePath(dir, 'archive.zip'))), sha256(fs.readFileSync(statePath(dir, 'ciphertext.age')))]));
  assert.equal(tx.value, price);
  assert.equal(tx.to, w.address);
  assert.deepEqual(await eventsOf(r.commitTx), ['Committed']);
  assert.equal((await w.sa.getClaim(r.claimId)).late, false);

  // what it returns and saves, key for key: no `late` anywhere
  assert.deepEqual(Object.keys(r), ['stage', 'claimId', 'listingId', 'archiveSha256', 'ciphertextSha256', 'ciphertextCid', 'valueWei', 'bondWei', 'prepayWei', 'discloseDeadline', 'revealableAt', 'revealDeadline', 'revealDeadlineEarliest', 'waitsFor', 'commitTx', 'discloseTx']);
  assert.deepEqual(Object.keys(readJson(statePath(dir))), ['version', 'stage', 'chainId', 'contract', 'hunter', 'listingId', 'archiveSha256', 'ciphertextSha256', 'disclosureKey', 'startBlock', 'commitTx', 'claimId', 'ciphertextCid', 'discloseTx', 'told']);

  // what it says before it pays: one notice, the one commitNotice makes of the listing's terms, with no word of a late claim
  assert.equal(said.length, 2, 'the terms, and the warning that report.md has no Requirement section');
  assert.match(said[0], /^Awards: /m);
  assert.match(said[0], /^This commit sends /m);
  assert.match(said[0], /No other claim on this listing is open now, so a commit sent now would be first in commit order\./);
  assert.doesNotMatch(said.join('\n'), /late claim/i);
  assert.match(said[1], /^NO_REQUIREMENT_SECTION: /);
});

test('an ordinary commit prints what it printed: the CLI\'s lines for a commit and for its status name no kind', async () => {
  const l = await w.listing(LONG);
  const dir = makeClaimDir();
  const cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(cli.code, 0, cli.stderr);
  const { claimId } = readJson(statePath(dir));
  assert.match(cli.stdout, new RegExp(`^Claim ${claimId} on listing ${l.listingId}: disclosed\\.\\nPaid [^\\n]+\\narchive sha256 0x[0-9a-f]{64}\\nciphertext sha256 0x[0-9a-f]{64}\\nciphertext CID \\S+\\nRevealable at `, 'm'));
  assert.doesNotMatch(cli.stdout, /late claim/i);
  const json = JSON.parse((await runCli(w, ['commit', dir, '--json'])).stdout);
  assert.equal(Object.hasOwn(json, 'late'), false, 'and --json holds the keys it held');
  const status = await runCli(w, ['status', dir]);
  assert.match(status.stdout, new RegExp(`^Claim ${claimId} on listing ${l.listingId}: Committed, disclosed, in its fix window$`, 'm'));
  assert.doesNotMatch(status.stdout, /late claim/i);
});

test('an ordinary commit signs the live price as it always did, whatever moved since its terms were said', async () => {
  try {
    const l = await w.listing();
    const quoted = await w.sa.commitPrice(l.listingId);
    const onStep = async (step) => {
      if (step === 'prepare:saved') await (await w.aggregator.setFeeMultiplier(5n)).wait();
    };
    const r = await w.hunter({ onStep }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true });
    const price = await w.sa.commitPrice(l.listingId);
    assert.ok(price > quoted);
    assert.equal((await w.provider.getTransaction(r.commitTx)).value, price, 'the price read as it signed');
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('--restart on an ordinary commit\'s prepared folder starts it over as it did: new keys, one claim', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const crash = (step) => {
    if (step === 'prepare:saved') throw new Error('stop');
  };
  await w.hunter({ onStep: crash }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false, 'a commit\'s prepared folder names no kind');
  const count = await w.claimCount();
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true, restart: true });
  assert.equal(r.stage, 'disclosed');
  assert.notEqual(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys);
  assert.equal(await w.claimCount(), count + 1n);
});

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
  const { provider, seen } = recorded();
  const r = await w.hunter({ provider, onStep }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.deepEqual(steps, [...COMMIT_STEPS], 'the steps of a commit, in a commit\'s order');
  assert.equal(uploadsWhenMined, uploads, 'nothing is pinned before the late claim is mined');
  assert.deepEqual(seen.filter((s) => s.startsWith('send ')), ['send lateClaim', 'send disclose']);
  assert.ok(!seen.includes('read isAllowed'), 'a late claim has no allowlist');

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
  for (const f of FILES) assert.equal(fs.statSync(statePath(dir, f)).mode & 0o777, 0o600, f);

  // recorded under `later`: never one of the stake's own claims, never pending
  const on = await w.sa.getListing(l.listingId);
  assert.equal(on.lateClaims, 1n);
  assert.equal(on.claimsCommitted, 0n);
  assert.equal(on.pendingClaims, 0n);
  assert.equal(readJson(statePath(dir)).late, true, 'the folder says what kind of claim it holds');
});

// ------------------------------------------------------------------------------------------------ without --yes

test('commit --late without --yes sends nothing: the terms, the price, no award, the bond forfeited on INVALID, the prepay spent on the evaluation', async () => {
  const l = await rolled(LONG);
  const dir = makeClaimDir();
  const m = await mark();
  const said = [];
  await assert.rejects(w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT' && e.exitCode === 3);
  await assertNothingSent(m, dir, 'the library');
  const text = said.join('\n');
  const price = await w.sa.commitPrice(l.listingId);
  const on = await w.sa.getListing(l.listingId);

  // the price, as the contract quotes it now
  assert.ok(text.includes(`This late claim sends ${eth(price)}: the bond ${eth(on.bondWei)} and the prepay ${eth(price - on.bondWei)}, the live maximum fee.`), text);
  // the three warnings, said plainly, each word for word
  assert.equal(notices.LATE_CLAIM_WARNINGS.length, 3);
  assert.match(notices.LATE_CLAIM_WARNINGS[0], /^A late claim pays no award\b/);
  assert.match(notices.LATE_CLAIM_WARNINGS[1], /^The bond is forfeited on INVALID\b/);
  assert.match(notices.LATE_CLAIM_WARNINGS[2], /^The prepay is spent on the evaluation\b/);
  for (const line of notices.LATE_CLAIM_WARNINGS) assert.ok(text.includes(`- ${line}`), line);
  // the terms: who reads the proof first, the listing, its windows, where the claim stands in commit order
  assert.ok(text.includes(LISTING_WARNING.proofFirst));
  assert.ok(text.includes(LISTING_WARNING.elsewhere));
  assert.match(text, new RegExp(`^Listing ${l.listingId} \\(Rolled, its stake rolled forward to listing ${l.successor}\\): `, 'm'));
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
  for (const line of notices.LATE_CLAIM_WARNINGS) assert.ok(dry.stdout.includes(line), line);
  assert.ok(dry.stdout.includes(`This late claim sends ${eth(price)}`));
  assert.match(dry.stderr, /^verdikta-attest: NEEDS_ACKNOWLEDGEMENT: /);
  await assertNothingSent(m, dir, 'the CLI');
  assert.equal(fs.existsSync(statePath(dir)), false, 'a dry run saves no state');
});

test('the third warning allows for a refund that finalize could not make: it comes back when anyone calls recoverLeftoverEth', async () => {
  assert.match(notices.LATE_CLAIM_WARNINGS[2], /comes back when the round is finalized or, if the refund fails then, when anyone calls recoverLeftoverEth\(wallet\) on the contract, with the wallet of that round\.$/);
  // the contract does that: a round whose refund fails at finalize keeps the money in its wallet, and the call pays it
  const l = await rolled();
  const dir = makeClaimDir();
  const { claimId } = await late({ claimDir: dir, listingId: l.listingId });
  await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  const c = await w.sa.getClaim(claimId);
  const unspent = 1000n;
  await (await w.aggregator.setRefundAmount(unspent)).wait();
  await (await w.aggregator.setWithdrawBroken(true)).wait();
  try {
    await (await w.aggregator.scriptResult(c.requestId, vectorOf('DUPLICATE'), JUSTIFICATION_CID)).wait();
    const rc = await (await w.sa.finalize(claimId)).wait();
    assert.ok(rc.logs.map((x) => iface.parseLog(x)?.name).includes('RefundDeferred'), 'finalize deferred the refund');
  } finally {
    await (await w.aggregator.setWithdrawBroken(false)).wait();
    await (await w.aggregator.setRefundAmount(0n)).wait();
  }
  const before_ = await w.provider.getBalance(w.hunterWallet.address);
  await (await w.sa.connect(w.signers[9]).recoverLeftoverEth(c.evalWallet)).wait();
  assert.equal(await w.provider.getBalance(w.hunterWallet.address) - before_, unspent, 'anyone\'s call pays the hunter what the round did not spend');
});

test('a late claim is open to every hunter, and on an invited listing the notice says so', async () => {
  const l = await closed({ allowlist: [w.signers[7].address] });
  const dir = makeClaimDir();
  const said = [];
  await assert.rejects(w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.match(said.join('\n'), /invited[^\n]*a late claim is open to every hunter/);
  assert.match(said.join('\n'), new RegExp(`^Listing ${l.listingId} \\(Closed\\): `, 'm'));
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
  const err = await w.hunter().commit({ claimDir: makeClaimDir(), listingId: unfunded.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(err.code, 'LISTING_NOT_ACCEPTING');
  assert.equal(err.message, `This listing takes no commits now. Listing ${unfunded.listingId}.`);
});

test('an RPC that does not answer whether the listing takes late claims is said as that; a lens that cannot say leaves the refusal a commit always had', async () => {
  const l = await rolled();
  const selector = iface.getFunction('acceptsLateClaims').selector;
  const failing = (message) => new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'call') {
        return async (tx, ...rest) => {
          if (String(tx?.data ?? '').startsWith(selector)) throw new Error(message);
          return target.call(tx, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const m = await mark();
  for (const lateFlag of [false, true]) {
    const down = await w.hunter({ provider: failing('socket hang up') }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, late: lateFlag, acknowledge: true }).catch((e) => e);
    assert.equal(down.code, 'RPC_UNAVAILABLE', `late ${lateFlag}`);
  }
  const noLens = await w.hunter({ provider: failing('execution reverted: unknown function') }).commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(noLens.code, 'LISTING_NOT_ACCEPTING');
  await assertNothingSent(m, null, 'either way');
});

test('the contract\'s own refusal of a late claim is on the allow-list, the only text repeated from a failure', () => {
  assert.ok(KNOWN_REVERTS.includes('not accepting late claims'));
  const logic = fs.readFileSync(new URL('../../onchain/contracts/libraries/ClaimLogic.sol', import.meta.url), 'utf8');
  assert.match(logic, /\|\| listingHeld,\s*"not accepting late claims"\s*\);/, 'ClaimLogic.commit says it, on a line of its own');
});

// ------------------------------------------------------------------------------------------------- --late --restart

/** A folder a late run prepared and then stopped in: keys drawn, state saved, nothing signed. */
async function preparedLate(make = rolled) {
  const l = await make();
  const dir = makeClaimDir();
  assert.equal((await child(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  assert.equal(saved.stage, 'prepared');
  assert.equal(saved.late, true, 'a prepared late claim says so');
  return { l, dir, saved };
}

test('commit --late --restart is refused before anything is deleted, pinned or sent, with a text that says a changed late claim goes in a new folder', async () => {
  assert.match(ERROR_TEXTS.LATE_NEEDS_NEW_FOLDER, /a changed late claim goes in a new folder/);
  assert.match(ERROR_TEXTS.LATE_NEEDS_NEW_FOLDER, /nothing in it was deleted, and nothing was pinned or sent\.$/);

  // a folder with nothing in it yet
  {
    const l = await rolled();
    const dir = makeClaimDir();
    const m = await mark();
    const err = await late({ claimDir: dir, listingId: l.listingId, restart: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_NEEDS_NEW_FOLDER');
    assert.equal(err.exitCode, 1);
    await assertNothingSent(m, dir, 'an empty folder');
  }

  // a folder that holds a prepared late claim: with the flag, and without it
  {
    const { l, dir } = await preparedLate();
    const m = await mark();
    const kept = filesOf(dir);
    for (const lateFlag of [true, false]) {
      const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true, restart: true }).catch((e) => e);
      assert.equal(err.code, 'LATE_NEEDS_NEW_FOLDER', `late ${lateFlag}: ${err.message}`);
      assert.deepEqual(filesOf(dir), kept, `late ${lateFlag}: every file is as it was, the keys among them`);
      await assertNothingSent(m, null, `late ${lateFlag}`);
    }
    // the CLI, with its code and fixed text
    const cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late', '--restart', '--yes']);
    assert.equal(cli.code, 1, cli.stdout);
    assert.ok(cli.stderr.startsWith(`verdikta-attest: LATE_NEEDS_NEW_FOLDER: ${ERROR_TEXTS.LATE_NEEDS_NEW_FOLDER}`), cli.stderr);
    assert.deepEqual(filesOf(dir), kept);
    await assertNothingSent(m, null, 'the CLI');
    // and the folder is whole: the same run without --restart files the claim with the keys it had
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed');
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json')).toString('base64'), kept['keys.json']);
  }

  // a folder an ordinary commit prepared, on a listing its maker then held: --late does not start that one over either
  {
    const l = await w.listing();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved', { ordinary: true })).signal, 'SIGKILL');
    await (await asMaker().hold(l.listingId)).wait();
    const m = await mark();
    const kept = filesOf(dir);
    const err = await late({ claimDir: dir, listingId: l.listingId, restart: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_NEEDS_NEW_FOLDER');
    assert.deepEqual(filesOf(dir), kept);
    await assertNothingSent(m, null, 'a commit\'s prepared folder');
  }

  // a signed late claim: the same refusal, which says how to go on with it (a commit's RESTART_REFUSED says
  // "--restart only works before that", which is not so for a late claim)
  {
    const l = await rolled();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'commit:signed')).signal, 'SIGKILL');
    const kept = filesOf(dir);
    for (const lateFlag of [true, false]) {
      const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true, restart: true }).catch((e) => e);
      assert.equal(err.code, 'LATE_NEEDS_NEW_FOLDER', `late ${lateFlag}`);
      assert.match(err.message, /a changed late claim goes in a new folder/);
      assert.match(err.message, /This folder's late claim is signed or on the chain: run commit again without --restart to go on with that one\.$/);
      assert.deepEqual(filesOf(dir), kept);
    }
    assert.equal((await w.hunter().commit({ claimDir: dir, listingId: l.listingId })).late, true, 'and without --restart it goes on');
  }

  // a signed commit, with --late or without it: --restart is refused as it always was
  {
    const l = await w.listing();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'commit:signed', { ordinary: true })).signal, 'SIGKILL');
    const kept = filesOf(dir);
    for (const lateFlag of [true, false]) {
      const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true, restart: true }).catch((e) => e);
      assert.equal(err.code, 'RESTART_REFUSED', `late ${lateFlag}`);
      assert.equal(err.message, ERROR_TEXTS.RESTART_REFUSED);
      assert.deepEqual(filesOf(dir), kept);
    }
  }
});

test('a commit\'s prepared folder that a late run takes over is a late claim\'s from then on, signed or not: --restart no longer starts it over', async () => {
  try {
    const l = await w.listing();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved', { ordinary: true })).signal, 'SIGKILL');
    assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false, 'a commit\'s prepared folder');
    await (await asMaker().hold(l.listingId)).wait();
    const m = await mark();
    // the late run has its --yes, and stops before it signs: the price changes after its terms are said
    let searches = 0;
    const provider = new Proxy(w.provider, {
      get(target, prop) {
        if (prop === 'getLogs') {
          return async (filter) => {
            searches += 1;
            if (searches === 2) await (await w.aggregator.setFeeMultiplier(5n)).wait();
            return target.getLogs(filter);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await assert.rejects(w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }), (e) => e.code === 'LATE_PRICE_CHANGED');
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    assert.equal(saved.late, true, 'the folder says it holds a late claim');
    assert.equal(saved.commitTx ?? null, null, 'nothing was signed');
    // --restart, with no flag, is refused as for any late claim, and nothing is removed
    const kept = filesOf(dir);
    await assert.rejects(w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true, restart: true }), (e) => e.code === 'LATE_NEEDS_NEW_FOLDER');
    assert.deepEqual(filesOf(dir), kept);
    await assertNothingSent(m, null, 'the takeover and the refusal');
    // and a run with no flag files the late claim, with the keys the folder had
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
    assert.equal(r.late, true);
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json')).toString('base64'), kept['keys.json']);
    assert.equal(await w.claimCount(), m.claims + 1n);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('a late claim whose files changed is told to use a new folder, and nothing is signed', async () => {
  const { l, dir } = await preparedLate();
  const m = await mark();
  fs.appendFileSync(`${dir}/report.md`, '\nOne more line.\n');
  for (const lateFlag of [true, false]) {
    const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_INPUTS_CHANGED', `late ${lateFlag}`);
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /Restore them, or prepare the changed claim in a new folder/);
    assert.doesNotMatch(err.message, /--restart/, 'no word of --restart, which never starts a late claim over');
  }
  await assertNothingSent(m, null, 'changed files');
  // an edit that leaves a file the arbiters would refuse, or takes one away, is said the same way: the texts that say
  // to fix a file in place are no way on for a prepared late claim (R4-F2)
  for (const [name, spoil] of [
    ['report.md emptied', (d) => fs.writeFileSync(`${d}/report.md`, '')],
    ['poc.patch removed', (d) => fs.rmSync(`${d}/poc.patch`)],
    ['finding.json no longer JSON', (d) => fs.writeFileSync(`${d}/finding.json`, '{')],
    ['poc.patch no longer a patch', (d) => fs.writeFileSync(`${d}/poc.patch`, 'not a patch\n')],
  ]) {
    const p = await preparedLate();
    const kept = filesOf(p.dir);
    spoil(p.dir);
    for (const lateFlag of [true, false]) {
      const err = await w.hunter().commit({ claimDir: p.dir, listingId: p.l.listingId, late: lateFlag, acknowledge: true }).catch((e) => e);
      assert.equal(err.code, 'LATE_INPUTS_CHANGED', `${name}, late ${lateFlag}: ${err.message}`);
      assert.equal(err.message, ERROR_TEXTS.LATE_INPUTS_CHANGED, name);
    }
    assert.deepEqual(filesOf(p.dir), kept, `${name}: the prepared files are as they were`);
  }
  await assertNothingSent(m, null, 'spoiled files');
  // a late claim with nothing prepared yet is checked as any claim is: there is nothing to restore
  const fresh = await rolled();
  const bad = makeClaimDir({ report: '' });
  await assert.rejects(late({ claimDir: bad, listingId: fresh.listingId }), (e) => e.code === 'REPORT_INVALID');
  // an ordinary commit's refusal is the one it was, code and text
  assert.equal(ERROR_TEXTS.INPUTS_CHANGED, 'The claim files changed since this commit was prepared, and nothing has been signed. Restore them, or pass --restart to draw new keys for the new files.');
  const o = await w.listing();
  const odir = makeClaimDir();
  assert.equal((await child(odir, o.listingId, 'prepare:saved', { ordinary: true })).signal, 'SIGKILL');
  fs.appendFileSync(`${odir}/report.md`, '\nOne more line.\n');
  const oerr = await w.hunter().commit({ claimDir: odir, listingId: o.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(oerr.code, 'INPUTS_CHANGED');
  assert.equal(oerr.message, ERROR_TEXTS.INPUTS_CHANGED);
  // and in the order it was: a prepared commit whose report is emptied is told the report is invalid, first
  fs.writeFileSync(`${odir}/report.md`, '');
  const first = await w.hunter().commit({ claimDir: odir, listingId: o.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(first.code, 'REPORT_INVALID');
});

// ------------------------------------------------------------------------------------------- the price it signs

test('the price a late claim signs is the price its notice quoted: a price that changed stops the run before anything is signed, and says the new amount', async () => {
  try {
    const l = await rolled();
    const dir = makeClaimDir();
    const m = await mark();
    const quoted = await w.sa.commitPrice(l.listingId);
    const said = [];
    const steps = [];
    const onStep = async (step) => {
      steps.push(step);
      if (step === 'prepare:saved') await (await w.aggregator.setFeeMultiplier(5n)).wait();
    };
    const err = await w.hunter({ onStep, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    const price = await w.sa.commitPrice(l.listingId);
    assert.ok(price > quoted);
    assert.equal(err.code, 'LATE_PRICE_CHANGED', err.message);
    assert.equal(err.exitCode, 1);
    assert.ok(err.message.includes(`It is ${eth(price)} now, not ${eth(quoted)}.`), err.message);
    assert.match(err.message, /nothing was signed or sent/);
    assert.ok(said.some((t) => t.includes(`This late claim sends ${eth(quoted)}: the bond`)), 'the terms named the first price');
    assert.ok(!steps.includes('commit:signed'), 'nothing was signed');
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    assert.equal(saved.commitTx ?? null, null);
    assert.equal(await w.claimCount(), m.claims);
    assert.equal(w.ipfs.uploads.length, m.uploads);
    assert.equal(await w.provider.getTransactionCount(w.hunterWallet.address), m.nonce);

    // the next run says the new price, and with --yes signs exactly that, with the keys it drew
    const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
    const again = [];
    const r = await w.hunter({ onNotice: (t) => again.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.ok(again.some((t) => t.includes(`This late claim sends ${eth(price)}: the bond`)));
    assert.equal((await w.provider.getTransaction(r.commitTx)).value, price);
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys);
    assert.equal(await w.claimCount(), m.claims + 1n);

    // a price that fell stops it the same way: the amount printed is the amount sent, or nothing is
    const l2 = await rolled();
    const down = async (step) => {
      if (step === 'prepare:saved') await (await w.aggregator.setFeeMultiplier(4n)).wait();
    };
    await assert.rejects(w.hunter({ onStep: down }).commit({ claimDir: makeClaimDir(), listingId: l2.listingId, late: true, acknowledge: true }), (e) => e.code === 'LATE_PRICE_CHANGED');
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('a price that rises after it was read again, and is met at the gas estimate, is still said as the new price, and nothing is signed', async () => {
  try {
    const l = await rolled();
    const dir = makeClaimDir();
    const m = await mark();
    const quoted = await w.sa.commitPrice(l.listingId);
    const selector = iface.getFunction('lateClaim').selector;
    let raised = false;
    const steps = [];
    // the fee moves between the price read as it signs and the estimate: the contract refuses the quoted value
    const provider = new Proxy(w.provider, {
      get(target, prop) {
        if (prop === 'estimateGas') {
          return async (tx, ...rest) => {
            if (!raised && String(tx?.data ?? '').startsWith(selector)) {
              raised = true;
              await (await w.aggregator.setFeeMultiplier(5n)).wait();
            }
            return target.estimateGas(tx, ...rest);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const err = await w.hunter({ provider, onStep: (s) => steps.push(s) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(raised, true, 'the estimate was reached');
    const price = await w.sa.commitPrice(l.listingId);
    assert.ok(price > quoted);
    assert.equal(err.code, 'LATE_PRICE_CHANGED', err.message);
    assert.ok(err.message.includes(`It is ${eth(price)} now, not ${eth(quoted)}.`), err.message);
    assert.ok(!steps.includes('commit:signed'), 'nothing was signed');
    assert.equal(readJson(statePath(dir)).commitTx ?? null, null);
    assert.equal(await w.claimCount(), m.claims);
    assert.equal(await w.provider.getTransactionCount(w.hunterWallet.address), m.nonce);
    // any other refusal at the estimate is passed on as the contract's, as before
    const l2 = await rolled();
    const other = new Proxy(w.provider, {
      get(target, prop) {
        if (prop === 'estimateGas') {
          return async (tx, ...rest) => {
            if (String(tx?.data ?? '').startsWith(selector)) throw new Error('execution reverted: bad budget');
            return target.estimateGas(tx, ...rest);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const refused = await w.hunter({ provider: other }).commit({ claimDir: makeClaimDir(), listingId: l2.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(refused.code, 'CONTRACT_REFUSED');
    assert.match(refused.message, /bad budget/);
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

test('a price that rose beyond what the wallet holds is still said as the new price: the quote is held before the balance is asked', async () => {
  try {
    const l = await rolled();
    const dir = makeClaimDir();
    const quoted = await w.sa.commitPrice(l.listingId);
    // a wallet that can pay the quoted price and its gas, and not the price after the rise
    const poor = ethers.Wallet.createRandom().connect(w.provider);
    const { maxFeePerGas } = await w.provider.getFeeData();
    await (await w.signers[8].sendTransaction({ to: poor.address, value: quoted + 600_000n * maxFeePerGas + 10n ** 14n })).wait();
    const onStep = async (step) => {
      if (step === 'prepare:saved') await (await w.aggregator.setFeeMultiplier(5n)).wait();
    };
    const err = await w.hunter({ signer: poor, onStep }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    const price = await w.sa.commitPrice(l.listingId);
    const fee = await w.provider.getFeeData();
    assert.ok(await w.provider.getBalance(poor.address) < price + 600_000n * fee.maxFeePerGas, 'the wallet cannot pay the new price and its gas');
    assert.equal(err.code, 'LATE_PRICE_CHANGED', err.message);
    assert.ok(err.message.includes(`It is ${eth(price)} now, not ${eth(quoted)}.`), err.message);
    assert.equal(readJson(statePath(dir)).commitTx ?? null, null, 'nothing was signed');
    // the next run, on the new terms, says what it lacks
    await assert.rejects(w.hunter({ signer: poor }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }), (e) => e.code === 'INSUFFICIENT_FUNDS');
  } finally {
    await (await w.aggregator.setFeeMultiplier(3n)).wait();
  }
});

// ------------------------------------------------------------------------------------------------ commit order

test('before it pays, commit --late says how many claims on the listing are open ahead of it, late claims and the stake\'s own', async () => {
  const l = await w.listing(LONG);
  const ordinary = await w.hunter().commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true });
  await (await asMaker().hold(l.listingId)).wait();
  const said = async (dir) => {
    const out = [];
    await assert.rejects(w.hunter({ onNotice: (t) => out.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
    return out.join('\n');
  };
  // behind the claim committed before the hold
  const first = makeClaimDir();
  let text = await said(first);
  assert.ok(text.includes(`Open claims on this listing now: 1, the earliest claim ${ordinary.claimId}.`), text);
  assert.match(text, /yours can be revealed only once every claim committed before it is settled or expired/);
  assert.match(text, new RegExp(`^Listing ${l.listingId} \\(Open\\): `, 'm'));
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
  assert.ok(committed.stdout.includes(notices.LATE_CLAIM_NOTE));
  assert.match(notices.LATE_CLAIM_NOTE, /^A late claim: [^\n]*pays no award\./);

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
  assert.ok(cli.stdout.includes(notices.LATE_CLAIM_NOTE));
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
  assert.ok(cli.stdout.includes(notices.LATE_CLAIM_NOTE));
  const on = await w.sa.getListing(l.listingId);
  await w.increase(on.disputeWindow);
  const held0 = await w.provider.getBalance(w.address);
  cli = await runCli(w, ['claim', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Sent settle: /);
  assert.match(cli.stdout, new RegExp(`^Late claim ${claimId} on listing ${l.listingId}: Settled HIGH`, 'm'));
  assert.match(cli.stdout, /Settled event: HIGH, paid 0\.0 ETH, owed 0\.0 ETH/);
  assert.match(cli.stdout, /Bond: returned to the hunter/);
  assert.ok(cli.stdout.includes(notices.LATE_CLAIM_NOTE));
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
  const said = [];
  await assert.rejects(w.hunter({ onNotice: (t) => said.push(t) }).appeal({ claimDir: dir }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  const text = said.join('\n');
  assert.match(text, /a late claim pays no award/);
  assert.doesNotMatch(text, /a counted class with its award/);
  assert.ok(text.includes(eth(await w.sa.disputeFee(l.listingId))));
  // an ordinary claim's notice says what it said, word for word
  const ordinary = { action: 'appeal', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n };
  assert.match(notices.appealNotice(ordinary), /Its verdict is final: held, the INVALID stands and the bond goes to the maker, unless the panel's vector is a narrow INVALID, whose bond comes back; overturned, the panel's outcome settles at once, a counted class with its award\.$/m);
  assert.equal(notices.appealNotice({ ...ordinary, late: false }), notices.appealNotice(ordinary));

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

function child(dir, listingId, step, { ordinary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LATE_ORDINARY: ordinary ? '1' : '',
        LATE_STEP: step ?? '',
        LATE_DIR: dir,
        LATE_LISTING: String(listingId),
        LATE_RPC: rpc.url,
        LATE_CONTRACT: w.address,
        LATE_GATEWAY: w.ipfs.url,
        LATE_DEV_KEY: w.builderKey.publicKey,
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

// Before state.json is saved the folder holds no claim of either kind, so the resume needs its flag again; from then on
// the folder says it holds a late claim, and a run goes on with that, with --late or without it.
const BEFORE_STATE = new Set(['prepare:archive', 'prepare:keys', 'prepare:ciphertext']);

for (const step of COMMIT_STEPS) {
  test(`commit --late killed at ${step}, then run again ${BEFORE_STATE.has(step) ? 'with --late' : 'without --late'}: one late claim, one bond, disclosed`, async () => {
    const l = await rolled();
    const dir = makeClaimDir();
    const countBefore = await w.claimCount();
    const heldBefore = await w.provider.getBalance(w.address);
    const price = await w.sa.commitPrice(l.listingId);
    const killed = await child(dir, l.listingId, step);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    const keysAtCrash = fs.existsSync(statePath(dir, 'state.json')) && fs.existsSync(statePath(dir, 'keys.json')) ? fs.readFileSync(statePath(dir, 'keys.json'), 'utf8') : null;

    const resumed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), ...(BEFORE_STATE.has(step) ? ['--late'] : []), '--yes']);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, /^Late claim /m);
    await assertOneLateClaim(dir, l, countBefore, heldBefore, price);
    if (keysAtCrash !== null) assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keysAtCrash, 'the same keys');

    // a third run and a fourth change nothing, with the flag or without it, --yes or not
    for (const lateFlag of [true, false]) {
      const again = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag });
      assert.equal(again.stage, 'disclosed');
      assert.equal(again.late, true);
      assert.equal(await w.claimCount(), countBefore + 1n);
    }
  });
}

test('a stopped late claim run again without --late: a prepared one is still a late claim and still asks for --yes; a signed one sends its saved bytes, never a commit', async () => {
  // prepared, nothing signed: the folder says it holds a late claim, so the terms are a late claim's and nothing goes without --yes
  const { l, dir } = await preparedLate();
  const count = await w.claimCount();
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  const dry = await runCli(w, ['commit', dir, '--listing', String(l.listingId)]);
  assert.equal(dry.code, 3, dry.stderr);
  assert.match(dry.stdout, /A late claim pays no award/);
  assert.match(dry.stdout, /^This late claim sends /m);
  assert.equal(await w.claimCount(), count);
  const ok = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Late claim /m);
  assert.equal(await w.claimCount(), count + 1n);
  assert.equal((await w.sa.getClaim(count + 1n)).late, true);
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
  assert.equal(await w.claimCount(), count + 2n);
  assert.equal((await w.sa.getClaim(readJson(statePath(dir2)).claimId)).late, true);
  assert.equal((await w.provider.getTransactionReceipt(saved.commitTx.hash)).status, 1, 'the saved transaction is the one that was mined');
});

test('--late on a folder whose ordinary commit is signed or on the chain changes nothing: the run goes on with that commit and says what it is', async () => {
  for (const step of ['commit:signed', 'commit:saved']) {
    const l = await w.listing(LONG);
    const dir = makeClaimDir();
    const count = await w.claimCount();
    assert.equal((await child(dir, l.listingId, step, { ordinary: true })).signal, 'SIGKILL', step);
    const said = [];
    const r = await w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true });
    assert.equal(r.stage, 'disclosed', step);
    assert.equal(Object.hasOwn(r, 'late'), false, step);
    assert.equal(await w.claimCount(), count + 1n, step);
    assert.equal((await w.sa.getClaim(r.claimId)).late, false, step);
    assert.deepEqual(said, [notices.COMMIT_HERE], step);
    assert.match(notices.COMMIT_HERE, /an ordinary commit, not a late claim: --late changes nothing here/);
    assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false, step);
    // and without the flag it says nothing of it, as before
    const quiet = [];
    await w.hunter({ onNotice: (t) => quiet.push(t) }).commit({ claimDir: dir, listingId: l.listingId });
    assert.deepEqual(quiet, [], step);
  }
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
    const stop2 = await w.hunter({ waitMs: 30 }).commit({ claimDir: dir, listingId: l.listingId }).catch((e) => e);
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
  assert.equal(r.late, true);
  assert.equal(await w.claimCount(), count + 1n);
});

test('the saved late claim\'s nonce went to something else and no claim exists: signed again once, as a late claim, and only with --yes', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'commit:signed')).signal, 'SIGKILL');
  await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
  // no flag and no --yes: the folder is a late claim's still, prepared again, and it asks before it signs anew
  const said = [];
  await assert.rejects(w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.match(said.join('\n'), /A late claim pays no award/);
  const again = readJson(statePath(dir));
  assert.equal(again.stage, 'prepared');
  assert.equal(again.late, true);
  assert.equal(await w.claimCount(), count);
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.equal(await w.claimCount(), count + 1n);
  assert.deepEqual(await eventsOf(r.commitTx), ['LateClaim']);
});

test('a prepared late claim whose two hashes already have a claim on the chain: that claim is found before the listing is asked, before --yes and before --restart is weighed', async () => {
  // found first: no terms are said, --yes is not asked for, and no second bond is paid
  {
    const { l, dir, saved } = await preparedLate();
    const count = await w.claimCount();
    await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    const heldNow = await w.provider.getBalance(w.address);
    const said = [];
    const { provider, seen } = recorded();
    const r = await w.hunter({ provider, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.late, true);
    assert.equal(r.claimId, count + 1n);
    assert.deepEqual(said, [], 'no terms for a claim that is paid already');
    assert.equal(seen[0], 'logs Committed|LateClaim', 'the logs are read first, for a claim of either kind');
    for (const asked of ['read commitPrice', 'read acceptsLateClaims', 'read acceptsCommits', 'estimate lateClaim', 'send lateClaim']) assert.ok(!seen.includes(asked), `no ${asked}`);
    assert.equal(await w.claimCount(), count + 1n, 'one claim, the one that exists');
    assert.equal(await w.provider.getBalance(w.address), heldNow, 'nothing more was paid');
    assert.notEqual((await w.sa.getClaim(count + 1n)).ciphertextCid, '', 'disclosed');
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
    const stop = (step) => {
      if (step === 'prepare:saved') throw new Error('stop');
    };
    await w.hunter({ signer: poor, onStep: stop }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch(() => {});
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    await (await w.sa.connect(poor).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price })).wait();
    assert.ok(await w.provider.getBalance(poor.address) < price, 'it could not pay for a second claim');
    const r = await w.hunter({ signer: poor }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, count + 1n);
    assert.equal(await w.claimCount(), count + 1n);
  }
  // --restart: the claim is found first, so the refusal says the folder has a claim to go on with, and its keys stay
  {
    const { l, dir, saved } = await preparedLate();
    const count = await w.claimCount();
    const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
    await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    await assert.rejects(late({ claimDir: dir, listingId: l.listingId, restart: true }), (e) => e.code === 'LATE_NEEDS_NEW_FOLDER' && /signed or on the chain: run commit again without --restart/.test(e.message));
    assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys, 'the keys of the claim on the chain');
    assert.equal(readJson(statePath(dir)).stage, 'committed');
    assert.equal((await late({ claimDir: dir, listingId: l.listingId })).stage, 'disclosed');
    assert.equal(await w.claimCount(), count + 1n);
  }
  // a commit's prepared folder run with --late, its commit sent some other way before the hold: found too, as the commit it is
  {
    const l = await w.listing(LONG);
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'prepare:saved', { ordinary: true })).signal, 'SIGKILL');
    const saved = readJson(statePath(dir));
    const count = await w.claimCount();
    await (await w.sa.connect(w.hunterWallet).commit(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    await (await asMaker().hold(l.listingId)).wait();
    // with --restart: the commit is found and saved first, and the refusal is a commit's, on the first run and on the next
    const kept = filesOf(dir);
    for (const run of ['first', 'second']) {
      const err = await late({ claimDir: dir, listingId: l.listingId, restart: true }).catch((e) => e);
      assert.equal(err.code, 'RESTART_REFUSED', run);
      assert.equal(err.message, ERROR_TEXTS.RESTART_REFUSED, `${run}: no word of a late claim`);
      const now = readJson(statePath(dir));
      assert.equal(now.stage, 'committed', run);
      assert.equal(Object.hasOwn(now, 'late'), false, run);
      assert.equal(filesOf(dir)['keys.json'], kept['keys.json'], run);
    }
    const said = [];
    const r = await w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, count + 1n);
    assert.equal(Object.hasOwn(r, 'late'), false);
    assert.equal(await w.claimCount(), count + 1n, 'no late claim was filed beside it');
    assert.equal((await w.sa.getListing(l.listingId)).lateClaims, 0n);
    assert.deepEqual(said, [notices.COMMIT_HERE]);
    assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false);
  }
});

// Round 1 of the review (R1-F1): the flag must not change the kind of a folder that had something signed when the run
// started, even when that signed transaction turns out to be gone and the folder is prepared again within the run.
test('--late on a folder whose signed commit lost its nonce: the run goes on as a commit\'s does, never as a late claim\'s', async () => {
  // the listing still takes commits: the commit is signed anew, as a commit, after the run has said what it holds
  {
    const l = await w.listing();
    const dir = makeClaimDir();
    const count = await w.claimCount();
    assert.equal((await child(dir, l.listingId, 'commit:signed', { ordinary: true })).signal, 'SIGKILL');
    await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
    const said = [];
    const r = await w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(Object.hasOwn(r, 'late'), false);
    assert.deepEqual(await eventsOf(r.commitTx), ['Committed']);
    assert.equal((await w.sa.getClaim(r.claimId)).late, false);
    assert.equal(await w.claimCount(), count + 1n);
    assert.equal(said[0], notices.COMMIT_HERE, 'said first, before any terms');
    assert.match(said[1], /^This commit sends /m);
    assert.doesNotMatch(said.join('\n'), /This late claim sends/);
    assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false);
  }
  // the maker held the listing meanwhile: no late claim is paid for on this run, whatever the flag and --yes say
  {
    const l = await w.listing();
    const dir = makeClaimDir();
    assert.equal((await child(dir, l.listingId, 'commit:signed', { ordinary: true })).signal, 'SIGKILL');
    await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
    await (await asMaker().hold(l.listingId)).wait();
    const m = await mark();
    const said = [];
    const err = await w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_CLAIMS_ONLY', err.message);
    assert.deepEqual(said, [notices.COMMIT_HERE]);
    await assertNothingSent(m, null, 'a commit that lost its nonce, on a held listing');
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    assert.equal(Object.hasOwn(saved, 'late'), false, 'the folder is a commit\'s still');
    // the folder has nothing signed now: a run with --late takes it over, says a late claim's terms, and asks for --yes
    const terms = [];
    await assert.rejects(w.hunter({ onNotice: (t) => terms.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
    assert.match(terms.join('\n'), /^This late claim sends /m);
    await assertNothingSent(m, null, 'the late claim\'s dry run');
    const r = await late({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.late, true);
    assert.equal(await w.claimCount(), m.claims + 1n);
  }
});

test('the same late claim went out another way after it was signed here: that claim is adopted, and no second bond is paid', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  assert.equal((await child(dir, l.listingId, 'commit:signed')).signal, 'SIGKILL');
  const saved = readJson(statePath(dir));
  const price = await w.sa.commitPrice(l.listingId);
  await (await w.sa.connect(w.hunterWallet).lateClaim(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: price, gasPrice: 10n ** 10n })).wait();
  const heldNow = await w.provider.getBalance(w.address);
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.claimId, count + 1n);
  assert.equal(r.late, true);
  assert.equal(await w.claimCount(), count + 1n, 'one claim, the one that exists');
  assert.equal(await w.provider.getBalance(w.address), heldNow, 'nothing more was paid');
  assert.equal(readJson(statePath(dir)).late, true);
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

test('a late claim whose nonce goes to another transaction while its first send waits ends as a commit\'s does, and names no claim that does not exist', async () => {
  const ends = [];
  for (const [make, lateFlag] of [[() => w.listing(), false], [rolled, true]]) {
    const l = await make();
    const dir = makeClaimDir();
    const m = await mark();
    const said = [];
    const onStep = async (step) => {
      if (step === 'commit:signed') await (await w.hunterWallet.sendTransaction({ to: w.hunterWallet.address, value: 0n })).wait();
    };
    const err = await w.hunter({ onStep, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true }).catch((e) => e);
    ends.push(err.code);
    assert.doesNotMatch(said.join('\n'), /undefined/, 'no notice of a claim that does not exist');
    assert.equal(await w.claimCount(), m.claims);
    assert.equal(w.ipfs.uploads.length, m.uploads);
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared');
    assert.equal(saved.commitTx, null);
    // and a run again signs anew, once
    const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: lateFlag, acknowledge: true });
    assert.equal(r.stage, 'disclosed');
    assert.equal(await w.claimCount(), m.claims + 1n);
  }
  assert.equal(ends[1], ends[0], 'the late claim\'s run ends with the code a commit\'s does');
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
  assert.equal(o.stage, 'disclosed');
  await assert.rejects(hunter().commit({ claimDir: makeClaimDir(), listingId: open.listingId, late: true, acknowledge: true }), (e) => e.code === 'LISTING_TAKES_COMMITS');
  assert.deepEqual(old.asked, [], 'no read or call of the hold, which that contract does not have');
  const src = fs.readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(src, /\('heldAt'|\('hold'/, 'and the tool\'s source names neither');
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
  assert.match(flat, /the bond is forfeited on INVALID, unless the INVALID is narrow/);
  assert.match(flat, /the prepay is spent on the evaluation/);
  assert.match(flat, /--late changes nothing in a folder that holds a signed commit/);
  assert.match(flat, /A prepared late claim whose two hashes already have a claim on the chain is disclosed on any run, --yes or not, as a signed one is/);
  assert.match(flat, /a later run goes on with that one, with --late or without it/);
  assert.match(flat, /--restart does not start a late claim over: a changed one goes in a new folder/);
  assert.match(flat, /--late is the bare flag, on commit only: with a value \(--late=false too\) or on another command it is a usage error, and nothing is read or sent/);
  // and what the help said of a commit, it says still
  assert.ok(USAGE.includes('                     on a folder with no commit signed yet, without --yes it prints the terms, the price and how\n                     many claims on the listing are open ahead of yours, and sends nothing\n'));
});

test('--late is a flag the CLI\'s parser takes, on commit', async () => {
  let stderr = '';
  const io = { stdout: { write: () => {} }, stderr: { write: (s) => { stderr += s; } } };
  const code = await run(['commit', 'no-such-folder', '--late'], io, {});
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /unknown option/);
  assert.match(stderr, /commit needs an IPFS gateway/);
});

// Round 1 of the review (R1-F3). Before --late existed, `commit ... --late=false --yes` and `claim ... --late` were
// usage errors; adding the flag is what could let them reach a transaction. So --late is taken only as the bare token
// and only by commit. How every other flag is read is not changed here (verdikta-applications#241).
test('--late is taken only as the bare flag, and only by commit: a value, --late=false too, or another command is a usage error before anything is read or sent', async () => {
  const l = await rolled();
  const dir = makeClaimDir();
  const m = await mark();
  const asked = rpc.calls.length;
  const refused = async (args, text, label) => {
    const cli = await runCli(w, args);
    assert.equal(cli.code, 2, `${label}: ${cli.stdout}${cli.stderr}`);
    assert.equal(cli.stdout, '', label);
    assert.equal(cli.stderr, `verdikta-attest: ${args[0]}: ${text}\n`, label);
    assert.equal(rpc.calls.length, asked, `${label}: the chain was not asked anything`);
    await assertNothingSent(m, dir, label);
    assert.equal(fs.existsSync(statePath(dir, '.gitignore')), false, `${label}: the claim folder was not touched`);
  };
  // a value is no yes and no no: on a listing that takes late claims, with --yes, nothing is paid
  for (const value of ['false', 'true', '0', 'no', '']) {
    await refused(['commit', dir, '--listing', String(l.listingId), `--late=${value}`, '--yes'], '--late takes no value', `--late=${value}`);
  }
  await refused(['commit', dir, '--listing', String(l.listingId), '--yes', '--late=false', '--late'], '--late takes no value', 'a value beside the bare flag');
  // the value is not echoed: someone may have typed anything there
  const typed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late=TYPED-BY-MISTAKE-91c2', '--yes']);
  assert.equal(typed.code, 2);
  assert.doesNotMatch(typed.stdout + typed.stderr, /TYPED-BY-MISTAKE/);
  // every other command refuses the flag, and does nothing of its own
  for (const verb of ['claim', 'reveal', 'status', 'appeal', 'check']) {
    await refused([verb, dir, '--late'], '--late is commit\'s flag: no other command takes it', `${verb} --late`);
    await refused([verb, dir, '--late', '--yes'], '--late is commit\'s flag: no other command takes it', `${verb} --late --yes`);
  }
  // and before any setup at all: no wallet, no contract, no gateway in the environment
  for (const argv of [['commit', 'no-such-folder', '--late=false', '--yes'], ['claim', 'no-such-folder', '--late'], ['status', '7', '--late']]) {
    let stderr = '';
    const env = { VERDIKTA_WALLET_KEY: w.hunterKey };
    const code = await run(argv, { stdout: { write: () => {} }, stderr: { write: (s) => { stderr += s; } } }, env);
    assert.equal(code, 2, argv.join(' '));
    assert.match(stderr, /^verdikta-attest: \w+: --late (takes no value|is commit's flag: no other command takes it)\n$/, argv.join(' '));
    assert.equal(env.VERDIKTA_WALLET_KEY, w.hunterKey, 'the wallet key was not read');
  }
  // the bare flag on commit is the late claim, as before
  const dry = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--late']);
  assert.equal(dry.code, 3, dry.stderr);
  assert.match(dry.stdout, /^This late claim sends /m);
});

test('every other flag is read as it was: a value after = is dropped, and a flag is taken on every command (verdikta-applications#241, not changed here)', async () => {
  const io = () => {
    const out = { stderr: '' };
    return { out, streams: { stdout: { write: () => {} }, stderr: { write: (s) => { out.stderr += s; } } } };
  };
  // each reaches the first thing its command needs, as on the base: none stops at the flag
  for (const [argv, needs] of [
    [['commit', 'x', '--yes=false'], /commit needs an IPFS gateway/],
    [['commit', 'x', '--restart=0'], /commit needs an IPFS gateway/],
    [['status', 'x', '--restart'], /this needs the StakeAttestation address/],
    [['claim', 'x', '--yes'], /this needs the StakeAttestation address/],
  ]) {
    const { out, streams } = io();
    assert.equal(await run(argv, streams, {}), 2, argv.join(' '));
    assert.match(out.stderr, needs, argv.join(' '));
    assert.doesNotMatch(out.stderr, /takes no value|no other command takes it/, argv.join(' '));
  }
});

test('the late claim\'s notice and the new refusals pass the wording check, and an ordinary commit\'s notice is the one it was', () => {
  const terms = { listingId: 7n, state: 'Rolled', successor: 9n, bondWei: 1n, priceWei: 2n, feeWei: 1n, awards: [0n, 1n, 2n, 3n], lowestClass: 'MEDIUM', invited: true, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40), pendingClaims: 1n, lateOpenClaims: 2n, headClaim: 5n };
  const notice = notices.lateClaimNotice(terms);
  assert.match(notice, /A late claim pays no award/);
  assert.match(notice, /^Listing 7 \(Rolled, its stake rolled forward to listing 9\): /m);
  assert.match(notice, /Open claims on this listing now: 3, the earliest claim 5 \(2 of them late claims\)\./);
  const texts = [
    notice,
    notices.lateClaimNotice({ ...terms, pendingClaims: 0n, lateOpenClaims: 0n, headClaim: 0n, state: 'Closed', successor: 0n, invited: false }),
    notices.appealNotice({ action: 'appeal', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n, late: true }),
    notices.appealNotice({ action: 'retrigger', claimId: 1n, valueWei: 1n, deadline: 2n, revealWindow: 3n, late: true }),
    notices.LATE_CLAIM_NOTE,
    notices.COMMIT_HERE,
  ];
  for (const text of texts) assert.deepEqual(wordingProblems(text), [], text);
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS', 'LATE_NEEDS_NEW_FOLDER', 'LATE_PRICE_CHANGED', 'LATE_INPUTS_CHANGED']) {
    assert.equal(typeof ERROR_TEXTS[code], 'string', code);
    assert.deepEqual(wordingProblems(ERROR_TEXTS[code]), [], code);
  }
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS']) assert.match(ERROR_TEXTS[code], /Nothing was pinned or sent\.$/, code);
  // an ordinary commit's notice does not read the late claim's terms, whatever a caller passes
  const { lateOpenClaims: _n, successor: _s, ...ordinary } = { ...terms, invited: false };
  assert.equal(commitNotice({ ...ordinary, late: true, lateOpenClaims: 2n, successor: 9n }), commitNotice(ordinary));
  assert.doesNotMatch(commitNotice(ordinary), /late claim/i);
  assert.match(commitNotice(ordinary), /^This commit sends /m);
  assert.match(commitNotice(ordinary), /^Awards: /m);
});

test('the README\'s hunter section shows the command and says what a late claim is, and nothing of what this change does not build', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('\n## The hunter tool\n');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  // the late claim's line stands apart, with a folder and a listing of its own: run after the commit above it, in
  // that commit's folder, it would only go on with the commit (R1-F8)
  assert.match(section, /^verdikta-attest commit \.\/late-claim --listing 7 --late --yes\b/m);
  assert.doesNotMatch(section, /^verdikta-attest commit \.\/claim [^\n]*--late/m);
  assert.match(section, /a late claim takes the place of the `commit` line\. It has a folder and a\s+listing of its own, so `check` before it and every command after it name that folder:/);
  for (const verb of ['check ', 'status']) assert.match(section, new RegExp(`^verdikta-attest ${verb} \\./late-claim\\b`, 'm'), verb);
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /`commit --late`/);
  assert.match(flat, /`--late` is taken only as the bare flag and only by `commit`: with a value \(`--late=false` too\) or on another command it is a usage error \(exit 2\) before anything is read or sent\./);
  assert.match(flat, /`lateClaim`/);
  assert.match(flat, /`acceptsLateClaims`/);
  assert.match(flat, /no award/);
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS', 'LATE_NEEDS_NEW_FOLDER', 'LATE_PRICE_CHANGED', 'LATE_INPUTS_CHANGED']) assert.ok(flat.includes(`\`${code}\``), code);
  // the guards against a second bond are other work (verdikta-applications#238): none of them is here or described here
  for (const name of ['COMMIT_REPLACED', 'START_UNPROVEN', 'anchor.json']) {
    assert.ok(!readme.includes(name), `the README does not name ${name}`);
    assert.equal(Object.hasOwn(ERROR_TEXTS, name), false, `${name} is no error of the tool`);
  }
});
