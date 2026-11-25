// Node P41 (issue #228): a listing on hold, as the hunter's tool says it. A maker's hold (node P39) stops new commits
// on a listing at once and leaves its state Open or Depleted; from then on the listing takes late claims only. An
// ordinary `commit` there was refused as LATE_CLAIMS_ONLY, the words for a listing that rolled forward or closed
// (node P43). It now gets a refusal of its own, LISTING_ON_HOLD, which names the hold and its time.
//
//   - the refusal comes where LATE_CLAIMS_ONLY comes: before anything is drawn, pinned or signed, --yes or not, so a
//     listing on hold is never priced for a commit;
//   - the hold is read only in that refusal, and only of a listing whose state is Open or Depleted. An accepted commit
//     and the late path read nothing new (test/late.test.js holds both), and a contract from before the hold, whose
//     lens says late claims of a Rolled or a Closed listing only, is never asked for a view it does not have;
//   - a contract that refuses the view all the same reads as not on hold, and every answer is then what it was; an
//     RPC that does not answer is said as that, never as "not on hold";
//   - a claim committed before the hold is a pending claim, which a hold leaves alone: its folder goes on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

import { wordingProblems } from '@verdikta/stake-attestation-shared';

import { DISPUTE_RESULTS, LISTING_STATES, STAKE_ATTESTATION_ABI } from '../src/abi.js';
import { revertReasonOf } from '../src/errors.js';
import { ERROR_TEXTS, ToolError, USAGE } from '../src/index.js';
import { COMMIT_HERE } from '../src/notices.js';
import { closeRpc, readJson, rpcOf, runCli, statePath } from './helpers/cli.js';
import { JUSTIFICATION_CID, makeClaimDir, makeWorld, vectorOf } from './helpers/world.js';

const CHILD = fileURLToPath(new URL('./helpers/lateChild.js', import.meta.url));
const iface = new ethers.Interface(STAKE_ATTESTATION_ABI);

// What both refusals that send a hunter to a late claim say of it, word for word (review round 2, R2-F1): what one is,
// and in which folder `commit --late` is a dry run. Node P43 said "commit --late prints its terms and its price, and
// with --yes files one" of every folder; its review put that right in the help, the README and the guide, and this
// is the refusals' turn.
const LATE_CLAIM_INSTEAD = 'A late claim is judged and recorded, and pays no award: in a folder where nothing is saved yet, commit --late prints its terms and its price, and with --yes files one. In a prepared folder, commit --late first looks for a claim of these files on the chain, and discloses one it finds, --yes or not. Nothing was pinned or sent.';
// The refusals an ordinary commit had before this node: a listing that rolled forward or closed keeps the first,
// whose words are node P43's but for that sentence, and one that takes no claim of either kind the second.
const LATE_CLAIMS_ONLY = `This listing takes no commits now, only late claims. ${LATE_CLAIM_INSTEAD}`;
const LISTING_NOT_ACCEPTING = 'This listing takes no commits now.';

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

/** The maker's hold on a listing: the time the contract gives for it from then on. */
async function hold(l) {
  await (await asMaker().hold(l.listingId)).wait();
  return w.sa.heldAt(l.listingId);
}

/** A listing its maker holds (node P39): Open still, no commit taken any more. */
async function onHold(over = {}) {
  const l = await w.listing(over);
  return { ...l, heldAt: await hold(l) };
}

async function rolled(l) {
  const successor = await w.listing();
  await (await asMaker().rollForward(l.listingId, successor.listingId)).wait();
  return l;
}

async function closed(l) {
  await (await asMaker().close(l.listingId)).wait();
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

/** The refusal's whole text for a listing on hold: the fixed words, then the listing and the time as the CLI prints one. */
const refusalOf = (l) => `${ERROR_TEXTS.LISTING_ON_HOLD} Listing ${l.listingId}, on hold since ${l.heldAt} (${new Date(Number(l.heldAt) * 1000).toISOString()}).`;

/**
 * The world's provider, keeping the name of each function of the contract it is asked to read, in order. `answers`
 * names functions whose read is answered here instead: each gets the names read so far and returns an error to throw,
 * or nothing to pass the read on.
 */
function reading(answers = {}) {
  const seen = [];
  const provider = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'call') {
        return async (tx, ...rest) => {
          const name = String(tx?.to ?? '').toLowerCase() === w.address.toLowerCase() ? iface.getFunction(String(tx.data ?? '').slice(0, 10))?.name ?? '?' : null;
          if (name) seen.push(name);
          const err = name ? answers[name]?.(seen) : null;
          if (err) throw err;
          return target.call(tx, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { provider, seen };
}

/** How this contract's own fallback answers a function it does not have: the lens's revert, as the node gives it. */
const unknownFunction = () => w.provider.call({ to: w.address, data: '0x00000001' }).then(() => assert.fail('the fallback answered'), (e) => e);

/** An ordinary commit through the library, killed at `step` (helpers/lateChild.js, as test/late.test.js runs it). */
function killedAt(dir, listingId, step) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LATE_ORDINARY: '1', LATE_STEP: step, LATE_DIR: dir, LATE_LISTING: String(listingId), LATE_RPC: rpc.url, LATE_CONTRACT: w.address, LATE_GATEWAY: w.ipfs.url, LATE_DEV_KEY: w.builderKey.publicKey, VERDIKTA_WALLET_KEY: w.hunterKey },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

// ------------------------------------------------------------------------------------------------- the refusal

test('an ordinary commit on a listing on hold is refused before anything is drawn, pinned or signed, with a code of its own and a text that names the hold and its time', async () => {
  const l = await onHold();
  assert.ok(l.heldAt > 0n, 'the contract gives the time of the hold');
  assert.equal(LISTING_STATES[Number((await w.sa.getListing(l.listingId)).state)], 'Open', 'a hold leaves the state as it was');
  assert.equal(await w.sa.acceptsCommits(l.listingId), false);
  assert.equal(await w.sa.acceptsLateClaims(l.listingId), true);
  const dir = makeClaimDir();
  const m = await mark();
  for (const acknowledge of [true, false]) {
    const label = acknowledge ? 'with --yes' : 'without --yes';
    const said = [];
    const secrets = [];
    const err = await w.hunter({ onNotice: (t) => said.push(t), scrub: { add: (v) => secrets.push(v) } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
    assert.ok(err instanceof ToolError, `${label}: ${err?.message}`);
    assert.equal(err.code, 'LISTING_ON_HOLD', label);
    assert.equal(err.exitCode, 1, label);
    assert.equal(err.message, refusalOf(l), label);
    assert.deepEqual(said, [], `${label}: no terms and no price are said for a listing on hold`);
    assert.deepEqual(secrets, [], `${label}: no key of the claim was read or drawn`);
    await assertNothingSent(m, dir, label);
    assert.equal(fs.existsSync(statePath(dir)), false, `${label}: no state was saved`);
  }
  // the words: the hold and its time, what a late claim is, the command for one, and that nothing left this machine
  const text = refusalOf(l);
  assert.match(text, /^This listing is on hold: its maker /);
  assert.ok(text.includes(LATE_CLAIM_INSTEAD), 'what a late claim is, the command for one, and in which folder it is a dry run');
  assert.match(text, /Nothing was pinned or sent\./);
  // the time is the chain's, in unix seconds, with the same instant in UTC as the CLI prints a time (cli.js `when`)
  const stated = /on hold since (\d+) \((\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z)\)\.$/.exec(text);
  assert.ok(stated, text);
  assert.equal(BigInt(stated[1]), l.heldAt);
  assert.equal(Date.parse(stated[2]), Number(l.heldAt) * 1000);
  const block = await w.provider.getBlock((await w.provider.getLogs({ address: w.address, topics: iface.encodeFilterTopics('Held', [l.listingId]), fromBlock: 0 }))[0].blockNumber);
  assert.equal(BigInt(block.timestamp), l.heldAt, 'the time of the block that held it');
});

test('the CLI: commit on a listing on hold prints the refusal, and no terms and no price, without --yes or with it', async () => {
  const l = await onHold();
  const dir = makeClaimDir();
  const m = await mark();
  for (const flags of [[], ['--yes']]) {
    const label = `commit ${flags.join(' ')}`;
    const cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId), ...flags]);
    assert.equal(cli.code, 1, `${label}: ${cli.stdout}`);
    assert.equal(cli.stderr, `verdikta-attest: LISTING_ON_HOLD: ${refusalOf(l)}\n`, label);
    assert.equal(cli.stdout, '', `${label}: no briefing, so no price, for a commit the listing would not take`);
    await assertNothingSent(m, dir, label);
  }
  // with --json the refusal is the same, on stderr, and stdout holds no result
  const json = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes', '--json']);
  assert.equal(json.code, 1);
  assert.equal(json.stdout, '');
  assert.ok(json.stderr.startsWith('verdikta-attest: LISTING_ON_HOLD: '), json.stderr);
  await assertNothingSent(m, dir, 'commit --json');
});

test('a commit prepared before the hold and never signed is refused the same way: its keys are not read, and its files stay as they are', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  assert.equal((await killedAt(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL');
  assert.equal(readJson(statePath(dir)).stage, 'prepared');
  const kept = Object.fromEntries(['archive.zip', 'keys.json', 'ciphertext.age', 'state.json'].map((f) => [f, fs.readFileSync(statePath(dir, f)).toString('base64')]));
  const held = { ...l, heldAt: await hold(l) };
  const m = await mark();
  for (const acknowledge of [true, false]) {
    const secrets = [];
    const said = [];
    const err = await w.hunter({ onNotice: (t) => said.push(t), scrub: { add: (v) => secrets.push(v) } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
    assert.equal(err.code, 'LISTING_ON_HOLD', `acknowledge ${acknowledge}: ${err.message}`);
    assert.equal(err.message, refusalOf(held));
    assert.deepEqual(secrets, [], 'keys.json was not read: the refusal comes before the saved files are proven');
    assert.deepEqual(said, []);
  }
  await assertNothingSent(m, null, 'a prepared commit');
  for (const [f, bytes] of Object.entries(kept)) assert.equal(fs.readFileSync(statePath(dir, f)).toString('base64'), bytes, `${f} is as it was`);
});

test('a hold that comes after the terms were said and before the commit is signed stops the run there: nothing is signed, and the folder is one commit --late takes over', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const m = await mark();
  let heldAt = null;
  const said = [];
  // the listing took commits when its terms were said; its maker holds it once the folder is prepared
  const onStep = async (step) => {
    if (step === 'prepare:saved') heldAt = await hold(l);
  };
  const err = await w.hunter({ onStep, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.match(said[0], /^This commit sends /m, 'the terms were said: the listing took commits then');
  assert.equal(err.code, 'LISTING_ON_HOLD', err.message);
  assert.equal(err.message, refusalOf({ ...l, heldAt }));
  await assertNothingSent(m, null, 'a hold before the signature');
  const saved = readJson(statePath(dir));
  assert.equal(saved.stage, 'prepared');
  assert.equal(saved.commitTx ?? null, null, 'nothing was signed');
  // the command the refusal names goes on from this folder, with the keys it holds
  const keys = fs.readFileSync(statePath(dir, 'keys.json'), 'utf8');
  const r = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
  assert.equal(r.late, true);
  assert.equal(fs.readFileSync(statePath(dir, 'keys.json'), 'utf8'), keys);
  assert.equal(await w.claimCount(), m.claims + 1n);
});

test('a commit signed before the hold and first mined after it reverts: no claim exists, nothing is pinned, and the next run is refused for the hold', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const m = await mark();
  let heldAt = null;
  // the commit is signed and saved, and the maker's hold is mined before it
  const onStep = async (step) => {
    if (step === 'commit:signed') heldAt = await hold(l);
  };
  const err = await w.hunter({ onStep }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(err.code, 'COMMIT_REVERTED', err.message);
  assert.match(err.message, /The contract says: not accepting commits\./);
  assert.equal(await w.claimCount(), m.claims, 'no claim exists');
  assert.equal(w.ipfs.uploads.length, m.uploads, 'nothing was pinned');
  assert.equal(readJson(statePath(dir)).stage, 'prepared', 'the folder is prepared again, with nothing signed');
  // the next run, with --late or without it and --yes or not, sends no saved transaction: commit is refused for the hold
  for (const acknowledge of [true, false]) {
    const again = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
    assert.equal(again.code, 'LISTING_ON_HOLD', again.message);
    assert.equal(again.message, refusalOf({ ...l, heldAt }));
  }
  assert.equal(await w.claimCount(), m.claims);
  assert.equal(w.ipfs.uploads.length, m.uploads);
});

// ------------------------------------------------------------------------- which refusal, and what is read for it

test('a listing that rolled forward or closed keeps LATE_CLAIMS_ONLY, also when its maker held it first, and is not asked for a hold', async () => {
  assert.equal(ERROR_TEXTS.LATE_CLAIMS_ONLY, LATE_CLAIMS_ONLY, 'its text, word for word');
  const cases = [
    ['rolled forward', async () => rolled(await w.listing())],
    ['closed after it opened', async () => closed(await w.listing())],
    ['held, then rolled forward', async () => rolled(await onHold())],
    ['held, then closed', async () => closed(await onHold())],
  ];
  for (const [name, make] of cases) {
    const l = await make();
    assert.equal(await w.sa.heldAt(l.listingId), 0n, `${name}: the view answers 0 once the hold has ended`);
    assert.equal(await w.sa.acceptsLateClaims(l.listingId), true, name);
    const dir = makeClaimDir();
    const m = await mark();
    const { provider, seen } = reading();
    const err = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_CLAIMS_ONLY', `${name}: ${err.message}`);
    assert.equal(err.message, `${LATE_CLAIMS_ONLY} Listing ${l.listingId}.`, name);
    assert.deepEqual(seen.slice(-3), ['acceptsCommits', 'acceptsLateClaims', 'getListing'], `${name}: the listing's state says it is not on hold`);
    assert.ok(!seen.includes('heldAt'), `${name}: the hold is not asked for`);
    await assertNothingSent(m, dir, name);
  }
});

test('the hold is read only in the refusal: after the listing said it takes no commit and takes late claims, and its state is Open or Depleted', async () => {
  const l = await onHold();
  const dir = makeClaimDir();
  const refused = reading();
  await assert.rejects(w.hunter({ provider: refused.provider }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }), (e) => e.code === 'LISTING_ON_HOLD');
  assert.deepEqual(refused.seen, ['getListing', 'artifactHashOf', 'commitPrice', 'acceptsCommits', 'acceptsLateClaims', 'getListing', 'heldAt']);

  // a listing that takes neither kind is refused as it was, and is asked neither for its state again nor for a hold
  const unfunded = await w.listing({ fund: false });
  const neither = reading();
  const err = await w.hunter({ provider: neither.provider }).commit({ claimDir: makeClaimDir(), listingId: unfunded.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(err.code, 'LISTING_NOT_ACCEPTING');
  assert.equal(err.message, `${LISTING_NOT_ACCEPTING} Listing ${unfunded.listingId}.`);
  assert.deepEqual(neither.seen.slice(-2), ['acceptsCommits', 'acceptsLateClaims']);
  assert.ok(!neither.seen.includes('heldAt'));

  // a commit that is accepted reads nothing of it (test/late.test.js holds every call it makes, in order)
  const open = await w.listing();
  const accepted = reading();
  const r = await w.hunter({ provider: accepted.provider }).commit({ claimDir: makeClaimDir(), listingId: open.listingId, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.ok(!accepted.seen.includes('heldAt') && !accepted.seen.includes('acceptsLateClaims'), accepted.seen.join(' '));
});

test('commit --late on a listing on hold is as node P43 left it: its terms and its price without --yes, the late claim with it, and no read of the hold', async () => {
  const l = await onHold();
  const dir = makeClaimDir();
  const m = await mark();
  const said = [];
  const dry = reading();
  await assert.rejects(w.hunter({ provider: dry.provider, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT' && e.exitCode === 3);
  await assertNothingSent(m, dir, 'the dry run');
  const price = await w.sa.commitPrice(l.listingId);
  const on = await w.sa.getListing(l.listingId);
  const text = said.join('\n');
  assert.ok(text.includes(`This late claim sends ${ethers.formatEther(price)} ETH: the bond ${ethers.formatEther(on.bondWei)} ETH and the prepay ${ethers.formatEther(price - on.bondWei)} ETH, the live maximum fee.`), text);
  assert.match(text, new RegExp(`^Listing ${l.listingId} \\(Open\\): `, 'm'), 'the listing with its state, as the chain has it');
  assert.doesNotMatch(text, /on hold/, 'and no new line: the late claim\'s terms are the ones they were');
  assert.deepEqual(dry.seen, ['getListing', 'artifactHashOf', 'commitPrice', 'acceptsLateClaims']);
  const sent = reading();
  const r = await w.hunter({ provider: sent.provider }).commit({ claimDir: dir, listingId: l.listingId, late: true, acknowledge: true });
  assert.equal(r.stage, 'disclosed');
  assert.equal(r.late, true);
  assert.equal((await w.sa.getClaim(r.claimId)).late, true);
  assert.ok(!sent.seen.includes('heldAt'), 'the late path reads no hold');
  // the CLI's dry run, in a fresh folder: the terms and the price on stdout, exit 3
  const cli = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--late']);
  assert.equal(cli.code, 3, cli.stderr);
  assert.ok(cli.stdout.includes(`This late claim sends ${ethers.formatEther(price)} ETH`));
  assert.doesNotMatch(cli.stdout + cli.stderr, /LISTING_ON_HOLD|on hold/);
});

// ------------------------------------------------------------------------------ a claim committed before the hold

const script = async (claimId, outcome) => {
  const c = await w.sa.getClaim(claimId);
  await (await w.aggregator.scriptResult(c.requestId, vectorOf(outcome), JUSTIFICATION_CID)).wait();
};

for (const step of ['commit:sent', 'commit:mined', 'commit:saved', 'disclose:cid-saved']) {
  test(`a commit already on the chain when the hold comes goes on: stopped at ${step}, the listing put on hold, the same command again`, async () => {
    const l = await w.listing();
    const dir = makeClaimDir();
    const before_ = await w.claimCount();
    assert.equal((await killedAt(dir, l.listingId, step)).signal, 'SIGKILL');
    assert.equal(await w.claimCount(), before_ + 1n, 'the commit is on the chain');
    assert.equal((await w.sa.getClaim(before_ + 1n)).disclosedAt, 0n, 'and not disclosed yet');
    await hold(l);
    assert.equal(await w.sa.acceptsCommits(l.listingId), false);
    const said = [];
    const { provider, seen } = reading();
    // no --yes and no --late: a commit under way is resumed on every run
    const r = await w.hunter({ provider, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId });
    assert.equal(r.stage, 'disclosed');
    assert.equal(r.claimId, before_ + 1n);
    assert.equal(Object.hasOwn(r, 'late'), false, 'the commit it was');
    assert.equal(await w.claimCount(), before_ + 1n, 'no second claim');
    const claim = await w.sa.getClaim(r.claimId);
    assert.equal(claim.late, false);
    assert.ok(claim.disclosedAt > 0n, 'disclosed on the listing on hold');
    assert.equal(claim.ciphertextCid, r.ciphertextCid);
    assert.ok(w.ipfs.store.get(claim.ciphertextCid).equals(fs.readFileSync(statePath(dir, 'ciphertext.age'))), 'the ciphertext is at the pin target');
    assert.deepEqual(said, [], 'nothing is said of the hold: the claim is a pending one, which a hold leaves alone');
    for (const name of ['acceptsCommits', 'acceptsLateClaims', 'heldAt', 'commitPrice']) assert.ok(!seen.includes(name), `the listing is not asked ${name}: the claim on the chain is found first`);
    assert.equal(readJson(statePath(dir)).stage, 'disclosed');
  });
}

test('a claim committed before the hold keeps every path after it: status, reveal, the verdict and its award from the escrow; the listing is then Depleted and still on hold', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  assert.equal((await killedAt(dir, l.listingId, 'commit:saved')).signal, 'SIGKILL');
  const heldAt = await hold(l);
  let cli = await runCli(w, ['commit', dir, '--listing', String(l.listingId)]);
  assert.equal(cli.code, 0, cli.stderr);
  const { claimId } = readJson(statePath(dir));
  assert.match(cli.stdout, new RegExp(`^Claim ${claimId} on listing ${l.listingId}: disclosed\\.$`, 'm'));
  cli = await runCli(w, ['status', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`^Claim ${claimId} on listing ${l.listingId}: `, 'm'));
  cli = await runCli(w, ['reveal', dir, '--yes']);
  assert.equal(cli.code, 0, cli.stderr);
  await script(claimId, 'CRITICAL');
  cli = await runCli(w, ['claim', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  const on = await w.sa.getListing(l.listingId);
  await w.increase(on.disputeWindow);
  cli = await runCli(w, ['claim', dir]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`^Claim ${claimId} on listing ${l.listingId}: Settled CRITICAL`, 'm'));
  const claim = await w.sa.getClaim(claimId);
  assert.equal(claim.paidWei, on.awards[3], 'the award was paid from the escrow of the listing on hold');
  // that payout left the escrow below the top award: Depleted, and on hold still, since the same time
  const after_ = await w.sa.getListing(l.listingId);
  assert.equal(LISTING_STATES[Number(after_.state)], 'Depleted');
  assert.equal(await w.sa.heldAt(l.listingId), heldAt);
  const m = await mark();
  const fresh = makeClaimDir();
  const err = await w.hunter().commit({ claimDir: fresh, listingId: l.listingId, acknowledge: true }).catch((e) => e);
  assert.equal(err.code, 'LISTING_ON_HOLD');
  assert.equal(err.message, refusalOf({ ...l, heldAt }));
  await assertNothingSent(m, fresh, 'a Depleted listing on hold');
});

// --------------------------------------------------- a commit sent some other way, in a folder that is still prepared

// What is true today, and what this node does not change (review round 1, R1-F1; owner, 2026-11-24). An ordinary
// commit looks for its folder's two hashes on the chain only in sendCommit, once the listing has taken the commit and
// --yes was given. A late claim's run looks first, before the listing is asked (node P43). So a prepared folder whose
// commit went out some other way is refused by `commit` on every listing that takes no commit, with that listing's own
// refusal, and the claim stays undisclosed; `commit --late` in that folder finds the claim, adopts it as the commit it
// is, and discloses it. Where an ordinary commit looks is other work (verdikta-applications#238): this test holds the
// order as it is, and the way through there is today.
test('a prepared folder whose commit went out some other way, on a listing that takes no commit: commit refuses it as it refuses that listing, and commit --late in that folder finds the claim and discloses it, with no second bond', async () => {
  const paidPeriodOver = async (l) => {
    await w.rpc('evm_setNextBlockTimestamp', [Number((await w.sa.getListing(l.listingId)).fundedUntil)]);
    await w.mine();
  };
  const cases = [
    ['on hold', 'LISTING_ON_HOLD', hold],
    ['rolled forward', 'LATE_CLAIMS_ONLY', rolled],
    ['its paid period over', 'LISTING_NOT_ACCEPTING', paidPeriodOver],
  ];
  for (const [name, code, end] of cases) {
    const l = await w.listing();
    const dir = makeClaimDir();
    assert.equal((await killedAt(dir, l.listingId, 'prepare:saved')).signal, 'SIGKILL', name);
    const saved = readJson(statePath(dir));
    assert.equal(saved.stage, 'prepared', name);
    // the same two hashes, committed from the same wallet without this tool (for the last case, a minute before the
    // paid period ends, so that the claim's disclose window is still open after it)
    if (end === paidPeriodOver) await w.rpc('evm_setNextBlockTimestamp', [Number((await w.sa.getListing(l.listingId)).fundedUntil) - 60]);
    await (await w.sa.connect(w.hunterWallet).commit(l.listingId, saved.archiveSha256, saved.ciphertextSha256, { value: await w.sa.commitPrice(l.listingId) })).wait();
    const claimId = await w.claimCount();
    await end(l);
    assert.equal(await w.sa.acceptsCommits(l.listingId), false, name);
    const m = await mark();
    const paid = await w.provider.getBalance(w.address);

    // commit, without --yes and with it: the listing's refusal, nothing sent, and the claim is as it was
    for (const acknowledge of [false, true]) {
      const err = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
      assert.equal(err.code, code, `${name}, acknowledge ${acknowledge}: ${err.message}`);
    }
    await assertNothingSent(m, null, name);
    assert.equal((await w.sa.getClaim(claimId)).disclosedAt, 0n, `${name}: commit did not disclose the claim on the chain`);
    assert.equal(readJson(statePath(dir)).stage, 'prepared', name);

    // commit --late in that folder, with no --yes: the claim is found before the listing is asked, and disclosed
    const said = [];
    const r = await w.hunter({ onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: l.listingId, late: true });
    assert.equal(r.stage, 'disclosed', name);
    assert.equal(r.claimId, claimId, `${name}: the claim that was on the chain`);
    assert.equal(Object.hasOwn(r, 'late'), false, `${name}: adopted as the ordinary commit it is`);
    assert.deepEqual(said, [COMMIT_HERE], `${name}: no terms, and the run says what the folder holds`);
    const claim = await w.sa.getClaim(claimId);
    assert.equal(claim.late, false, name);
    assert.ok(claim.disclosedAt > 0n, `${name}: disclosed`);
    assert.equal(claim.ciphertextCid, r.ciphertextCid, name);
    assert.equal(await w.claimCount(), m.claims, `${name}: no second claim`);
    assert.equal(await w.provider.getBalance(w.address), paid, `${name}: no second bond or prepay`);
    assert.equal((await w.sa.getListing(l.listingId)).lateClaims, 0n, `${name}: no late claim was filed beside it`);
    assert.equal(Object.hasOwn(readJson(statePath(dir)), 'late'), false, name);
  }
});

// --------------------------------------------------------------------------------------- a contract with no hold

test('against a contract with no hold every answer is what it was before this node, and the hold is never asked for', async () => {
  // The contract live today has no heldAt and no hold: a call of either reaches its fallback, which answers as this
  // one's does for any function it does not have. Its lens says late claims of a Rolled listing, or of one Closed
  // after it opened, and of no other.
  const unknown = await unknownFunction();
  assert.equal(revertReasonOf(unknown), 'unknown function', 'the fallback\'s revert, which the tool knows as a revert');
  const old = reading({ heldAt: () => unknown, hold: () => unknown });
  const hunter = () => w.hunter({ provider: old.provider });
  for (const [name, make] of [['Rolled', async () => rolled(await w.listing())], ['Closed after it opened', async () => closed(await w.listing())]]) {
    const l = await make();
    const dir = makeClaimDir();
    const m = await mark();
    for (const acknowledge of [true, false]) {
      const err = await hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
      assert.equal(err.code, 'LATE_CLAIMS_ONLY', `${name}: ${err.message}`);
      assert.equal(err.message, `${LATE_CLAIMS_ONLY} Listing ${l.listingId}.`, name);
    }
    await assertNothingSent(m, dir, name);
  }
  // a listing that takes neither: never funded, or its paid period over
  const unfunded = await w.listing({ fund: false });
  const lapsed = await w.listing();
  await w.rpc('evm_setNextBlockTimestamp', [Number((await w.sa.getListing(lapsed.listingId)).fundedUntil)]);
  await w.mine();
  for (const [name, l] of [['never funded', unfunded], ['its paid period over', lapsed]]) {
    const err = await hunter().commit({ claimDir: makeClaimDir(), listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LISTING_NOT_ACCEPTING', name);
    assert.equal(err.message, `${LISTING_NOT_ACCEPTING} Listing ${l.listingId}.`, name);
  }
  // a listing that takes commits: the terms without --yes, the commit with it
  const open = await w.listing();
  const dir = makeClaimDir();
  const said = [];
  await assert.rejects(w.hunter({ provider: old.provider, onNotice: (t) => said.push(t) }).commit({ claimDir: dir, listingId: open.listingId }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.match(said.join('\n'), /^This commit sends /m);
  assert.equal((await hunter().commit({ claimDir: dir, listingId: open.listingId, acknowledge: true })).stage, 'disclosed');
  assert.deepEqual(old.seen.filter((name) => name === 'heldAt' || name === 'hold'), [], 'neither is ever called: that contract has neither');
  for (const name of ['commitPrice', 'acceptsCommits', 'acceptsLateClaims', 'isAllowed', 'getListing', 'getClaim']) assert.ok(old.seen.includes(name), `${name} was read through it`);
});

test('a contract that says late claims of an Open listing and has no view of the hold reads as not on hold: the refusal a commit had before this node', async () => {
  // No deployed contract is like this: the lens that says late claims of an Open listing is the one that came with
  // the view. Should one refuse the view all the same, the listing is not said to be on hold, and no time is made up.
  const l = await onHold();
  const unknown = await unknownFunction();
  // as the node gives the fallback's revert, and as an RPC that names only the reason gives it
  const forms = [unknown, Object.assign(new Error('execution reverted: unknown function'), { code: 'CALL_EXCEPTION', reason: 'unknown function' })];
  for (const [i, form] of forms.entries()) {
    const dir = makeClaimDir();
    const m = await mark();
    const { provider, seen } = reading({ heldAt: () => form });
    const err = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch((e) => e);
    assert.equal(err.code, 'LATE_CLAIMS_ONLY', `form ${i}: ${err.message}`);
    assert.equal(err.message, `${LATE_CLAIMS_ONLY} Listing ${l.listingId}.`);
    assert.equal(seen.at(-1), 'heldAt', 'the view was asked, and refused');
    await assertNothingSent(m, dir, `form ${i}`);
  }
});

test('an RPC that does not answer for the hold is said as that, never as a listing that is not on hold', async () => {
  const l = await onHold();
  const down = () => new Error('socket hang up');
  // ethers gives every error a node answers an eth_call with one shape, CALL_EXCEPTION with no revert data: a rate
  // limit, a node's own fault and a revert with empty data alike (JsonRpcApiProvider.getRpcError). So a call that
  // failed with no reason of the contract's is not the contract's word, and is never read as "not on hold". Nor is a
  // reason that is none of the contract's: only its own revert strings are (errors.js, KNOWN_REVERTS)
  const call = { to: w.address, data: iface.encodeFunctionData('heldAt', [l.listingId]) };
  const noData = () => ethers.AbiCoder.getBuiltinCallException('call', call, null);
  const otherReason = () => ethers.AbiCoder.getBuiltinCallException('call', call, ethers.concat(['0x08c379a0', ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['rate limit reached'])]));
  assert.equal(noData().code, 'CALL_EXCEPTION');
  assert.equal(noData().data, null);
  assert.equal(revertReasonOf(noData()), null);
  assert.equal(revertReasonOf(otherReason()), null);
  const cases = [
    ['the hold\'s time', { heldAt: down }],
    ['the listing\'s state, in the refusal', { getListing: (seen) => (seen.includes('acceptsLateClaims') ? down() : null) }],
    ['the hold\'s time, answered with an error and no revert data', { heldAt: noData }],
    ['the hold\'s time, answered with a reason that is none of the contract\'s', { heldAt: otherReason }],
  ];
  for (const [name, answers] of cases) {
    const dir = makeClaimDir();
    const m = await mark();
    for (const acknowledge of [true, false]) {
      const { provider } = reading(answers);
      const err = await w.hunter({ provider }).commit({ claimDir: dir, listingId: l.listingId, acknowledge }).catch((e) => e);
      assert.equal(err.code, 'RPC_UNAVAILABLE', `${name}: ${err.message}`);
      assert.equal(err.message, ERROR_TEXTS.RPC_UNAVAILABLE, name);
    }
    await assertNothingSent(m, dir, name);
  }
});

// ------------------------------------------------------------------------------------------------- the words

test('the refusal\'s text passes the wording check, ends as the other refusals of a wrong kind do, and says "on hold", never a bare "held"', () => {
  const text = ERROR_TEXTS.LISTING_ON_HOLD;
  assert.equal(typeof text, 'string');
  assert.deepEqual(wordingProblems(text), []);
  assert.match(text, /Nothing was pinned or sent\.$/);
  assert.match(text, /\bon hold\b/);
  assert.match(text, /pays no award/);
  // the command it names is one the CLI has (node P43): --late, on commit's own line of the help
  assert.match(text, /commit --late prints its terms and its price, and with --yes files one\./);
  assert.match(USAGE, /^ {2}commit <claim-dir> --listing <id> \[--late\] \[--yes\]/m);
  // and both refusals that name it say the same of it, in one sentence: in which folder it is a dry run (R2-F1)
  for (const code of ['LISTING_ON_HOLD', 'LATE_CLAIMS_ONLY']) {
    assert.ok(ERROR_TEXTS[code].endsWith(` ${LATE_CLAIM_INSTEAD}`), code);
    assert.match(ERROR_TEXTS[code], /in a folder where nothing is saved yet, commit --late prints its terms and its price, and with --yes files one\. In a prepared folder, commit --late first looks for a claim of these files on the chain, and discloses one it finds, --yes or not\./, code);
    assert.equal(ERROR_TEXTS[code].split('commit --late').length - 1, 2, `${code}: each mention of the command is in that sentence`);
    assert.deepEqual(wordingProblems(ERROR_TEXTS[code]), [], code);
  }
  assert.equal(ERROR_TEXTS.LISTING_ON_HOLD, `This listing is on hold: its maker stopped new commits on it, and a hold is not lifted, so it takes late claims only from now on. ${LATE_CLAIM_INSTEAD}`);
  // the help says the same of a prepared folder, in its own words
  assert.match(USAGE.replace(/\s+/g, ' '), /With --late, or in a folder prepared for a late claim, a prepared folder whose two hashes already have a claim on the chain, a commit's or a late claim's, has that claim disclosed, --yes or not/);
  // "Held" is a dispute result in this contract (a verdict that stood), so the tool's own words for a hold never use it
  assert.ok(DISPUTE_RESULTS.includes('Held'));
  assert.doesNotMatch(text, /\bheld\b/i);
  assert.equal(new ToolError('LISTING_ON_HOLD').exitCode, 1);
  // a late claim is never started over (owner, 2026-11-24): no word of --restart here
  assert.doesNotMatch(text, /--restart/);
});

test('the README\'s hunter section says the refusal and where the hold is read, and which folder a late claim\'s dry run is for', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('\n## The hunter tool\n');
  const flat = readme.slice(start, readme.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.ok(flat.includes('`LISTING_ON_HOLD`'));
  assert.match(flat, /`LISTING_ON_HOLD` \(node P41\) for a `commit` without `--late` on a listing on hold: its text names the hold and its time, as `heldAt` gives it/);
  assert.match(flat, /The hold is read only for that refusal, once `acceptsCommits` said no and `acceptsLateClaims` said yes, and only of a listing whose state is Open or Depleted/);
  assert.match(flat, /a contract with no hold is never asked for the view/);
  assert.match(flat, /An RPC that does not answer is said as that \(`RPC_UNAVAILABLE`\)/);
  // both refusals say in which folder `commit --late` is a dry run, in one sentence (review round 2, R2-F1)
  assert.match(flat, /Both refusals, `LATE_CLAIMS_ONLY` and `LISTING_ON_HOLD`, say of `commit --late` what is said below of its dry run, in one sentence \(`LATE_CLAIM_INSTEAD`, `src\/errors\.js`\): in a folder where nothing is saved yet it prints its terms and its price; in a prepared folder it first looks for a claim of these files on the chain, and discloses one it finds, `--yes` or not\./);
  // which commit goes on: one this folder signed. One sent some other way, in a folder still prepared, does not
  assert.match(flat, /A commit this folder signed that is on the chain when the hold comes is a pending claim, which a hold leaves alone: `commit` goes on with it, to disclose and everything after\. One first mined after the hold reverts \(`COMMIT_REVERTED`\), and the next run is refused for the hold\./);
  assert.match(flat, /A prepared folder whose commit went out some other way is refused as any commit there is, on a listing on hold as on every listing that takes no commit: an ordinary commit asks the listing before it looks for its hashes on the chain, and where it looks is other work \(verdikta-applications#238\)\. `commit --late` in that folder finds the claim, adopts it as the commit it is and discloses it, with no second bond\./);
  assert.match(fs.readFileSync(new URL('../src/errors.js', import.meta.url), 'utf8'), /\nconst LATE_CLAIM_INSTEAD = '/);
  assert.doesNotMatch(flat, /so the tool reads no hold\b/, 'true of a late claim only, now');
  // which folder a dry run of `commit --late` is for (the last review round of node P43): a fresh folder for a
  // price-only check; a prepared one is looked up on the chain first, and gets its terms when no claim is found
  assert.doesNotMatch(flat, /sends nothing only in a folder where nothing is saved yet/);
  assert.match(flat, /For a price-only check, run `commit --late` without `--yes` in a folder where nothing is saved yet: it prints its terms and sends nothing\. In a prepared folder it first looks for a matching claim on the chain, and prints the terms and sends nothing if it finds none\./);
});
