/**
 * Regression tests for issue #40 — Bounty diagnostics: flag zero-commit
 * rounds as a likely malformed evaluation package.
 *
 * Mirrors example-arbiters' getAggHistory "LIKELY MALFORMED (no arbiter
 * committed)" rule, which bounty-program's own getAggHistory and
 * GET /:jobId/submissions/:submissionId/diagnose previously lacked — a
 * settled round with zero commits used to be indistinguishable from a
 * generic FAILED (commit phase) node failure.
 */

// jobRoutes.js is a large module with many requires; whichever test runs
// first in this file pays that one-time cold-load cost (~9s observed),
// well past Jest's 5000ms default. Bump it so a slow test runner doesn't
// get misread as a broken assertion.
jest.setTimeout(15000);

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

// bountyValidator: tests set this per-case to simulate a package that fails
// (or passes) validateBounty, while keeping the real IssueType/IssueSeverity.
let mockValidateBounty = jest.fn();
jest.mock('../utils/bountyValidator', () => {
  const actual = jest.requireActual('../utils/bountyValidator');
  return {
    ...actual,
    validateBounty: (...args) => mockValidateBounty(...args),
  };
});

// contractService: configurable per-case chain reads.
let mockGetSubmission = jest.fn();
let mockNextAction = jest.fn();
let mockGetForceFailEligibility = jest.fn();
let mockCheckEvaluationReady = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    contract: {
      getSubmission: (...args) => mockGetSubmission(...args),
      nextAction: (...args) => mockNextAction(...args),
    },
    getForceFailEligibility: (...args) => mockGetForceFailEligibility(...args),
    checkEvaluationReady: (...args) => mockCheckEvaluationReady(...args),
  }),
}));

// verdiktaService: configurable per-case getAggHistory result.
let mockGetAggHistory = jest.fn();
let mockServiceAvailable = true;
jest.mock('../utils/verdiktaService', () => {
  const actual = jest.requireActual('../utils/verdiktaService');
  return {
    ...actual,
    isVerdiktaServiceAvailable: () => mockServiceAvailable,
    getVerdiktaService: () => ({ getAggHistory: (...args) => mockGetAggHistory(...args) }),
  };
});

const express = require('express');
const request = require('supertest');
const { LIKELY_MALFORMED_OUTCOME } = require('../utils/verdiktaService');
const jobRoutes = require('../routes/jobRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.locals.ipfsClient = { fetchFromIPFS: jest.fn() };
  app.use('/jobs', jobRoutes);
  return app;
}

const NOW = () => Math.floor(Date.now() / 1000);

function setStorage(job) {
  mockStorageData = { jobs: [JSON.parse(JSON.stringify(job))], nextId: 1 };
}

function makeJob(overrides = {}) {
  return {
    jobId: 100,
    title: 'Mainnet Bounty 100',
    creator: '0xcreator',
    bountyAmount: 0.005,
    threshold: 90,
    evaluationCid: 'QmTestCidForDiagnose',
    classId: 128,
    status: 'OPEN',
    createdAt: NOW(),
    submissionCount: 1,
    submissions: [
      {
        submissionId: 0,
        status: 'PendingVerdikta',
        submittedAt: NOW() - 3600,
        hunterCid: 'QmHunterCid',
        evalWallet: '0xeval',
        verdiktaAggId: '0x9d02b66c55369fa170307f235598f54c5a2630c1d98d151d417f158442e9001a',
      },
    ],
    contractAddress: '0xabc123',
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockServiceAvailable = true;
  mockGetSubmission = jest.fn().mockResolvedValue({
    status: 1, // PendingVerdikta
    hunter: '0xhunter',
    hunterCid: 'QmHunterCid',
    evalWallet: '0xeval',
    verdiktaAggId: '0x9d02b66c55369fa170307f235598f54c5a2630c1d98d151d417f158442e9001a',
    funder: '0xfunder',
    submittedAt: NOW() - 3600,
    finalizedAt: 0,
    acceptance: 0,
    rejection: 0,
  });
  mockNextAction = jest.fn().mockResolvedValue('FORCE_FAIL');
  mockGetForceFailEligibility = jest.fn().mockResolvedValue({ eligible: true, timeoutAt: NOW() - 60 });
  mockCheckEvaluationReady = jest.fn().mockResolvedValue({ ready: false });
  mockGetAggHistory = jest.fn();
  mockValidateBounty = jest.fn().mockResolvedValue({ valid: true, issues: [] });
});

describe('GET /:jobId/submissions/:submissionId/diagnose — issue #40 zero-commit detection', () => {
  const JOBID = 100;

  it('labels a settled zero-commit round LIKELY MALFORMED and points nextAction at /validate', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetAggHistory.mockResolvedValue({
      found: true,
      outcome: LIKELY_MALFORMED_OUTCOME,
      analysis: { totalSlots: 6, committed: 0 },
    });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/submissions/0/diagnose`);
    expect(res.status).toBe(200);
    const { diagnosis } = res.body;

    expect(diagnosis.checks.aggHistory).toBeDefined();
    expect(diagnosis.checks.aggHistory.outcome).toBe(LIKELY_MALFORMED_OUTCOME);
    expect(diagnosis.checks.aggHistory.likelyMalformed).toBe(true);
    expect(diagnosis.issues.some((i) => i.includes(LIKELY_MALFORMED_OUTCOME))).toBe(true);
    // The contract said FORCE_FAIL, but the diagnosed root cause overrides it.
    expect(diagnosis.nextAction).toBe(`GET /api/jobs/${JOBID}/validate`);
  });

  it('includes the bountyValidator failure directly when the package is malformed', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetAggHistory.mockResolvedValue({
      found: true,
      outcome: LIKELY_MALFORMED_OUTCOME,
      analysis: { totalSlots: 6, committed: 0 },
    });
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [
        {
          type: 'INVALID_PRIMARY_QUERY',
          severity: 'error',
          message: 'primary_query.json query exceeds the maximum allowed length',
        },
      ],
    });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/submissions/0/diagnose`);
    expect(res.status).toBe(200);
    const { diagnosis } = res.body;

    expect(diagnosis.checks.packageValidation.valid).toBe(false);
    expect(diagnosis.issues.some((i) => i.includes('exceeds the maximum allowed length'))).toBe(true);
  });

  it('does not flag a normal non-responding-node failure as malformed', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetAggHistory.mockResolvedValue({
      found: true,
      outcome: 'FAILED (commit phase)',
      analysis: { totalSlots: 6, committed: 3 },
    });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/submissions/0/diagnose`);
    expect(res.status).toBe(200);
    const { diagnosis } = res.body;

    expect(diagnosis.checks.aggHistory).toBeUndefined();
    expect(diagnosis.issues.some((i) => i.includes(LIKELY_MALFORMED_OUTCOME))).toBe(false);
    expect(diagnosis.nextAction).toBe('FORCE_FAIL');
  });
});
