/**
 * Anonymous single-bounty reads. AI jurors verify a bounty from a link with their
 * providers' web tools (plain GET, no custom headers), so GET/HEAD of exactly
 * /api/jobs/:id and /api/jobs/:id/onchain-status are served without a key —
 * rate-limited per client, onchain-status as a short shared snapshot — while every
 * other /api/jobs path (create, submit, admin) still answers 401.
 */
let mockStorageData = { jobs: [], nextId: 0 };
const mockBots = { bots: [{ id: 'bot-test', apiKey: 'bot-valid-key', active: true }] };
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const isBots = (p) => String(p).endsWith('bots.json');
  return { ...actual,
    existsSync: (p) => (isBots(p) ? true : actual.existsSync(p)),
    readFileSync: (p, ...rest) => (isBots(p) ? JSON.stringify(mockBots) : actual.readFileSync(p, ...rest)),
    promises: { ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined), access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_p, data) => { mockStorageData = JSON.parse(data); return Promise.resolve(); }),
      rename: jest.fn().mockResolvedValue(undefined) } };
});
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0xabc123', chainId: 84532,
  explorer: 'https://sepolia.basescan.org', publicReadRateLimitWindowMs: 60000, publicReadRateLimitMax: 5,
  publicOnchainStatusCacheMs: 30000 } }));

const { ethers } = require('ethers');
const CREATOR = '0x' + 'c'.repeat(40);
const HUNTER = '0x' + '1'.repeat(40);
const FUNDED = 1000000000000000n;
const CREATED_AT = 1790000000;
const chainStruct = () => ({ creator: CREATOR, evaluationCid: 'QmEval', requestedClass: 128n, threshold: 85n, payoutWei: FUNDED,
  createdAt: BigInt(CREATED_AT), submissionDeadline: BigInt(CREATED_AT + 3600), status: 0n, winner: ethers.ZeroAddress,
  submissions: 0n, targetHunter: HUNTER, creatorDeterminationPayment: FUNDED, arbiterDeterminationPayment: FUNDED,
  creatorAssessmentWindowSize: 0n,
  oracle: { maxOracleFee: 20000000000000n, alpha: 500n, estimatedBaseCost: 10000000000000n, maxFeeBasedScaling: 3n } });

let mockGetBounty;
jest.mock('../utils/contractService', () => {
  const actual = jest.requireActual('../utils/contractService');
  const service = Object.create(actual.ContractService.prototype);
  service.contract = {
    getBounty: (...args) => mockGetBounty(...args),
    requiredPrepay: async () => 240000000000000n,
    prepareCutoff: async () => 1790003590n
  };
  return { ...actual, getContractService: () => service };
});

process.env.FRONTEND_CLIENT_KEY = 'frontend-test-key';
delete process.env.FRONTEND_ALLOWED_ORIGINS;

const express = require('express');
const request = require('supertest');
const clientIdentification = require('../middleware/clientIdentification');
const { isPublicRead, publicReadLimiter } = clientIdentification;
const jobRoutes = require('../routes/jobRoutes');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(clientIdentification);
app.use('/api/jobs', jobRoutes);

const submission = (over = {}) => ({ submissionId: 0, hunter: HUNTER, hunterCid: 'QmHunterWork', status: 'APPROVED',
  fileCount: 1, files: [{ filename: 'answer.md', size: 120, description: 'the answer' }],
  clientType: 'bot', clientId: 'bot-test', ...over });
const job = (jobId, over = {}) => ({ jobId, title: `Bounty ${jobId}`, description: 'Wager terms: Jets beat the Patriots.',
  creator: CREATOR, bountyAmount: '0.001', bountyAmountWei: '1000000000000000', threshold: 85, evaluationCid: 'QmEval',
  status: 'OPEN', createdAt: Math.floor(Date.now() / 1000), submissionCloseTime: CREATED_AT + 3600, onChain: true,
  syncedFromBlockchain: true, submissions: [submission()], ...over });

let rpcReads;
beforeEach(() => {
  publicReadLimiter.reset();
  rpcReads = 0;
  mockGetBounty = async () => { rpcReads += 1; return chainStruct(); };
  mockStorageData = { jobs: [job(5), job(6, { publicSubmissions: true })], nextId: 7 };
});
afterEach(() => jest.restoreAllMocks());

describe('isPublicRead (method-aware, anchored)', () => {
  const r = (method, path) => isPublicRead({ method, path });
  it('opens GET/HEAD of exactly /api/jobs/<number> and /api/jobs/<number>/onchain-status', () => {
    expect(r('GET', '/api/jobs/5')).toBe(true);
    expect(r('HEAD', '/api/jobs/5')).toBe(true);
    expect(r('GET', '/api/jobs/5/')).toBe(true);
    expect(r('GET', '/api/jobs/123/onchain-status')).toBe(true);
    expect(r('HEAD', '/api/jobs/123/onchain-status')).toBe(true);
  });
  it('keeps every other method and /api/jobs path closed', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(r(method, '/api/jobs/5')).toBe(false);
      expect(r(method, '/api/jobs/5/onchain-status')).toBe(false);
    }
    for (const path of ['/api/jobs', '/api/jobs/', '/api/jobs/create', '/api/jobs/abc', '/api/jobs/5abc',
      '/api/jobs/5/submit', '/api/jobs/5/submissions', '/api/jobs/5/rubric', '/api/jobs/5/onchain-status/x',
      '/api/jobs/5/onchain-statusx', '/api/jobs/admin/5', '/api/jobs/admin/diagnostics', '/api/jobs/lookup',
      '//api/jobs/5', '/api/jobs/%35', '/x/api/jobs/5', '/api/jobs/5/submissions/0/content']) {
      expect(r('GET', path)).toBe(false);
    }
  });
});

describe('anonymous GET /api/jobs/:id', () => {
  it('serves the bounty with no key, including the description', async () => {
    const res = await request(app).get('/api/jobs/5');
    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ jobId: 5, creator: CREATOR, description: 'Wager terms: Jets beat the Patriots.' });
  });

  it('answers HEAD with no key', async () => {
    const res = await request(app).head('/api/jobs/5');
    expect(res.status).toBe(200);
  });

  it('strips client attribution, and the file list unless submissions are public', async () => {
    const priv = (await request(app).get('/api/jobs/5')).body.job.submissions[0];
    expect(priv).toMatchObject({ submissionId: 0, hunter: HUNTER, hunterCid: 'QmHunterWork', fileCount: 1 });
    expect(priv).not.toHaveProperty('clientId');
    expect(priv).not.toHaveProperty('clientType');
    expect(priv).not.toHaveProperty('files');

    const pub = (await request(app).get('/api/jobs/6')).body.job.submissions[0];
    expect(pub.files).toEqual([{ filename: 'answer.md', size: 120, description: 'the answer' }]);
    expect(pub).not.toHaveProperty('clientId');
  });

  it('gives a keyed caller the complete record', async () => {
    const sub = (await request(app).get('/api/jobs/5').set('X-Bot-API-Key', 'bot-valid-key')).body.job.submissions[0];
    expect(sub).toMatchObject({ clientId: 'bot-test', clientType: 'bot' });
    expect(sub.files).toHaveLength(1);
  });
});

describe('anonymous GET /api/jobs/:id/onchain-status', () => {
  it('serves the live read with createdAt (unix + ISO) and no key', async () => {
    const res = await request(app).get('/api/jobs/11/onchain-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, bountyId: 11, status: expect.any(String), creator: CREATOR,
      targetHunter: HUNTER, bountyAmountWei: '1000000000000000', createdAt: CREATED_AT,
      createdAtIso: new Date(CREATED_AT * 1000).toISOString(), submissionDeadline: CREATED_AT + 3600,
      submissionDeadlineIso: new Date((CREATED_AT + 3600) * 1000).toISOString(), cached: false });
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  it('reuses one snapshot per bounty for 30 s, then reads the chain again', async () => {
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const first = await request(app).get('/api/jobs/12/onchain-status');
    clock.mockReturnValue(t0 + 29000);
    const second = await request(app).get('/api/jobs/12/onchain-status');
    expect(first.body.cached).toBe(false);
    expect(second.body.cached).toBe(true);
    expect(second.body.fetchedAt).toBe(first.body.fetchedAt);
    expect(rpcReads).toBe(1);

    clock.mockReturnValue(t0 + 31000);
    const third = await request(app).get('/api/jobs/12/onchain-status');
    expect(third.body.cached).toBe(false);
    expect(rpcReads).toBe(2);
  });

  it('caches per bounty id', async () => {
    await request(app).get('/api/jobs/13/onchain-status');
    await request(app).get('/api/jobs/14/onchain-status');
    expect(rpcReads).toBe(2);
  });

  it('shares one chain read between concurrent anonymous callers', async () => {
    let release;
    mockGetBounty = () => { rpcReads += 1; return new Promise((resolve) => { release = () => resolve(chainStruct()); }); };
    const pending = [0, 1, 2].map(() => request(app).get('/api/jobs/15/onchain-status').then(r => r));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(pending);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(rpcReads).toBe(1);
  });

  it('caches a missing bounty (404) but not a failed read (500)', async () => {
    mockGetBounty = async () => { rpcReads += 1; throw new Error('execution reverted: "bad bountyId"'); };
    expect((await request(app).get('/api/jobs/900/onchain-status')).status).toBe(404);
    const again = await request(app).get('/api/jobs/900/onchain-status');
    expect(again.status).toBe(404);
    expect(again.body.cached).toBe(true);
    expect(rpcReads).toBe(1);

    mockGetBounty = async () => { rpcReads += 1; throw new Error('RPC unavailable'); };
    expect((await request(app).get('/api/jobs/901/onchain-status')).status).toBe(500);
    expect((await request(app).get('/api/jobs/901/onchain-status')).status).toBe(500);
    expect(rpcReads).toBe(3);
  });

  it('always gives a keyed caller a live read', async () => {
    await request(app).get('/api/jobs/16/onchain-status');
    const a = await request(app).get('/api/jobs/16/onchain-status').set('X-Client-Key', 'frontend-test-key');
    const b = await request(app).get('/api/jobs/16/onchain-status').set('X-Bot-API-Key', 'bot-valid-key');
    expect([a.body.cached, b.body.cached]).toEqual([false, false]);
    expect(b.body.createdAt).toBe(CREATED_AT);
    expect(rpcReads).toBe(3);
  });
});

describe('everything else still needs a key', () => {
  const cases = [
    ['post', '/api/jobs/5/submit'],
    ['post', '/api/jobs/create'],
    ['post', '/api/jobs/5/submit/prepare'],
    ['post', '/api/jobs/5/close'],
    ['post', '/api/jobs/5/onchain-status'],
    ['patch', '/api/jobs/5/bountyId'],
    ['patch', '/api/jobs/admin/5/status'],
    ['delete', '/api/jobs/admin/5'],
    ['get', '/api/jobs/admin/diagnostics'],
    ['post', '/api/jobs/sync/now'],
    ['get', '/api/jobs'],
    ['get', '/api/jobs/5/submissions'],
    ['get', '/api/jobs/5/submissions/0/content'],
    ['get', '/api/jobs/5/rubric'],
    ['get', '/api/jobs/abc'],
  ];
  it.each(cases)('anonymous %s %s answers 401', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MISSING');
  });

  it('does not run the handler of a rejected write', async () => {
    const before = JSON.stringify(mockStorageData);
    await request(app).delete('/api/jobs/admin/5');
    await request(app).patch('/api/jobs/admin/5/status').send({ status: 'CLOSED' });
    expect(JSON.stringify(mockStorageData)).toBe(before);
  });
});

describe('anonymous rate limit', () => {
  it('answers 429 with Retry-After once a client exceeds its budget', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/jobs/5').set('X-Real-IP', '203.0.113.7')).status).toBe(200);
    }
    const res = await request(app).get('/api/jobs/5/onchain-status').set('X-Real-IP', '203.0.113.7');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keys on the proxy-set address, not the client-written X-Forwarded-For', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get('/api/jobs/5').set('X-Real-IP', '203.0.113.8').set('X-Forwarded-For', `198.51.100.${i}`);
    }
    const spoofed = await request(app).get('/api/jobs/5').set('X-Real-IP', '203.0.113.8').set('X-Forwarded-For', '198.51.100.99');
    expect(spoofed.status).toBe(429);
    const other = await request(app).get('/api/jobs/5').set('X-Real-IP', '203.0.113.9');
    expect(other.status).toBe(200);
  });

  it('never limits a keyed caller', async () => {
    for (let i = 0; i < 7; i++) {
      const res = await request(app).get('/api/jobs/5').set('X-Real-IP', '203.0.113.10').set('X-Bot-API-Key', 'bot-valid-key');
      expect(res.status).toBe(200);
    }
  });
});
