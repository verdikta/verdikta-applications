/**
 * Regression tests for issue #39 — Bounty API: stop new submissions to a
 * bounty whose evaluation package can never be evaluated.
 *
 * Covers the shared gate (ensureFreshValidation / unevaluableGateResponse in
 * routes/jobRoutes.js) as exercised through all three submission entry
 * points, plus the persistence side of GET /:jobId/validate that the board's
 * existing "has-errors" card styling (client/src/pages/Home.jsx) depends on.
 */

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

let mockValidateBounty = jest.fn();
jest.mock('../utils/bountyValidator', () => {
  const actual = jest.requireActual('../utils/bountyValidator');
  return {
    ...actual,
    validateBounty: (...args) => mockValidateBounty(...args),
  };
});

let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({ getBounty: (...args) => mockGetBounty(...args) }),
}));

const express = require('express');
const request = require('supertest');
const { ErrorCodes } = require('../utils/apiErrors');
const jobRoutes = require('../routes/jobRoutes');

function buildApp({ withIpfs = true } = {}) {
  const app = express();
  app.use(express.json());
  if (withIpfs) app.locals.ipfsClient = { fetchFromIPFS: jest.fn() };
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
    evaluationCid: 'QmTestCidForSubmitGate',
    classId: 128,
    status: 'OPEN',
    submissionOpenTime: NOW() - 3600,
    submissionCloseTime: NOW() + 3600,
    createdAt: NOW() - 3600,
    submissionCount: 0,
    submissions: [],
    contractAddress: '0xabc123',
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}

const HUNTER = '0x1234567890123456789012345678901234567890';
const VALID_HUNTER_CID = 'a'.repeat(46); // bare CID shape the routes accept

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockGetBounty = jest.fn().mockResolvedValue({ status: 'OPEN' });
  mockValidateBounty = jest.fn();
});

describe('POST /:jobId/submit/prepare — unevaluable gate', () => {
  const JOBID = 100;

  it('returns 409 BOUNTY_UNEVALUABLE when the evaluation package has an ERROR issue', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'query exceeds the arbiters\' 10,000-character cap' }],
    });

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);
    expect(res.body.reason).toContain('10,000-character cap');
  });

  it('proceeds past the gate (no 409) when the package validates clean', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({ valid: true, issues: [] });

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).not.toBe(409);
  });

  it('persists validationStatus on the job so the board reflects it without a separate /validate call', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'bad package' }],
    });

    await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    const stored = mockStorageData.jobs.find((j) => j.jobId === JOBID);
    expect(stored.validationStatus).toBeDefined();
    expect(stored.validationStatus.valid).toBe(false);
    expect(stored.validationStatus.checkedAt).toBeTruthy();
  });

  it('reuses a fresh cached validationStatus instead of calling validateBounty again', async () => {
    setStorage(makeJob({
      jobId: JOBID,
      validationStatus: { valid: false, issues: [{ type: 'X', severity: 'error', message: 'cached error' }], checkedAt: new Date().toISOString() },
    }));

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).toBe(409);
    expect(res.body.reason).toContain('cached error');
    expect(mockValidateBounty).not.toHaveBeenCalled();
  });

  it('re-checks when the cached validationStatus is older than the TTL', async () => {
    setStorage(makeJob({
      jobId: JOBID,
      validationStatus: { valid: false, issues: [{ type: 'X', severity: 'error', message: 'stale error' }], checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    }));
    mockValidateBounty.mockResolvedValue({ valid: true, issues: [] });

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(mockValidateBounty).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(409);
  });

  it('fails open (does not block) when no IPFS client is configured', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'X', severity: 'error', message: 'would be unevaluable' }],
    });

    const res = await request(buildApp({ withIpfs: false }))
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).not.toBe(409);
    expect(mockValidateBounty).not.toHaveBeenCalled();
  });

  it('does not block on a validateBounty crash (infra failure is not proof the package is bad)', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockRejectedValue(new Error('IPFS gateway timeout'));

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/prepare`)
      .send({ hunter: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).not.toBe(409);
  });
});

describe('POST /:jobId/submit/bundle — unevaluable gate', () => {
  const JOBID = 101;

  it('returns 409 BOUNTY_UNEVALUABLE before touching hunterCid upload logic', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'bundle-path bad package' }],
    });

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit/bundle`)
      .send({ hunterAddress: HUNTER, hunterCid: VALID_HUNTER_CID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);
    expect(res.body.reason).toContain('bundle-path bad package');
  });
});

describe('POST /:jobId/submit — unevaluable gate', () => {
  const JOBID = 102;

  it('returns 409 BOUNTY_UNEVALUABLE for a file-upload submission', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'upload-path bad package' }],
    });

    const res = await request(buildApp())
      .post(`/jobs/${JOBID}/submit`)
      .field('hunter', HUNTER)
      .attach('files', Buffer.from('some work product'), 'solution.txt');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);
    expect(res.body.reason).toContain('upload-path bad package');
  });
});

describe('GET /:jobId/validate — persists validationStatus (issue #39)', () => {
  const JOBID = 103;

  it('stores the computed result on the job, not just in the response', async () => {
    setStorage(makeJob({ jobId: JOBID }));
    mockValidateBounty.mockResolvedValue({
      valid: false,
      issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'persisted via /validate' }],
    });

    const res = await request(buildApp()).get(`/jobs/${JOBID}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);

    const stored = mockStorageData.jobs.find((j) => j.jobId === JOBID);
    expect(stored.validationStatus).toBeDefined();
    expect(stored.validationStatus.valid).toBe(false);
    expect(stored.validationStatus.issues.some((i) => i.message === 'persisted via /validate')).toBe(true);
  });
});
