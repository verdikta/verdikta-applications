// Closing this wallet's expired bounty first clears the claims that block closeExpiredBounty ("active evaluation -
// finalize first"). Mainnet #253: the opponent's five rejected claims sat at PendingVerdikta / FINALIZE for good.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecover } from '../recover_funds.js';
import { verifyTransaction, clearingCall, resultPasses, CLEARING_METHODS } from '../_transaction-guards.js';

const creator = '0x1111111111111111111111111111111111111111', opponent = '0x2222222222222222222222222222222222222222';
const policy = { maxValueWei: '1000', maxTotalWei: '1000000000000000', maxGasLimit: '500000', maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' };
const DEADLINE = 1_800_000_000, iso = (s) => new Date(s * 1000).toISOString();
// getOracleResult: scores = [DONT_FUND, FUND] on 1e6; the escrow passes FUND / 1e4 >= threshold (80 here).
const rejected = { started: true, hasResult: true, settled: true, failed: false, scores: [900000n, 100000n], justificationCids: 'bafy', startTimestamp: BigInt(DEADLINE - 7200) };
const accepted = { ...rejected, scores: [100000n, 900000n] };

function fixture({ signer = creator, chainNow = DEADLINE + 60, pending = [0, 1, 2, 3, 4], next = {}, results = {}, status = 0n, dryRun = false } = {}) {
  const sent = [], logs = [], state = { pending: [...pending] };
  const bounty = { creator, status, submissionDeadline: BigInt(DEADLINE), threshold: 80n };
  const escrow = {
    getBounty: async () => bounty,
    canBeClosed: async () => state.pending.length === 0 && Number(bounty.status) === 0 && chainNow >= DEADLINE,
    pendingSubmissionIds: async () => state.pending.map(BigInt),
    nextAction: async (_, id) => next[id] ?? 'FINALIZE',
    getOracleResult: async (_, id) => results[id] ?? rejected,
    verdikta: async () => '0x3333333333333333333333333333333333333333',
    responseTimeoutSeconds: async () => 600n, // the aggregator, read through the same stub
  };
  const provider = { destroy() {}, getBlock: async () => ({ timestamp: chainNow }) };
  const lib = {
    getNetwork: () => 'base', providerFor: () => provider, preflightDeployment: async () => {}, loadSpendPolicy: async () => policy,
    loadWallet: async () => ({ address: signer, connect() { return this; } }), isDryRun: () => dryRun,
    sendTx: async (s, method, tx, opts) => {
      verifyTransaction(tx, { network: 'base', method, args: opts.args, value: 0n, maxValueWei: policy.maxValueWei });
      sent.push([method, ...opts.args.map(String)]);
      if (dryRun) return null;
      if (method !== 'closeExpiredBounty') state.pending = state.pending.filter((id) => BigInt(id) !== opts.args[1]);
      return { status: 1, hash: `0x${'ab'.repeat(32)}`, logs: [] };
    },
  };
  const run = (close = '253') => runRecover(lib, { close, contract: () => escrow, log: (l) => logs.push(l) });
  return { run, sent, logs, state };
}

test('the live shape: five rejected claims are finalized, then the bounty closes', async () => {
  const f = fixture();
  const receipt = await f.run();
  assert.ok(receipt);
  assert.deepEqual(f.sent, [...[0, 1, 2, 3, 4].map((id) => ['finalizeSubmission', '253', String(id)]), ['closeExpiredBounty', '253']]);
  assert.match(f.logs.join('\n'), /5 pending claim\(s\) blocking the close/);
});

test('a timed-out round is failed, not finalized', async () => {
  const f = fixture({ pending: [0, 1], next: { 1: 'FORCE_FAIL' }, results: { 1: { ...rejected, hasResult: false, scores: [] } } });
  await f.run();
  assert.deepEqual(f.sent, [['finalizeSubmission', '253', '0'], ['failTimedOutSubmission', '253', '1'], ['closeExpiredBounty', '253']]);
});

test('one claim still being evaluated: nothing is sent, and the retry time is given', async () => {
  const f = fixture({ next: { 2: 'AWAIT_ORACLE' }, results: { 2: { ...rejected, hasResult: false, scores: [], startTimestamp: BigInt(DEADLINE + 30) } } });
  await assert.rejects(f.run(), new RegExp(`not closed and nothing was sent: Submission 2 is still being evaluated\\. Retry the close after ${iso(DEADLINE + 630).replace(/\./g, '\\.')}`));
  assert.deepEqual(f.sent, []);
});

test('a close never pays the claimant: a passing or undecided result stops it', async () => {
  const pass = fixture({ results: { 3: accepted } });
  await assert.rejects(pass.run(), /Submission 3 passed its evaluation \(acceptance 90, threshold 80\): finalizing it pays the claimant/);
  assert.deepEqual(pass.sent, []);
  const undecided = fixture({ results: { 0: { ...rejected, hasResult: false, scores: [] } } });
  await assert.rejects(undecided.run(), /Submission 0: its jury round timed out with enough answers but no stored result/);
  assert.deepEqual(undecided.sent, []);
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

test('clearingCall allows only the two clearing methods, and resultPasses is the escrow rule', () => {
  const bounty = { creator, status: 0n, submissionDeadline: BigInt(DEADLINE), threshold: 80n };
  const call = (next, result = rejected) => clearingCall({ bounty, signer: creator, chainNow: DEADLINE, submissionId: 7, next, result });
  assert.deepEqual(call('FINALIZE'), { method: 'finalizeSubmission' });
  assert.deepEqual(call('FORCE_FAIL', { ...rejected, hasResult: false }), { method: 'failTimedOutSubmission' });
  assert.ok(call('AWAIT_ORACLE').wait);
  for (const next of ['START', 'DONE', 'RECOVER_REFUND', 'AWAIT_CREATOR', 'DEAD']) assert.match(call(next).stop, /unexpected next action/);
  assert.deepEqual(CLEARING_METHODS, ['finalizeSubmission', 'failTimedOutSubmission']);
  assert.equal(resultPasses([200000n, 800000n], 80), true); // exactly the threshold passes
  assert.equal(resultPasses([200001n, 799999n], 80), false);
  assert.equal(resultPasses([0n, 1_000_001n], 80), false); // out of scale: invalid, never a pass
  assert.equal(resultPasses([1n], 0), false);
});
