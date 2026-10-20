/**
 * GET /api/analytics/templates: rubric template usage for the /analytics page, over the
 * current contract's bounties (unfunded creates included, admin-cancelled ones not).
 */
const ESCROW = '0x' + 'ab'.repeat(20);
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'AB'.repeat(20) } }));
jest.mock('../utils/verdiktaService', () => ({ getVerdiktaService: () => null, isVerdiktaServiceAvailable: () => false }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({}) }));
let mockJobs = [];
jest.mock('../utils/jobStorage', () => ({ readStorage: jest.fn(async () => ({ jobs: mockJobs })) }));

const express = require('express');
const request = require('supertest');
const { analyticsCache } = require('../utils/analyticsCacheService');

const app = express();
app.use('/api/analytics', require('../routes/analyticsRoutes'));

const wager = { key: 'mutualWager', version: 'mutual-wager-v3', match: 'exact', source: 'template', inferred: false };

beforeEach(() => analyticsCache.clear());

test('counts the current contract only, keeping unfunded creates and dropping cancelled ones', async () => {
  mockJobs = [
    { jobId: 1, contractAddress: ESCROW, status: 'AWARDED', onChain: true, rubricTemplate: wager, createdByClientType: 'frontend' },
    { jobId: 2, contractAddress: ESCROW, status: 'ORPHANED', rubricTemplate: wager },
    { jobId: 3, contractAddress: ESCROW, status: 'CANCELLED', rubricTemplate: wager },
    { jobId: 1, contractAddress: '0x' + 'cd'.repeat(20), status: 'AWARDED', onChain: true, rubricTemplate: wager },
    { jobId: 4, contractAddress: ESCROW, status: 'OPEN', syncedFromBlockchain: true, rubricTemplate: { key: null, match: null, source: 'api' } },
  ];
  const res = await request(app).get('/api/analytics/templates');
  expect(res.status).toBe(200);
  expect(res.body.data.totals).toMatchObject({ created: 3, onChain: 2, awarded: 1,
    via: { site: { created: 1, onChain: 1 }, agent: { created: 0, onChain: 0 }, unknown: { created: 2, onChain: 1 } } });
  expect(res.body.data.templates.find((t) => t.key === 'mutualWager'))
    .toMatchObject({ created: 2, onChain: 1, awarded: 1, exact: 2, sources: { template: 2 } });
  expect(res.body.data.none).toMatchObject({ created: 1, onChain: 1 });
  expect(res.body.data.stages.onChain).toMatch(/Funded on chain/);
});
