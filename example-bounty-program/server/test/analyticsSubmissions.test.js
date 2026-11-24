/**
 * GET /api/analytics/submissions and /system (v2): outcome buckets from the escrow's Q-of-N rule
 * (checkEvaluationReady's outcome and passCount for rounds still in flight), re-run and bond
 * figures from the synced escrow events, and every configured aggregator's config.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'AB'.repeat(20) } }));
let mockVerdikta = null;
jest.mock('../utils/verdiktaService', () => ({ getVerdiktaService: () => mockVerdikta, isVerdiktaServiceAvailable: () => !!mockVerdikta }));
const mockReady = jest.fn();
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ checkEvaluationReady: (...a) => mockReady(...a) }) }));
let mockJobs = [];
jest.mock('../utils/jobStorage', () => ({ listJobs: jest.fn(async () => ({ jobs: mockJobs })), readStorage: jest.fn(async () => ({ jobs: mockJobs })) }));

const express = require('express');
const request = require('supertest');
const { analyticsCache } = require('../utils/analyticsCacheService');

const app = express();
app.use('/api/analytics', require('../routes/analyticsRoutes'));

beforeEach(() => {
  analyticsCache.clear();
  mockVerdikta = null;
  mockReady.mockReset();
});

test('buckets submissions by the Q-of-N outcome, not acceptance against the threshold', async () => {
  mockReady.mockImplementation(async (bountyId, submissionId) => ({
    // in flight: one pass (acceptance below the threshold, but >= Q scores at it), one hard fail
    // (acceptance above), one soft fail, one dead round, one still running
    0: { ready: true, outcome: 'pass', passCount: 3, scores: { acceptance: 60 } },
    1: { ready: true, outcome: 'hard_fail', passCount: 0, scores: { acceptance: 95 } },
    2: { ready: true, outcome: 'soft_fail', passCount: 2, scores: { acceptance: 85 } },
    3: { ready: false, reason: 'no_result', outcome: 'no_result' },
    4: { ready: false, reason: 'not_ready', outcome: 'not_ready', phaseName: 'commit' },
  })[submissionId]);
  mockJobs = [
    { jobId: 1, threshold: 80, submissions: [0, 1, 2, 3, 4].map((i) => ({ submissionId: i, status: 'PENDING_EVALUATION' })) },
    { jobId: 2, threshold: 80, submissions: [
      { submissionId: 0, status: 'APPROVED', onChainStatus: 'PassedPaid', acceptance: 90, rounds: 2, aggIds: ['0x1', '0x2'], bondReturnedWei: '5000000000000000' },
      { submissionId: 1, status: 'AWAITING_RERUN', onChainStatus: 'AwaitingRerun', rounds: 1 },
      { submissionId: 2, status: 'SOFT_FAIL_PENDING_FINALIZATION' },
      { submissionId: 3, status: 'NO_RESULT_PENDING_CLOSE' },
      { submissionId: 4, status: 'REJECTED', onChainStatus: 'Failed', failureReason: 'RERUN_EXPIRED', bondReturnedWei: '5000000000000000' },
      { submissionId: 5, status: 'REJECTED', onChainStatus: 'Failed', bondForfeitedWei: '5000000000000000' },
      { submissionId: 6, status: 'PendingCreatorApproval', onChainStatus: 'PendingCreatorApproval' },
      { submissionId: 7, status: 'REJECTED_PENDING_FINALIZATION' },
      { submissionId: 8, status: 'Prepared' },
      { submissionId: 9, status: 'APPROVED', onChainStatus: 'PassedPaid', creatorApproved: true },
    ] },
  ];
  const res = await request(app).get('/api/analytics/submissions');
  expect(res.status).toBe(200);
  const d = res.body.data;
  expect(d.byOutcome).toEqual({
    approvedPaid: 2, approvedUnpaid: 0, passPending: 1, awaitingCreator: 1, awaitingRerun: 3,
    noResult: 3, hardFail: 3, evaluating: 1, prepared: 1, unknown: 0
  });
  expect(d.byOutcome.timeout).toBeUndefined();
  // passes by the arbiters (2: the creator approval does not count) against hard fails (3)
  expect(d.passRate).toBe(40);
  expect(d.creatorApproved).toBe(1);
  expect(d.v2).toMatchObject({ rerunSubmissions: 1, bondsReturned: 2, bondReturnedEth: '0.01', bondsForfeited: 1, bondForfeitedEth: '0.005' });
});

test('/system sends every configured aggregator and its config', async () => {
  const cfg = (jury) => ({ jury, K: 6, M: 5, N: 4, P: 3, mPlus: 6, tPlus: 155, responseTimeoutSeconds: 300 });
  mockVerdikta = {
    healthCheck: async () => ({ healthy: true, aggregatorAddress: '0xa0', aggregators: ['0xa0', '0xa1'], keeperAddress: '0xk', config: cfg(0) }),
    getAllAggregatorConfigs: async () => [cfg(0), cfg(1)],
  };
  const res = await request(app).get('/api/analytics/system');
  expect(res.status).toBe(200);
  expect(res.body.data.verdikta.aggregators).toEqual(['0xa0', '0xa1']);
  expect(res.body.data.aggregatorConfigs.map((c) => c.jury)).toEqual([0, 1]);
  expect(res.body.data.aggregatorConfigs[0]).toMatchObject({ mPlus: 6, tPlus: 155 });
});
