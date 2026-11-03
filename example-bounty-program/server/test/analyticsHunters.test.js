/**
 * GET /api/analytics/hunters: distinct hunter addresses (submitters) and the subset that
 * won, for the /analytics Bounty Hunters block and its /analytics/hunters list page.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'AB'.repeat(20) } }));
jest.mock('../utils/verdiktaService', () => ({ getVerdiktaService: () => null, isVerdiktaServiceAvailable: () => false }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({}) }));
let mockJobs = [];
jest.mock('../utils/jobStorage', () => ({ listJobs: jest.fn(async () => ({ jobs: mockJobs })) }));

const express = require('express');
const request = require('supertest');
const { analyticsCache } = require('../utils/analyticsCacheService');

const app = express();
app.use('/api/analytics', require('../routes/analyticsRoutes'));

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const C = '0x' + 'cc'.repeat(20);

beforeEach(() => {
  analyticsCache.clear();
  mockJobs = [
    {
      jobId: 1, status: 'AWARDED', winner: A, bountyAmount: '0', arbiterDeterminationPayment: '0.01',
      submissions: [
        { hunter: B, onChainStatus: 'Failed', submittedAt: 100 },
        // Mixed-case copy of A: one address, not two
        { hunter: A.toUpperCase().replace('0X', '0x'), onChainStatus: 'PassedPaid', submittedAt: 200 },
      ],
    },
    {
      jobId: 2, status: 'OPEN', bountyAmount: '0.02',
      submissions: [
        { hunter: A, onChainStatus: 'Failed', submittedAt: 300 },
        { hunter: C, status: 'Prepared', onChainStatus: 'Prepared', submittedAt: 50 },
        { hunter: B, onChainStatus: 'PassedUnpaid', submittedAt: 400 },
      ],
    },
    { jobId: 3, status: 'EXPIRED', submissions: [] },
  ];
});

test('counts distinct submitters and paid winners, one win per bounty', async () => {
  const res = await request(app).get('/api/analytics/hunters');
  expect(res.status).toBe(200);
  const { data } = res.body;
  expect(data.view).toBe('submitters');
  expect(data.totalSubmitters).toBe(3);
  expect(data.totalWinners).toBe(1);
  expect(data.hunters.map(h => h.address.toLowerCase())).toEqual([A, B, C]);

  const a = data.hunters[0];
  expect(a).toMatchObject({ submissions: 2, bounties: 2, wins: 1, ethWon: 0.01, wonBountyIds: [1],
    firstSubmittedAt: 200, lastSubmittedAt: 300 });
  // PassedUnpaid is a pass, not a win
  expect(data.hunters[1]).toMatchObject({ submissions: 2, wins: 0, ethWon: 0 });
});

test('view=winners keeps only addresses that won', async () => {
  const res = await request(app).get('/api/analytics/hunters?view=winners');
  expect(res.status).toBe(200);
  expect(res.body.data.view).toBe('winners');
  expect(res.body.data.hunters).toHaveLength(1);
  expect(res.body.data.hunters[0].address.toLowerCase()).toBe(A);
  expect(res.body.data.totalSubmitters).toBe(3);
});
