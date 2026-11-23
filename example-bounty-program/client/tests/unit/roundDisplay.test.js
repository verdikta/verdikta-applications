// v2 round display (item 12): the new local statuses map to their own badges, and a job's
// decision settings are read from either record shape (create: bond, sync: bondWei).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSubmissionStatusLabel, isSubmissionOnChain, isSubmissionPending, isAwaitingRerun,
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

test('jobDecision reads both record shapes and takes N from the jury preset', () => {
  const created = jobDecision({ decisionSettings: { bountyClass: 'large', jury: 2, quota: 10, forfeitLine: 8, bond: '1000' } });
  assert.deepEqual([created.jury, created.quota, created.forfeitLine, created.bondWei, created.N], [2, 10, 8, '1000', 13]);
  const synced = jobDecision({ decisionSettings: { jury: 1, quota: 3, forfeitLine: 2, bondWei: '5' } });
  assert.deepEqual([synced.quota, synced.bondWei, synced.N], [3, '5', 4]);
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
