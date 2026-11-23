// Closing this wallet's expired bounty first clears the claims that block closeExpiredBounty ("active evaluation -
// finalize first"). Mainnet #253 (v1): the opponent's five rejected claims sat at PendingVerdikta / FINALIZE for good.
// v2: the pending list also holds submissions awaiting a re-run, and a round with no result is closed, not finalized.
import './_v2-deployment.js'; // synthetic v2 escrow: deployments.json holds placeholders until the deploy
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecover } from '../recover_funds.js';
import { verifyTransaction, clearingCall, roundSettlesBy, outcomeName, CLEARING_METHODS } from '../_transaction-guards.js';

const creator = '0x1111111111111111111111111111111111111111', opponent = '0x2222222222222222222222222222222222222222';
const policy = { maxValueWei: '1000', maxTotalWei: '1000000000000000', maxGasLimit: '500000', maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' };
const DEADLINE = 1_800_000_000, iso = (s) => new Date(s * 1000).toISOString();
// getOracleResult (v2 lens struct): outcome 0 not ready, 1 no result, 2 pass, 3 soft fail, 4 hard fail (BountyRules).
const rejected = { started: true, hasResult: true, phase: 6n, outcome: 4n, rounds: 1n, passCount: 0n, deadline: BigInt(DEADLINE - 3600), requestTime: BigInt(DEADLINE - 7200), scores: [900000n, 100000n], justificationCids: 'bafy' };
const softFail = { ...rejected, outcome: 3n, passCount: 2n };
const accepted = { ...rejected, outcome: 2n, passCount: 3n, scores: [100000n, 900000n] };
const inFlight = { ...rejected, hasResult: false, phase: 5n, outcome: 0n, scores: [], justificationCids: '' };

function fixture({ signer = creator, chainNow = DEADLINE + 60, pending = [0, 1, 2, 3, 4], next = {}, results = {}, status = 0n, dryRun = false, inFlightCount = null } = {}) {
  const sent = [], logs = [], state = { pending: [...pending] };
  const bounty = { creator, status, submissionDeadline: BigInt(DEADLINE), threshold: 80n, quota: 3n, forfeitLine: 1n };
  const escrow = {
    getBounty: async () => bounty,
    // The lens counts rounds in flight only; inFlightCount models AwaitingRerun entries it does not see.
    canBeClosed: async () => (inFlightCount ?? state.pending.length) === 0 && Number(bounty.status) === 0 && chainNow >= DEADLINE,
    pendingSubmissionIds: async () => state.pending.map(BigInt),
    nextAction: async (_, id) => next[id] ?? 'FINALIZE',
    getOracleResult: async (_, id) => results[id] ?? rejected,
  };
  const provider = { destroy() {}, getBlock: async () => ({ timestamp: chainNow }) };
  const lib = {
    getNetwork: () => 'base', providerFor: () => provider, preflightDeployment: async () => {}, loadSpendPolicy: async () => policy,
    loadWallet: async () => ({ address: signer, connect() { return this; } }), isDryRun: () => dryRun,
    sendTx: async (s, method, tx, opts) => {
      verifyTransaction(tx, { network: 'base', method, args: opts.args, value: 0n, maxValueWei: policy.maxValueWei });
      sent.push([method, ...opts.args.map(String)]);
      if (dryRun) return null;
      if (method !== 'closeExpiredBounty') { state.pending = state.pending.filter((id) => BigInt(id) !== opts.args[1]); if (inFlightCount != null) inFlightCount = 0; }
      return { status: 1, hash: `0x${'ab'.repeat(32)}`, logs: [] };
    },
  };
  const run = (close = '253') => runRecover(lib, { close, contract: () => escrow, log: (l) => logs.push(l) });
  return { run, sent, logs, state };
}

test('the live shape: five claims that did not pass are finalized, then the bounty closes', async () => {
  const f = fixture({ results: { 1: softFail, 3: softFail } });
  const receipt = await f.run();
  assert.ok(receipt);
  assert.deepEqual(f.sent, [...[0, 1, 2, 3, 4].map((id) => ['finalizeSubmission', '253', String(id)]), ['closeExpiredBounty', '253']]);
  assert.match(f.logs.join('\n'), /5 pending claim\(s\) blocking the close/);
  assert.match(f.logs.join('\n'), /submission 1: finalizeSubmission \(SOFT_FAIL\)/);
  assert.match(f.logs.join('\n'), /submission 0: finalizeSubmission \(HARD_FAIL\)/);
});

test('a round with no result is closed (closeFailedRound), a re-run that can no longer happen is expired', async () => {
  const f = fixture({ pending: [0, 1, 2], next: { 1: 'CLOSE_FAILED', 2: 'EXPIRE_RERUN' }, results: { 1: { ...inFlight, phase: 8n, outcome: 1n }, 2: { ...softFail } } });
  await f.run();
  assert.deepEqual(f.sent, [['finalizeSubmission', '253', '0'], ['closeFailedRound', '253', '1'], ['expireRerun', '253', '2'], ['closeExpiredBounty', '253']]);
});

test('a claim awaiting a re-run blocks the close although the lens canBeClosed says yes', async () => {
  // canBeClosed counts rounds in flight; closeExpiredBounty needs the whole pending list empty.
  const f = fixture({ pending: [4], next: { 4: 'EXPIRE_RERUN' }, inFlightCount: 0 });
  await f.run();
  assert.deepEqual(f.sent, [['expireRerun', '253', '4'], ['closeExpiredBounty', '253']]);
});

test('claims still being evaluated: nothing is sent, and the retry time comes from the round deadlines', async () => {
  const f = fixture({ next: { 2: 'AWAIT_ORACLE', 3: 'PROMOTE' }, results: { 2: { ...inFlight, deadline: BigInt(DEADLINE + 900) }, 3: { ...inFlight, phase: 4n, deadline: BigInt(DEADLINE + 300) } } });
  await assert.rejects(f.run(), new RegExp(`not closed and nothing was sent: Submission 2 is still being evaluated \\(its jury is working\\); Submission 3 is still being evaluated \\(its round waits for PROMOTE, which anyone may send with claim_bounty\\.js\\)\\. Retry the close after ${iso(DEADLINE + 901).replace(/\./g, '\\.')}`));
  assert.deepEqual(f.sent, []);
  // An undrawn round has no deadline yet: it can be cancelled a day after its request.
  const undrawn = fixture({ pending: [0], next: { 0: 'DRAW' }, results: { 0: { ...inFlight, phase: 1n, deadline: 0n, requestTime: BigInt(DEADLINE - 100) } } });
  await assert.rejects(undrawn.run(), new RegExp(`Retry the close after ${iso(DEADLINE - 100 + 86401).replace(/\./g, '\\.')}`));
  assert.deepEqual(undrawn.sent, []);
});

test('a close never pays the claimant: a passing result stops it, before anything is sent', async () => {
  const pass = fixture({ results: { 3: accepted } });
  await assert.rejects(pass.run(), /Submission 3 passed its evaluation \(3 juror score\(s\) at or above threshold 80, quota 3\): finalizing it pays the claimant/);
  assert.deepEqual(pass.sent, []);
  const earlier = fixture({ next: { 2: 'AWAIT_EARLIER' }, results: { 2: accepted } });
  await assert.rejects(earlier.run(), /Submission 2 passed its evaluation/);
  assert.deepEqual(earlier.sent, []);
});

test('guards: never clears claims on a bounty this wallet did not create, before its deadline or once it is settled', async () => {
  const notMine = fixture({ signer: opponent });
  await assert.rejects(notMine.run(), /Only the bounty's creator 0x1111111111111111111111111111111111111111 clears its claims/);
  assert.deepEqual(notMine.sent, []);
  const early = fixture({ chainNow: DEADLINE - 60 });
  await assert.rejects(early.run(), /deadline 2027-01-15T08:00:00\.000Z has not passed: it cannot be closed, or its claims cleared/);
  assert.deepEqual(early.sent, []);
  const paid = fixture({ status: 1n });
  await assert.rejects(paid.run(), /no longer open/);
  assert.deepEqual(paid.sent, []);
});

test('a bounty with nothing pending closes directly; a dry run reviews the clearing calls and stops before the close', async () => {
  const plain = fixture({ pending: [] });
  await plain.run();
  assert.deepEqual(plain.sent, [['closeExpiredBounty', '253']]);
  const dry = fixture({ pending: [0, 1], dryRun: true });
  assert.equal(await dry.run(), null);
  assert.deepEqual(dry.sent, [['finalizeSubmission', '253', '0'], ['finalizeSubmission', '253', '1']]);
  assert.match(dry.logs.join('\n'), /Dry run: the close follows once these 2 clearing transaction\(s\) are mined/);
});

test('clearingCall allows only the three clearing methods; v1 FORCE_FAIL and "FINALIZE without a result" are gone', () => {
  const bounty = { creator, status: 0n, submissionDeadline: BigInt(DEADLINE), threshold: 80n, quota: 3n };
  const call = (next, result = rejected) => clearingCall({ bounty, signer: creator, chainNow: DEADLINE, submissionId: 7, next, result });
  assert.deepEqual(call('FINALIZE'), { method: 'finalizeSubmission', outcome: 'HARD_FAIL' });
  assert.deepEqual(call('FINALIZE', softFail), { method: 'finalizeSubmission', outcome: 'SOFT_FAIL' });
  assert.deepEqual(call('CLOSE_FAILED', inFlight), { method: 'closeFailedRound' });
  assert.deepEqual(call('EXPIRE_RERUN', softFail), { method: 'expireRerun' });
  assert.match(call('FINALIZE', accepted).stop, /passed its evaluation/);
  assert.match(call('FINALIZE', { ...rejected, hasResult: false }).stop, /reports no result/);
  for (const next of ['DRAW', 'CLOSE_COMMITS', 'PROMOTE', 'AWAIT_ORACLE']) assert.ok(call(next, inFlight).wait, next);
  for (const next of ['FORCE_FAIL', 'START', 'DONE', 'RECOVER_REFUND', 'AWAIT_CREATOR', 'DEAD', 'RERUN']) assert.match(call(next).stop, /unexpected next action/, next);
  assert.deepEqual(CLEARING_METHODS, ['finalizeSubmission', 'closeFailedRound', 'expireRerun']);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(outcomeName), ['NOT_READY', 'NO_RESULT', 'PASS', 'SOFT_FAIL', 'HARD_FAIL', 'UNKNOWN(9)']);
  assert.equal(roundSettlesBy({ deadline: 100n, requestTime: 50n }), 101);
  assert.equal(roundSettlesBy({ deadline: 0n, requestTime: 50n }), 50 + 86401);
  assert.equal(roundSettlesBy({ deadline: 0n, requestTime: 0n }), null);
});
