/**
 * Regression tests for issue #14 — Validate returns red error for AWARDED
 * (and other terminal) bounties, making every successfully-completed bounty
 * look defective on the board.
 *
 * Two angles covered:
 *  1. Pure-function unit tests for `chainStatusIssue()` so the mapping
 *     "OPEN → no issue, terminal → info, unknown → error" is
 *     independently locked in.
 *  2. Integration tests for GET /:jobId/validate that mock the on-chain
 *     `getBounty` response for each of the four real on-chain states plus
 *     an unknown state, asserting the right severity / valid combination.
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

// Replace the format-checker with a fixed "format is valid" result so the
// tests isolate ONLY the on-chain-status branch behaviour.
jest.mock('../utils/bountyValidator', () => {
  const actual = jest.requireActual('../utils/bountyValidator');
  return {
    ...actual,
    // Fresh object per call: the route mutates result.issues/result.valid in
    // place, so caching the same {issues: []} would leak state between tests.
    validateBounty: jest.fn().mockImplementation(() => Promise.resolve({ valid: true, issues: [] })),
  };
});

// Configurable on-chain bounty read. Tests set this per-case.
let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({ getBounty: (...args) => mockGetBounty(...args) }),
}));

const express = require('express');
const request = require('supertest');
const {
  chainStatusIssue,
  isTerminalBountyStatus,
  IssueSeverity,
  IssueType,
  TERMINAL_BOUNTY_STATUSES,
} = require('../utils/bountyValidator');
const jobRoutes = require('../routes/jobRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  // The real route handler reads ipfsClient from app.locals; supply a stub so
  // the handler never reaches an "IPFS client not available" 500 even though
  // we mocked out the only consumer (validateBounty).
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
    jobId: 106,
    title: 'Completed Bounty',
    creator: '0xcreator',
    bountyAmount: 0.005,
    threshold: 90,
    evaluationCid: 'QmTestCidForValidate',
    status: 'OPEN',
    createdAt: NOW(),
    submissionCount: 1,
    submissions: [],
    contractAddress: '0xabc123',
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockGetBounty = jest.fn();
});

describe('chainStatusIssue() helper (pure-function mapping)', () => {
  it('returns null for OPEN so we never add an issue for active bounties', () => {
    expect(chainStatusIssue('OPEN')).toBeNull();
  });

  it('returns null for null/undefined input (defensive against missing chain read)', () => {
    expect(chainStatusIssue(null)).toBeNull();
    expect(chainStatusIssue(undefined)).toBeNull();
  });

  for (const terminal of ['EXPIRED', 'AWARDED', 'CLOSED']) {
    it(`classifies ${terminal} as INFO + does NOT invalidate the package`, () => {
      const out = chainStatusIssue(terminal);
      expect(out).not.toBeNull();
      expect(out.issue.type).toBe(IssueType.CHAIN_STATUS);
      expect(out.issue.severity).toBe(IssueSeverity.INFO);
      expect(out.invalidatesPackage).toBe(false);
      expect(out.issue.message).toContain(terminal);
      // Crucial: not ERROR. The bug was that all non-OPEN statuses were ERROR.
      expect(out.issue.severity).not.toBe(IssueSeverity.ERROR);
    });
  }

  it('classifies unknown statuses as ERROR and DOES invalidate the package', () => {
    const out = chainStatusIssue('SOMETHING_NEW');
    expect(out).not.toBeNull();
    expect(out.issue.severity).toBe(IssueSeverity.ERROR);
    expect(out.invalidatesPackage).toBe(true);
  });
});

describe('isTerminalBountyStatus() set membership', () => {
  it('is true exactly for EXPIRED/AWARDED/CLOSED', () => {
    expect(TERMINAL_BOUNTY_STATUSES.has('EXPIRED')).toBe(true);
    expect(TERMINAL_BOUNTY_STATUSES.has('AWARDED')).toBe(true);
    expect(TERMINAL_BOUNTY_STATUSES.has('CLOSED')).toBe(true);
  });
  it('is false for OPEN and any other string', () => {
    expect(isTerminalBountyStatus('OPEN')).toBe(false);
    expect(isTerminalBountyStatus('WHATEVER')).toBe(false);
    expect(isTerminalBountyStatus('')).toBe(false);
    expect(isTerminalBountyStatus(null)).toBe(false);
    expect(isTerminalBountyStatus(undefined)).toBe(false);
    expect(isTerminalBountyStatus(123)).toBe(false);
  });
});

describe('GET /:jobId/validate — issue #14 terminal-state classification', () => {
  // The exact on-chain truth nigelon cited in the issue body.
  const JOBID = 106;

  it('OPEN bounties return valid:true with no CHAIN_STATUS issue', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetBounty.mockResolvedValue({ status: 'OPEN' });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.issues.find((i) => i.type === IssueType.CHAIN_STATUS)).toBeUndefined();
  });

  for (const [name, chainStatus] of [
    ['EXPIRED', 'EXPIRED'],
    ['AWARDED', 'AWARDED'],
    ['CLOSED', 'CLOSED'],
  ]) {
    it(`${name}: valid:true with an INFO CHAIN_STATUS issue (does NOT look defective)`, async () => {
      setStorage(makeJob({ jobId: JOBID }));
      mockGetBounty.mockResolvedValue({ status: chainStatus });

      const res = await request(buildApp()).get(`/jobs/${JOBID}/validate`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      const chainIssue = res.body.issues.find((i) => i.type === IssueType.CHAIN_STATUS);
      expect(chainIssue).toBeDefined();
      expect(chainIssue.severity).toBe(IssueSeverity.INFO);
      // Most importantly: completed bounties no longer raise the red-error chip.
      expect(chainIssue.severity).not.toBe(IssueSeverity.ERROR);
      expect(res.body.issues.filter((i) => i.severity === IssueSeverity.ERROR)).toHaveLength(0);
    });
  }

  it('unknown on-chain status still raises ERROR + invalidates (legacy behaviour preserved)', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetBounty.mockResolvedValue({ status: 'SOMETHING_NEW' });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    const chainIssue = res.body.issues.find((i) => i.type === IssueType.CHAIN_STATUS);
    expect(chainIssue).toBeDefined();
    expect(chainIssue.severity).toBe(IssueSeverity.ERROR);
  });

  it('returns NOT_ON_CHAIN with ERROR severity when the chain read fails with bad bountyId', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockGetBounty.mockRejectedValue(new Error('bad bountyId: not found'));

    const res = await request(buildApp()).get(`/jobs/${JOBID}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    const issue = res.body.issues.find((i) => i.type === IssueType.NOT_ON_CHAIN);
    expect(issue).toBeDefined();
    expect(issue.severity).toBe(IssueSeverity.ERROR);
  });
});
