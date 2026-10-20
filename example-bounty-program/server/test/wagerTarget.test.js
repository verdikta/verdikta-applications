/**
 * A mutual-wager bounty (its description carries a MUTUAL WAGER TERMS block) pays only its
 * Claimant, so POST /jobs/create refuses one that is not targeted at the Claimant's wallet:
 * an open bounty would let a stranger citing the Claimant's real counter bounty collect.
 * Security review of verdikta-applications#106.
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
const storage = require('../utils/jobStorage');
const { validateWagerTarget } = require('../utils/validation');
const { proposeMutualWager } = require('../../shared/mutualWager');
const { wagerContext } = require('../utils/wagerGuard');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/jobs', require('../routes/jobRoutes'));
const cid = 'Qm' + 'a'.repeat(44);
app.locals.ipfsClient = { uploadToIPFS: jest.fn(async () => cid), fetchFromIPFS: async () => Buffer.from('{}') };

const POSTER = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D';
const CLAIMANT = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9';
const terms = (poster = POSTER, claimant = CLAIMANT) => [
  'Settles one side of a two-bounty wager.',
  '',
  '=== MUTUAL WAGER TERMS (mutual-wager-v3) ===',
  'Wager ID: VW-TEST3-BOS-DET-20261020',
  `Poster (creator): ${poster}; side: the Boston Celtics win.`,
  `Claimant (target, the only wallet that can claim): ${claimant}; side: the Detroit Pistons win.`,
  '=== END WAGER TERMS ===',
].join('\n');
const body = {
  title: 'Wager VW-TEST3-BOS-DET-20261020: Celtics @ Pistons, pays if the Pistons win',
  description: terms(),
  workProductType: 'Wager settlement claim',
  creator: POSTER,
  bountyAmount: 0.0001,
  threshold: 80,
  juryNodes: [{ provider: 'openai', model: 'test-model', weight: 1, runs: 1 }],
  rubricJson: { title: 'Rubric', criteria: [{ id: 'terms_match', label: 'Terms', must: true, weight: 0, description: 'Matches the terms.' }], forbiddenContent: [] },
};
const pinFetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ IpfsHash: cid }) }));
const realFetch = global.fetch;
const realPinningKey = process.env.IPFS_PINNING_KEY;
beforeEach(() => { jest.clearAllMocks(); global.fetch = pinFetch; process.env.IPFS_PINNING_KEY = 'test-key'; });
afterAll(() => {
  global.fetch = realFetch;
  if (realPinningKey === undefined) delete process.env.IPFS_PINNING_KEY; else process.env.IPFS_PINNING_KEY = realPinningKey;
});

describe('validateWagerTarget', () => {
  it('ignores descriptions without a terms block', () => {
    expect(validateWagerTarget('Write a blog post', POSTER, '')).toBeNull();
  });
  it('accepts a wager targeted at its Claimant, in any letter case', () => {
    expect(validateWagerTarget(terms(), POSTER, CLAIMANT.toLowerCase())).toBeNull();
  });
  it('refuses an untargeted wager, or one targeted at someone else', () => {
    expect(validateWagerTarget(terms(), POSTER, '')).toMatch(/must be targeted/);
    expect(validateWagerTarget(terms(), POSTER, '0x0000000000000000000000000000000000000000')).toMatch(/must be targeted/);
    expect(validateWagerTarget(terms(), POSTER, '0x' + '22'.repeat(20))).toMatch(/is not the Claimant/);
  });
  it('refuses a creator who is not the Poster, a Claimant who is the Poster, and a block without wallets', () => {
    expect(validateWagerTarget(terms(), '0x' + '33'.repeat(20), CLAIMANT)).toMatch(/is not the Poster/);
    expect(validateWagerTarget(terms(POSTER, POSTER), POSTER, POSTER)).toMatch(/different wallets/);
    expect(validateWagerTarget('=== MUTUAL WAGER TERMS (mutual-wager-v3) ===\nPoster (creator): <yours>', POSTER, CLAIMANT)).toMatch(/must name the Poster and Claimant/);
  });
});

describe('POST /jobs/create with a mutual-wager description', () => {
  it('refuses an untargeted wager with 400 WAGER_TARGET before creating anything', async () => {
    const res = await request(app).post('/jobs/create').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WAGER_TARGET' });
    expect(res.body.details).toMatch(new RegExp(CLAIMANT));
    expect(storage.createJob).not.toHaveBeenCalled();
    expect(pinFetch).not.toHaveBeenCalled();
  });

  it('refuses a wager targeted at a wallet other than the Claimant', async () => {
    const res = await request(app).post('/jobs/create').send({ ...body, targetHunter: '0x' + '22'.repeat(20), procurementMode: 'TARGETED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WAGER_TARGET');
  });

  it('creates a complete wager targeted at its Claimant', async () => {
    // A bare terms block now fails the full check (test/wagerApi.test.js); build a complete one.
    const at = (h) => new Date((Math.floor(Date.now() / 60000) * 60 + h * 3600) * 1000).toISOString().replace('.000Z', 'Z');
    const { createBody } = proposeMutualWager({
      creator: POSTER, opponent: CLAIMANT, wagerId: 'VW-TEST3-BOS-DET-20261020', stake: '0.0001', start: at(2), settle: at(26),
      event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena, Detroit, Michigan.',
      sides: { creator: 'the Boston Celtics win', opponent: 'the Detroit Pistons win' },
      jury: [{ provider: 'openai', model: 'test-model', weight: 1, runs: 1 }],
    }, wagerContext());
    const res = await request(app).post('/jobs/create').send(createBody);
    expect(res.status).toBe(200);
    expect(storage.createJob).toHaveBeenCalledTimes(1);
    expect(storage.createJob.mock.calls[0][0].targetHunter).toBe(CLAIMANT);
  });

  it('refuses a bare terms block that names the right target but nothing else', async () => {
    const res = await request(app).post('/jobs/create').send({ ...body, targetHunter: CLAIMANT, procurementMode: 'TARGETED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WAGER_TERMS');
    expect(storage.createJob).not.toHaveBeenCalled();
  });
});
