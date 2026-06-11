/**
 * Regression tests for windowed-bounty submission handling.
 *
 * Covers the two issues reported by a test agent:
 *  2. GET /submissions misreported a PendingCreatorApproval submission as
 *     PENDING_EVALUATION (no case in mapStatus → catch-all default).
 *  3. The start path handed out startPreparedSubmission calldata for a submission
 *     still in its creator-approval window (would revert). The /start endpoint now
 *     gates on live on-chain status.
 */

// ---------------------------------------------------------------------------
// In-memory storage (must be prefixed with "mock" for jest.mock scope rules)
// ---------------------------------------------------------------------------
let mockStorageData = { jobs: [], nextId: 0 };

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_path, data) => {
        mockStorageData = JSON.parse(data);
        return Promise.resolve();
      }),
      rename: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../config', () => ({
  config: {
    network: 'base-sepolia',
    bountyEscrowAddress: '0xabc123',
    chainId: 84532,
    explorer: 'https://sepolia.basescan.org',
  },
}));

// Configurable on-chain submission read used by the /start live-status gate.
let mockGetSubmission = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({ contract: { getSubmission: (...args) => mockGetSubmission(...args) } }),
}));

const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobRoutes);
  return app;
}

const HUNTER = '0x' + '1'.repeat(40);
const NOW = () => Math.floor(Date.now() / 1000);

function setStorage(job) {
  mockStorageData = { jobs: [JSON.parse(JSON.stringify(job))], nextId: 1 };
}

function makeJob(overrides = {}) {
  return {
    jobId: 0,
    title: 'Windowed Bounty',
    creator: '0xcreator',
    bountyAmount: 0.01,
    threshold: 70,
    evaluationCid: 'QmTestCid',
    status: 'OPEN',
    createdAt: NOW(),
    submissionCount: 1,
    submissions: [],
    contractAddress: '0xabc123',
    onChain: true,
    syncedFromBlockchain: true,
    creatorAssessmentWindowSize: 3600,
    ...overrides,
  };
}

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockGetSubmission = jest.fn();
});

describe('Windowed submission status + start gating', () => {
  // ----- Issue 2: status mapping -----
  it('GET /submissions reports PENDING_CREATOR_APPROVAL (not PENDING_EVALUATION) for an in-window submission', async () => {
    const windowEnd = NOW() + 1800;
    setStorage(makeJob({
      submissions: [{
        submissionId: 0,
        hunter: HUNTER,
        status: 'PendingCreatorApproval',
        creatorWindowEnd: windowEnd,
      }],
    }));

    const res = await request(buildApp()).get('/jobs/0/submissions');
    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    const sub = res.body.submissions[0];
    expect(sub.status).toBe('PENDING_CREATOR_APPROVAL');
    expect(sub.status).not.toBe('PENDING_EVALUATION');
    expect(sub.creatorWindowEnd).toBe(windowEnd);
    expect(sub.creatorWindowSecondsRemaining).toBeGreaterThan(0);
    expect(sub.score).toBeNull();
  });

  // ----- Issue 3: /start refuses while the window is open (live on-chain truth) -----
  it('POST /start refuses with CREATOR_WINDOW_OPEN when on-chain status is PendingCreatorApproval in-window, even if cache says otherwise', async () => {
    const windowEnd = NOW() + 1800;
    // Cache deliberately stale (the reported failure mode): says PENDING_EVALUATION.
    setStorage(makeJob({
      submissions: [{ submissionId: 0, hunter: HUNTER, status: 'PENDING_EVALUATION' }],
    }));
    // Chain truth: status 5 (PendingCreatorApproval), window still open.
    mockGetSubmission.mockResolvedValue({
      status: 5,
      creatorWindowEnd: windowEnd,
      ethMaxBudget: { toString: () => '1200000000000000' },
    });

    const res = await request(buildApp())
      .post('/jobs/0/submissions/0/start')
      .send({ hunter: HUNTER });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CREATOR_WINDOW_OPEN');
    expect(res.body.secondsRemaining).toBeGreaterThan(0);
    expect(res.body.nextStep).toMatch(/approve-as-creator/);
  });

  it('POST /start emits startPreparedSubmission calldata once on-chain status is Prepared', async () => {
    setStorage(makeJob({
      creatorAssessmentWindowSize: 0,
      submissions: [{ submissionId: 0, hunter: HUNTER, status: 'Prepared', ethMaxBudget: '1200000000000000' }],
    }));
    mockGetSubmission.mockResolvedValue({
      status: 0,
      creatorWindowEnd: 0,
      ethMaxBudget: { toString: () => '1200000000000000' },
    });

    const res = await request(buildApp())
      .post('/jobs/0/submissions/0/start')
      .send({ hunter: HUNTER });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transaction.data).toMatch(/^0x[0-9a-f]+$/i);
    expect(res.body.transaction.value).toBe('1200000000000000');
  });
});
