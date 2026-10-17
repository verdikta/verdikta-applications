/**
 * POST /api/jobs/:jobId/create-attempt: the create page reports how a website
 * create got stuck (2026-10-16: jobs 287, 288, 298-303 never reached the chain
 * and nothing said why). Kept only for unlinked jobs of the same creator,
 * reduced to known short fields, newest 10, rate-limited, behind frontend auth.
 */
let mockStorageData = { jobs: [], nextId: 0 };
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual,
    promises: { ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined), access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_p, data) => { mockStorageData = JSON.parse(data); return Promise.resolve(); }),
      rename: jest.fn().mockResolvedValue(undefined) } };
});
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0xabc123', chainId: 84532,
  explorer: 'https://sepolia.basescan.org', publicReadRateLimitWindowMs: 60000, publicReadRateLimitMax: 5,
  publicOnchainStatusCacheMs: 30000 } }));

process.env.FRONTEND_CLIENT_KEY = 'frontend-test-key';
delete process.env.FRONTEND_ALLOWED_ORIGINS;

const express = require('express');
const request = require('supertest');
const clientIdentification = require('../middleware/clientIdentification');
const jobRoutes = require('../routes/jobRoutes');
const { MAX_ATTEMPTS, MAX_TEXT, sanitizeCreateAttempt } = require('../utils/createAttempts');

const app = express();
app.use(express.json());
app.use(clientIdentification);
app.use('/api/jobs', jobRoutes);

const CREATOR = '0x5addea6020bca2edd41ec47297bf95922ffddaf0';
const TX = '0x' + 'ab'.repeat(32);
const job = (jobId, over = {}) => ({ jobId, title: `Bounty ${jobId}`, creator: CREATOR, status: 'OPEN',
  createdAt: 1792000000 + jobId, contractAddress: '0xabc123', submissions: [], ...over });

const post = (jobId, body) => request(app).post(`/api/jobs/${jobId}/create-attempt`)
  .set('X-Client-Key', 'frontend-test-key').send(body);
const failed = (over = {}) => ({ creator: CREATOR.toUpperCase().replace('0X', '0x'), event: 'failed', at: '2026-10-16T20:15:40.000Z',
  step: 'send', category: 'rejected_in_wallet', code: 'ACTION_REJECTED', rpcCode: 4001,
  message: 'user rejected action', walletMessage: 'User denied transaction signature.',
  chainId: 8453, wallet: 'MetaMask', browser: 'chrome', mobile: false, accountType: 'eip7702',
  delegate: '0x' + '6'.repeat(40), ...over });
const stored = (jobId) => mockStorageData.jobs.find((j) => j.jobId === jobId).createAttempts;

beforeEach(() => {
  jobRoutes._createAttemptLimiters.forEach((l) => l.reset());
  mockStorageData = { jobs: [
    job(298),
    job(299, { status: 'ORPHANED', orphanReason: 'no BountyCreated' }),
    job(240, { onChain: true }),
    job(241, { syncedFromBlockchain: true }),
  ], nextId: 300 };
});

describe('accepted', () => {
  it('stores the event on an unlinked job of the same creator (address case ignored)', async () => {
    const res = await post(298, failed());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, jobId: 298, stored: 1 });
    const [e] = stored(298);
    expect(e).toMatchObject({ event: 'failed', step: 'send', category: 'rejected_in_wallet', code: 'ACTION_REJECTED',
      rpcCode: '4001', chainId: 8453, wallet: 'MetaMask', mobile: false, accountType: 'eip7702' });
    expect(typeof e.receivedAt).toBe('string');
  });

  it('also accepts a job the sync service already marked ORPHANED', async () => {
    expect((await post(299, { creator: CREATOR, event: 'sign_requested' })).status).toBe(200);
  });

  it('keeps a tx hash only when it is one', async () => {
    await post(298, { creator: CREATOR, event: 'tx_sent', txHash: TX });
    await post(298, { creator: CREATOR, event: 'tx_sent', txHash: 'not-a-hash' });
    expect(stored(298).map((e) => e.txHash)).toEqual([TX, undefined]);
  });
});

describe('refused', () => {
  it.each([
    ['a job that reached the chain (onChain)', 240, {}, 409],
    ['a job the sync service linked', 241, {}, 409],
    ['an unknown job', 999, {}, 404],
    ['another creator', 298, { creator: '0x' + '1'.repeat(40) }, 409],
    ['a malformed creator', 298, { creator: 'me' }, 400],
    ['an unknown event', 298, { event: 'hacked' }, 400],
  ])('%s', async (_name, jobId, over, status) => {
    const res = await post(jobId, failed(over));
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    const j = mockStorageData.jobs.find((x) => x.jobId === jobId);
    expect(j?.createAttempts).toBeUndefined();
  });

  it('without the frontend key (never a public path)', async () => {
    const res = await request(app).post('/api/jobs/298/create-attempt').send(failed());
    expect(res.status).toBe(401);
    expect(stored(298)).toBeUndefined();
  });
});

describe('size and shape', () => {
  it('truncates strings, drops unknown keys and bad types', () => {
    const { event } = sanitizeCreateAttempt({ event: 'failed', message: 'x'.repeat(5000), userAgent: 'Mozilla/5.0',
      form: { title: 'secret' }, chainId: '8453', mobile: 'yes', step: 'drop-tables', category: 'evil', delegate: '0x12' },
      { now: () => new Date('2026-10-17T00:00:00Z') });
    expect(event.message).toHaveLength(MAX_TEXT);
    expect(event).toEqual({ event: 'failed', receivedAt: '2026-10-17T00:00:00.000Z', message: 'x'.repeat(MAX_TEXT) });
  });

  it('keeps only the newest 10 events', async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      expect((await post(298, failed({ message: `attempt ${i}` }))).status).toBe(200);
    }
    const attempts = stored(298);
    expect(attempts).toHaveLength(MAX_ATTEMPTS);
    expect(attempts[0].message).toBe('attempt 3');
    expect(attempts[MAX_ATTEMPTS - 1].message).toBe(`attempt ${MAX_ATTEMPTS + 2}`);
  });
});

it('rate-limits 30 reports per client and job in 10 minutes', async () => {
  for (let i = 0; i < 30; i++) expect((await post(298, { creator: CREATOR, event: 'sign_requested' })).status).toBe(200);
  const res = await post(298, { creator: CREATOR, event: 'sign_requested' });
  expect(res.status).toBe(429);
  expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  // Another job from the same client still has its own budget.
  expect((await post(299, { creator: CREATOR, event: 'sign_requested' })).status).toBe(200);
});

describe('visibility', () => {
  const get = (path) => request(app).get(path).set('X-Client-Key', 'frontend-test-key');

  it('GET /admin/create-attempts lists unlinked jobs with reports, newest first', async () => {
    await post(298, failed());
    await post(299, { creator: CREATOR, event: 'sign_requested' });
    const res = await get('/api/jobs/admin/create-attempts');
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => j.jobId)).toEqual([299, 298]);
    expect(res.body.jobs[0]).toMatchObject({ status: 'ORPHANED', orphanReason: 'no BountyCreated',
      createAttempts: [expect.objectContaining({ event: 'sign_requested' })] });
  });

  it('GET /admin/orphans carries the last report', async () => {
    mockStorageData.jobs.push(job(150, { contractAddress: '0xoldcontract' }));
    await post(150, failed({ category: 'insufficient_funds' }));
    const res = await get('/api/jobs/admin/orphans');
    const orphan = res.body.orphans.find((o) => o.jobId === 150);
    expect(orphan).toMatchObject({ createAttemptCount: 1, lastCreateAttempt: expect.objectContaining({ category: 'insufficient_funds' }) });
  });
});
