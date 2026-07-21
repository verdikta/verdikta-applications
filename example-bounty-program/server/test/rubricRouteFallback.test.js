/**
 * GET /api/jobs/:id/rubric — package-derive fallback for an empty rubricCid.
 *
 * The chain-sync service never writes the convenience-cache `rubricCid`, so
 * bounties created directly on-chain 404'd this endpoint even though their
 * rubric exists in the (authoritative) evaluationCid package — observed live
 * on Base mainnet bounty 152 (2026-07-21): the evaluation page showed the
 * rubric while /rubric returned "does not have a rubric CID".
 *
 * These tests pin the fix: an empty pointer is re-derived from
 * manifest.additional[gradingRubric].hash, persisted back (read-side heal,
 * same direction as scripts/healRubricCid.js), and served; a job whose
 * package genuinely has no rubric still 404s; a stored pointer is served
 * as-is with zero package fetches (no new IPFS cost on the common path).
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

const express = require('express');
const request = require('supertest');
const AdmZip = require('adm-zip');
const jobRoutes = require('../routes/jobRoutes');

const RUBRIC_CID = 'QmRubricHashFromPackage111111111111111111111111';
const EVAL_CID = 'QmEvaluationPackage22222222222222222222222222222';
const RUBRIC_JSON = { version: 'rubric-1', title: 'Test rubric', criteria: [] };

/** Build the evaluationCid archive: manifest.json referencing the rubric. */
function evaluationZipBuffer({ withRubricRef = true } = {}) {
  const zip = new AdmZip();
  const manifest = {
    version: '1.0',
    juryParameters: { AI_NODES: [] },
    additional: withRubricRef ? [{ name: 'gradingRubric', hash: RUBRIC_CID }] : [],
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return zip.toBuffer();
}

function fakeIpfsClient(files) {
  const calls = [];
  return {
    calls,
    fetchFromIPFS: jest.fn(async (cid) => {
      calls.push(cid);
      if (cid in files) return files[cid];
      throw new Error(`not pinned: ${cid}`);
    }),
  };
}

function buildApp(ipfsClient) {
  const app = express();
  app.use(express.json());
  app.locals.ipfsClient = ipfsClient;
  app.use('/jobs', jobRoutes);
  return app;
}

function setStorage(job) {
  mockStorageData = { jobs: [JSON.parse(JSON.stringify(job))], nextId: 1 };
}

function makeJob(overrides = {}) {
  return {
    jobId: 0,
    title: 'Chain-synced bounty',
    creator: '0xcreator',
    bountyAmount: 0.01,
    threshold: 92,
    status: 'OPEN',
    createdAt: Math.floor(Date.now() / 1000),
    submissions: [],
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
});

describe('GET /jobs/:id/rubric — package-derive fallback', () => {
  it('derives the rubric from the evaluationCid package when rubricCid is empty (the chain-sync case)', async () => {
    setStorage(makeJob({ evaluationCid: EVAL_CID /* no rubricCid — sync never writes it */ }));
    const ipfs = fakeIpfsClient({
      [EVAL_CID]: evaluationZipBuffer(),
      [RUBRIC_CID]: Buffer.from(JSON.stringify(RUBRIC_JSON)),
    });

    const res = await request(buildApp(ipfs)).get('/jobs/0/rubric');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.rubric).toEqual(RUBRIC_JSON);
    expect(res.body.meta.rubricCid).toBe(RUBRIC_CID);
  });

  it('persists the derived pointer (read-side heal) so the next read skips the package', async () => {
    setStorage(makeJob({ evaluationCid: EVAL_CID }));
    const ipfs = fakeIpfsClient({
      [EVAL_CID]: evaluationZipBuffer(),
      [RUBRIC_CID]: Buffer.from(JSON.stringify(RUBRIC_JSON)),
    });
    const app = buildApp(ipfs);

    await request(app).get('/jobs/0/rubric').expect(200);
    // The heal round-tripped through real jobStorage into "disk".
    expect(mockStorageData.jobs[0].rubricCid).toBe(RUBRIC_CID);

    // Second read: pointer-direct — the package archive is not re-fetched.
    const callsBefore = ipfs.calls.filter((c) => c === EVAL_CID).length;
    await request(app).get('/jobs/0/rubric').expect(200);
    expect(ipfs.calls.filter((c) => c === EVAL_CID).length).toBe(callsBefore);
  });

  it('still 404s when the package genuinely has no gradingRubric reference', async () => {
    setStorage(makeJob({ evaluationCid: EVAL_CID }));
    const ipfs = fakeIpfsClient({ [EVAL_CID]: evaluationZipBuffer({ withRubricRef: false }) });

    const res = await request(buildApp(ipfs)).get('/jobs/0/rubric');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No rubric available');
    expect(mockStorageData.jobs[0].rubricCid).toBeUndefined(); // nothing healed
  });

  it('404s (rather than throwing) when the package fetch itself fails', async () => {
    setStorage(makeJob({ evaluationCid: EVAL_CID }));
    const ipfs = fakeIpfsClient({}); // every fetch rejects

    const res = await request(buildApp(ipfs)).get('/jobs/0/rubric');

    expect(res.status).toBe(404);
  });

  it('serves a stored rubricCid pointer-direct with zero package fetches (unchanged fast path)', async () => {
    setStorage(makeJob({ evaluationCid: EVAL_CID, rubricCid: RUBRIC_CID }));
    const ipfs = fakeIpfsClient({ [RUBRIC_CID]: Buffer.from(JSON.stringify(RUBRIC_JSON)) });

    const res = await request(buildApp(ipfs)).get('/jobs/0/rubric');

    expect(res.status).toBe(200);
    expect(res.body.rubric).toEqual(RUBRIC_JSON);
    expect(ipfs.calls).toEqual([RUBRIC_CID]); // never touched the archive
  });
});
