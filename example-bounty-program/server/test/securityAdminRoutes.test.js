/**
 * Security: the website key is in the browser bundle and bot keys are free, so the
 * "admin" routes are reachable by anyone. They must not let a caller change what the
 * chain decides (a funded bounty's status), delete a bounty the sync found on chain, or
 * run operator-only cleanups.
 */
let mockStorageData = { jobs: [], nextId: 0 };
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, promises: { ...actual.promises,
    mkdir: jest.fn().mockResolvedValue(undefined), access: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
    writeFile: jest.fn().mockImplementation((_p, data) => { mockStorageData = JSON.parse(data); return Promise.resolve(); }),
    rename: jest.fn().mockResolvedValue(undefined) } };
});
const ESCROW = '0x' + 'ab'.repeat(20);
jest.mock('../config', () => ({ config: { network: 'base', bountyEscrowAddress: '0x' + 'ab'.repeat(20), chainId: 8453, explorer: 'https://basescan.org' } }));
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({ getBounty: async () => ({ status: 'OPEN' }), provider: {}, contract: {} }),
}));
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
const old = () => Math.floor(Date.now() / 1000) - 3600;
function seed() {
  mockStorageData = { nextId: 12, jobs: [
    { jobId: 10, title: 'Funded', status: 'OPEN', onChain: true, syncedFromBlockchain: true, createdAt: old(), submissions: [], contractAddress: ESCROW },
    { jobId: 11, title: 'Found by sync', status: 'OPEN', syncedFromBlockchain: true, createdAt: old(), submissions: [], contractAddress: ESCROW },
    { jobId: 5, title: 'Never linked', status: 'OPEN', createdAt: old(), submissions: [], contractAddress: ESCROW },
    { jobId: 3, title: 'Old contract', status: 'OPEN', createdAt: old(), submissions: [], contractAddress: '0x' + '01'.repeat(20) },
  ] };
}
const job = (id) => mockStorageData.jobs.find((j) => j.jobId === id);

describe('admin routes reachable by any client', () => {
  beforeEach(() => { seed(); delete process.env.ADMIN_API_KEY; });

  it('cannot mark a funded on-chain bounty CANCELLED or AWARDED', async () => {
    for (const status of ['CANCELLED', 'AWARDED', 'CLOSED']) {
      const res = await request(app()).patch('/jobs/admin/10/status').send({ status });
      expect(res.status).toBe(409);
      expect(job(10).status).toBe('OPEN');
    }
  });

  it('a linked bounty follows the chain when the request matches it', async () => {
    job(10).status = 'EXPIRED';
    const res = await request(app()).patch('/jobs/admin/10/status').send({ status: 'OPEN' });
    expect(res.status).toBe(200);
    expect(job(10).status).toBe('OPEN');
  });

  it('an unlinked job may be closed or cancelled, not set to AWARDED', async () => {
    expect((await request(app()).patch('/jobs/admin/5/status').send({ status: 'AWARDED' })).status).toBe(400);
    expect((await request(app()).patch('/jobs/admin/5/status').send({ status: 'CANCELLED' })).status).toBe(200);
    expect(job(5).status).toBe('CANCELLED');
  });

  it('cannot delete a bounty the sync found on chain', async () => {
    const res = await request(app()).delete('/jobs/admin/11');
    expect(res.status).toBe(400);
    expect(job(11)).toBeDefined();
  });

  it('orphan cleanup needs the operator key', async () => {
    expect((await request(app()).delete('/jobs/admin/orphans?confirm=yes')).status).toBe(403);
    expect((await request(app()).post('/jobs/admin/orphans/mark')).status).toBe(403);
    expect(job(3)).toBeDefined();
    process.env.ADMIN_API_KEY = 'k'.repeat(32);
    expect((await request(app()).delete('/jobs/admin/orphans?confirm=yes').set('X-Admin-Key', 'wrong')).status).toBe(403);
    expect((await request(app()).delete('/jobs/admin/orphans?confirm=yes').set('X-Admin-Key', 'k'.repeat(32))).status).toBe(200);
    expect(job(3)).toBeUndefined();
  });
});

describe('pinning routes are limited per client address', () => {
  it('answers 429 past the budget', async () => {
    jest.resetModules();
    process.env.PIN_RATE_LIMIT_MAX = '2';
    let a;
    jest.isolateModules(() => {
      const { limitPins } = require('../utils/pinLimit');
      a = express(); a.post('/pin', limitPins, (req, res) => res.json({ ok: true }));
    });
    expect((await request(a).post('/pin')).status).toBe(200);
    expect((await request(a).post('/pin')).status).toBe(200);
    expect((await request(a).post('/pin')).status).toBe(429);
    delete process.env.PIN_RATE_LIMIT_MAX;
  });
});

describe('bot registration', () => {
  it('is limited per client address and refuses non-string fields', async () => {
    const botRoutes = require('../routes/botRoutes');
    const a = express(); a.use(express.json()); a.use('/bots', botRoutes);
    const bad = await request(a).post('/bots/register').send({ name: ['x', 'y', 'z'], ownerAddress: '0x' + '1'.repeat(40) });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 9; i++) botRoutes.registerLimiter.hit('::ffff:127.0.0.1');
    const limited = await request(a).post('/bots/register').send({ name: 'Bot', ownerAddress: '0x' + '1'.repeat(40) });
    expect(limited.status).toBe(429);
  });
});

describe('frontend origin check', () => {
  const clientIdentification = require('../middleware/clientIdentification');
  function run(origin) {
    const req = { headers: { 'x-client-key': 'fk', ...(origin ? { origin } : {}) }, method: 'POST', path: '/api/jobs/create', originalUrl: '/api/jobs/create', ip: '127.0.0.1' };
    let type = null;
    const res = { status() { return this; }, json() { return this; }, set() { return this; }, setHeader() {} };
    clientIdentification(req, res, () => { type = req.clientType; });
    return type;
  }
  beforeAll(() => { process.env.FRONTEND_CLIENT_KEY = 'fk'; process.env.FRONTEND_ALLOWED_ORIGINS = 'https://bounties.verdikta.org,http://localhost:5173'; });
  it('accepts the exact origin and refuses a look-alike prefix', () => {
    expect(run('https://bounties.verdikta.org')).toBe('frontend');
    expect(run('http://localhost:5173')).toBe('frontend');
    expect(run('https://bounties.verdikta.org.evil.com')).not.toBe('frontend');
    expect(run('https://bounties.verdikta.orgx')).not.toBe('frontend');
  });
});
