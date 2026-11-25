/**
 * GET /jobs/admin/expired (agents.txt: "For a system-wide view (all creators)") must report
 * canClose exactly when closeExpiredBounty can succeed: the escrow's pending list must be empty,
 * and that list holds AwaitingRerun submissions (status 6) as well as PendingVerdikta (1). It used to
 * count status 1 only, so a bounty with a submission awaiting a re-run read "canClose: true" while
 * the close reverted "active evaluation - finalize first", and the submission to expire was not listed.
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
// on-chain submission statuses per bounty: 1 PendingVerdikta, 2 Failed, 6 AwaitingRerun
const mockSubs = { 20: [2, 6], 21: [2, 1], 22: [2, 3] };
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: {},
    contract: {
      getBounty: async () => ({ status: 0n, payoutWei: 10n ** 16n }),
      submissionCount: async (b) => BigInt(mockSubs[Number(b)].length),
      getSubmission: async (b, i) => ({ status: BigInt(mockSubs[Number(b)][Number(i)]), hunter: '0x' + '11'.repeat(20), submittedAt: 1n }),
    },
  }),
}));
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }

describe('GET /jobs/admin/expired: canClose follows the escrow\'s pending list', () => {
  beforeEach(() => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    mockStorageData = { nextId: 23, jobs: [20, 21, 22].map((jobId) => ({
      jobId, title: `B${jobId}`, status: 'EXPIRED', onChain: true, syncedFromBlockchain: true,
      submissionCloseTime: past, createdAt: past - 86400, submissions: [], contractAddress: ESCROW,
    })) };
  });

  it('a submission awaiting a re-run blocks the close and is listed with expire_rerun', async () => {
    const res = await request(app()).get('/jobs/admin/expired');
    expect(res.status).toBe(200);
    const list = res.body.expiredBounties || res.body.bounties || [];
    const b = (id) => list.find((x) => x.jobId === id);
    expect(b(20)).toMatchObject({ canClose: false });
    expect(b(20).pendingSubmissions).toEqual([expect.objectContaining({ submissionId: 1, onChainStatus: 'AwaitingRerun', action: 'expire_rerun' })]);
    expect(b(21)).toMatchObject({ canClose: false });
    expect(b(21).pendingSubmissions).toEqual([expect.objectContaining({ submissionId: 1, onChainStatus: 'PendingVerdikta' })]);
    expect(b(22)).toMatchObject({ canClose: true, pendingSubmissions: [] });
  });
});
