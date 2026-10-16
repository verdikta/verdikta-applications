/**
 * POST /jobs/create refuses a bounty whose composed evaluation query is over the
 * arbiters' cap (issue #36), before pinning anything; the cap is
 * @verdikta/common's PRIMARY_QUERY_MAX_CHARS, 32,000 since 1.8.0 (issue #41).
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', chainId: 84532, bountyEscrowAddress: '0x' + '11'.repeat(20), submissionDefaults: { maxOracleFeeWei: '20000000000000', alpha: 500, estimatedBaseCostWei: '10000000000000', maxFeeBasedScaling: 3 } } }));
jest.mock('../utils/verdiktaService', () => ({ isVerdiktaServiceAvailable: () => false }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ provider: {}, contract: {} }) }));
jest.mock('../utils/jobStorage', () => ({ readStorage: jest.fn(async () => ({ jobs: [] })), createJob: jest.fn(async (data) => ({ ...data, jobId: 0 })), listJobs: jest.fn(async () => []) }));
jest.mock('../utils/archiveGenerator', () => ({
  ...jest.requireActual('../utils/archiveGenerator'),
  createPrimaryCIDArchive: jest.fn(async () => ({ archivePath: '/tmp/verdikta-mocked-archive-does-not-exist.zip' })),
}));
jest.mock('@verdikta/common', () => ({ ...jest.requireActual('@verdikta/common'), classMap: { getClass: () => ({ status: 'ACTIVE', models: [{ provider: 'openai', model: 'test-model' }] }) } }));

const express = require('express');
const request = require('supertest');
const { PRIMARY_QUERY_MAX_CHARS } = require('@verdikta/common');
const storage = require('../utils/jobStorage');
const archive = require('../utils/archiveGenerator');
const { measureEvaluationQuery } = jest.requireActual('../utils/archiveGenerator');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/jobs', require('../routes/jobRoutes'));
const cid = 'Qm' + 'a'.repeat(44);
const upload = jest.fn(async () => cid);
let fetchedRubric = {};
app.locals.ipfsClient = { uploadToIPFS: upload, fetchFromIPFS: async () => Buffer.from(JSON.stringify(fetchedRubric)) };

const criterion = (id, text) => ({ id, label: id, must: true, weight: 0, description: text });
const rubricJson = (criteria) => ({ title: 'Rubric', criteria, forbiddenContent: ['Plagiarism'] });
const body = {
  title: 'Cap test',
  description: 'Write a short report.',
  workProductType: 'Report',
  creator: '0x' + '11'.repeat(20),
  bountyAmount: 0.001,
  threshold: 80,
  juryNodes: [{ provider: 'openai', model: 'test-model', weight: 1, runs: 1 }],
};
const pinFetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ IpfsHash: cid }) }));
const realFetch = global.fetch;

const realPinningKey = process.env.IPFS_PINNING_KEY;
beforeEach(() => { jest.clearAllMocks(); global.fetch = pinFetch; fetchedRubric = {}; process.env.IPFS_PINNING_KEY = 'test-key'; });
afterAll(() => {
  global.fetch = realFetch;
  if (realPinningKey === undefined) delete process.env.IPFS_PINNING_KEY; else process.env.IPFS_PINNING_KEY = realPinningKey;
});
afterEach(() => { delete process.env.MAX_EVALUATION_QUERY_CHARS; });

// The query a bounty with `criteria` and a description of `n` characters composes to.
const composed = (criteria, description) => measureEvaluationQuery({
  workProductType: body.workProductType, jobTitle: body.title, jobDescription: description,
  rubricCriteria: criteria, forbiddenContent: ['Plagiarism'],
}).composedLength;

describe('POST /jobs/create composed-query cap', () => {
  const criteria = [criterion('accuracy', 'Every figure matches its cited source.'), criterion('format', 'Delivered as markdown.')];
  const base = composed(criteria, '');
  const fitting = 'd'.repeat(PRIMARY_QUERY_MAX_CHARS - base);

  it('uses @verdikta/common PRIMARY_QUERY_MAX_CHARS (32,000)', () => {
    expect(PRIMARY_QUERY_MAX_CHARS).toBe(32000);
  });

  it('accepts a query of exactly the cap and pins it', async () => {
    expect(composed(criteria, fitting)).toBe(PRIMARY_QUERY_MAX_CHARS);
    const res = await request(app).post('/jobs/create').send({ ...body, description: fitting, rubricJson: rubricJson(criteria) });
    expect(res.status).toBe(200);
    expect(pinFetch).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('refuses one character more with 400 QUERY_TOO_LONG and a breakdown, pinning nothing', async () => {
    const res = await request(app).post('/jobs/create').send({ ...body, description: fitting + 'd', rubricJson: rubricJson(criteria) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'QUERY_TOO_LONG', composedLength: 32001, limit: 32000, over: 1 });
    const b = res.body.breakdown;
    expect(b.description).toBe(fitting.length + 1);
    expect(b.title).toBe(body.title.length);
    expect(b.criteria).toEqual([{ id: 'accuracy', chars: 'accuracy'.length + 38 }, { id: 'format', chars: 'format'.length + 22 }]);
    expect(b.template + b.workProductType + b.title + b.description + b.forbiddenContent
      + b.criteria.reduce((n, c) => n + c.chars, 0)).toBe(32001);
    expect(res.body.fix).toMatch(/at least 1 characters/);
    expect(pinFetch).not.toHaveBeenCalled();
    expect(archive.createPrimaryCIDArchive).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(storage.createJob).not.toHaveBeenCalled();
  });

  it('accepts a query over the old 10,000 limit (testnet bounty 14 was 10,005)', async () => {
    const description = 'd'.repeat(10005 - base);
    expect(composed(criteria, description)).toBe(10005);
    const res = await request(app).post('/jobs/create').send({ ...body, description, rubricJson: rubricJson(criteria) });
    expect(res.status).toBe(200);
  });

  it('measures criteria fetched from a rubricCid the same way', async () => {
    fetchedRubric = { criteria: [criterion('long', 'c'.repeat(PRIMARY_QUERY_MAX_CHARS))], forbiddenContent: ['Plagiarism'] };
    const res = await request(app).post('/jobs/create').send({ ...body, rubricCid: cid });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUERY_TOO_LONG');
    expect(res.body.breakdown.criteria).toEqual([{ id: 'long', chars: 4 + PRIMARY_QUERY_MAX_CHARS }]);
    expect(res.body.tips[0]).toContain('"long"');
    expect(upload).not.toHaveBeenCalled();
  });

  it('honours a MAX_EVALUATION_QUERY_CHARS override', async () => {
    process.env.MAX_EVALUATION_QUERY_CHARS = '10000';
    const res = await request(app).post('/jobs/create').send({ ...body, description: 'd'.repeat(10005 - base), rubricJson: rubricJson(criteria) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ composedLength: 10005, limit: 10000 });
  });
});

describe('hunter archives keep the 10,000 cap', () => {
  it('archiveShapeValidator uses BCID_QUERY_MAX_CHARS', () => {
    const { BCID_QUERY_MAX_CHARS } = require('@verdikta/common');
    expect(BCID_QUERY_MAX_CHARS).toBe(10000);
    const src = require('fs').readFileSync(require.resolve('../utils/archiveShapeValidator'), 'utf8');
    expect(src).toMatch(/const MAX_QUERY_LEN = BCID_QUERY_MAX_CHARS;/);
  });
});
