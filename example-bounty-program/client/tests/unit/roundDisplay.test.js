// v2 round display (item 12): the new local statuses map to their own badges, and a job's
// decision settings are read from either record shape (create: bond, sync: bondWei).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSubmissionStatusLabel, isSubmissionOnChain, isSubmissionPending, isAwaitingRerun, roundVerdict,
} from '../../src/utils/statusDisplay.js';
import { jobDecision, fmtEth, ROUND_ACTION_LABELS, MAX_ROUNDS, RERUN_WINDOW_SECONDS } from '../../src/utils/roundDisplay.js';

test('v2 statuses have their own labels and count as on-chain', () => {
  assert.equal(getSubmissionStatusLabel('SOFT_FAIL_PENDING_FINALIZATION'), 'Soft Fail — Pending Finalization');
  assert.equal(getSubmissionStatusLabel('NO_RESULT_PENDING_CLOSE'), 'No Result — Close Round');
  assert.equal(getSubmissionStatusLabel('AWAITING_RERUN'), 'Awaiting Re-run');
  assert.equal(getSubmissionStatusLabel('AwaitingRerun'), 'Awaiting Re-run');
  for (const s of ['SOFT_FAIL_PENDING_FINALIZATION', 'NO_RESULT_PENDING_CLOSE', 'AWAITING_RERUN', 'AwaitingRerun']) {
    assert.equal(isSubmissionOnChain(s), true, s);
    assert.equal(isSubmissionPending(s), false, s);
  }
  assert.equal(isAwaitingRerun({ status: 'APPROVED', onChainStatus: 'AwaitingRerun' }), true);
  assert.equal(isAwaitingRerun({ status: 'REJECTED', onChainStatus: 'Failed' }), false);
});

test('jobDecision reads both record shapes and takes the jury (K, N) from the bounty', () => {
  const large = { K: 21, M: 16, N: 13, P: 10, timeout: 300 };
  const created = jobDecision({ decisionSettings: { bountyClass: 'large', jury: large, quota: 10, forfeitLine: 8, bond: '1000' } });
  assert.deepEqual([created.jury, created.quota, created.forfeitLine, created.bondWei, created.K, created.N, created.className],
    [large, 10, 8, '1000', 21, 13, 'Large']);
  // a synced record: the jury from getBounty's flat fields, the class by its jury
  const synced = jobDecision({ decisionSettings: { jury: { K: 8, M: 5, N: 4, P: 3, timeout: 300 }, quota: 3, forfeitLine: 2, bondWei: '5' } });
  assert.deepEqual([synced.quota, synced.bondWei, synced.K, synced.N, synced.className], [3, '5', 8, 4, 'Medium']);
  // a custom jury: its own N, no class name
  const custom = jobDecision({ decisionSettings: { jury: { K: 12, M: 9, N: 7, P: 5, timeout: 400 }, quota: 5, forfeitLine: 2 } });
  assert.deepEqual([custom.K, custom.N, custom.className], [12, 7, null]);
  // a pre-item-15 record (a jury index): no jury; N from its class preset
  const old = jobDecision({ decisionSettings: { bountyClass: 'small', jury: 0, quota: 3, forfeitLine: 1 } });
  assert.deepEqual([old.jury, old.N], [null, 4]);
  const v1 = jobDecision({});
  assert.equal(v1.quota, null);
  assert.equal(v1.bondWei, '0');
});

test('helpers', () => {
  assert.equal(fmtEth('1500000000000000'), '0.0015');
  assert.equal(fmtEth('0'), '0');
  assert.equal(MAX_ROUNDS, 6);
  assert.equal(RERUN_WINDOW_SECONDS, 7200);
  for (const a of ['DRAW', 'CLOSE_COMMITS', 'PROMOTE', 'CLOSE_FAILED', 'RERUN', 'EXPIRE_RERUN', 'AWAIT_EXPIRY']) assert.ok(ROUND_ACTION_LABELS[a], a);
});

test('roundVerdict follows the Q-of-N outcome, never the aggregate score (review 2026-11-27, item 5)', () => {
  // scores 100/100/70/70 at threshold 80: the mean is 85, but two of four at Q = 3 is a soft fail
  assert.equal(roundVerdict('PENDING_EVALUATION', { outcome: 'soft_fail', passCount: 2 }), 'soft_fail');
  assert.equal(roundVerdict('SOFT_FAIL_PENDING_FINALIZATION', undefined), 'soft_fail');
  assert.equal(roundVerdict('ACCEPTED_PENDING_CLAIM', undefined), 'pass');
  assert.equal(roundVerdict('REJECTED_PENDING_FINALIZATION', undefined), 'hard_fail');
  // the lens (chain) wins over a stale server status
  assert.equal(roundVerdict('ACCEPTED_PENDING_CLAIM', { outcome: 'soft_fail' }), 'soft_fail');
  assert.equal(roundVerdict('REJECTED_PENDING_FINALIZATION', { outcome: 'not_ready' }), 'hard_fail');
  assert.equal(roundVerdict('Prepared', { outcome: 'no_result' }), null);
});
