/**
 * Security: an API client must not be able to link a job record it controls to an
 * on-chain bounty it did not create. Before this guard:
 *   - PATCH /:jobId/bountyId without txHash renumbered ANY job to ANY bountyId and marked
 *     it onChain (the chain fields were backfilled, but the attacker's title, description,
 *     rubricCid and juryNodes stayed), so the site showed the attacker's task text for
 *     someone else's escrow, or a fake "on-chain" bounty that does not exist;
 *   - PATCH /:id/bountyId/resolve did the same with no collision check at all, from a
 *     txHash or a creator address the caller names.
 * A link now needs proof that the chain bounty is THIS job: the receipt's BountyCreated
 * (txHash, required) or the chain bounty's evaluationCid equal to the job's own.
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
let mockReceipts = {};
let mockLogs = [];
const VICTIM = '0x' + 'c1'.repeat(20);
const ATTACKER = '0x' + 'a7'.repeat(20);
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: {
      getTransactionReceipt: (h) => Promise.resolve(mockReceipts[h] ?? null),
      getLogs: async () => mockLogs,
    },
    getBlockNumber: async () => 1000,
    getBounty: async (id) => {
      if (id !== 50) throw new Error('bad bountyId');
      return { creator: '0x' + 'c1'.repeat(20), evaluationCid: 'QmVictimEval', submissionCloseTime: 1900000000, bountyAmount: '1.0', bountyAmountWei: '1000000000000000000' };
    },
    contract: {},
  }),
}));
process.env.CHAIN_READ_RETRIES = '1';
process.env.CHAIN_READ_RETRY_MS = '1';

const { ethers } = require('ethers');
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

const iface = new ethers.Interface(['event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)']);
const victimLog = () => {
  const { topics, data } = iface.encodeEventLog('BountyCreated', [50, VICTIM, 'QmVictimEval', 128, 80, 10n ** 18n, 1900000000]);
  return { address: ESCROW, topics, data };
};
function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
function seed() {
  const old = Math.floor(Date.now() / 1000) - 3600;
  mockStorageData = { nextId: 61, jobs: [
    // The attacker's unlinked API job: its own task text, its own evaluation package.
    { jobId: 60, title: 'Send 1 ETH to claim', description: 'attacker text', creator: ATTACKER, evaluationCid: 'QmAttackerEval',
      rubricCid: 'QmAttackerRubric', status: 'OPEN', createdAt: old, submissions: [], contractAddress: ESCROW },
    // The victim's own pending job for bounty 50 (created through the API, not yet linked).
    { jobId: 47, title: 'Real task', description: 'victim text', creator: VICTIM, evaluationCid: 'QmVictimEval',
      status: 'OPEN', createdAt: old, submissions: [], contractAddress: ESCROW },
  ] };
  mockReceipts = { ['0x' + '11'.repeat(32)]: { blockNumber: 100, logs: [victimLog()] } };
  mockLogs = [victimLog()];
}
const job = (id) => mockStorageData.jobs.filter((j) => j.jobId === id);

describe('linking a job to an on-chain bounty needs proof it is that bounty', () => {
  beforeEach(seed);

  it('PATCH /bountyId without txHash cannot claim bounty 50 for the attacker job', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId').send({ bountyId: 50 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(job(50)).toHaveLength(0);
    expect(job(60)[0].onChain).toBeFalsy();
  });

  it('PATCH /bountyId without txHash cannot mark a job on-chain for a bounty that does not exist', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId').send({ bountyId: 999999 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(job(999999)).toHaveLength(0);
    expect(job(60)[0].onChain).toBeFalsy();
  });

  it('PATCH /bountyId with a malformed txHash is a 400, not a 500', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId').send({ bountyId: 50, txHash: { x: 1 } });
    expect(res.status).toBe(400);
  });

  it('PATCH /bountyId with the victim receipt on the attacker job links the victim job instead', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId').send({ bountyId: 50, txHash: '0x' + '11'.repeat(32) });
    expect(res.status).toBe(200);
    expect(job(50)).toHaveLength(1);
    expect(job(50)[0].title).toBe('Real task');
    expect(job(60)[0].onChain).toBeFalsy();
  });

  it('PATCH /bountyId/resolve with the victim txHash cannot link the attacker job', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId/resolve')
      .send({ creator: VICTIM, submissionCloseTime: 1900000000, txHash: '0x' + '11'.repeat(32) });
    expect(res.body.success).not.toBe(true);
    expect(job(50).filter((j) => j.title === 'Send 1 ETH to claim')).toHaveLength(0);
    expect(job(60)[0].onChain).toBeFalsy();
  });

  it('PATCH /bountyId/resolve by creator scan cannot link the attacker job', async () => {
    const res = await request(app()).patch('/jobs/60/bountyId/resolve')
      .send({ creator: VICTIM, submissionCloseTime: 1900000000 });
    expect(res.body.success).not.toBe(true);
    expect(job(50).filter((j) => j.title === 'Send 1 ETH to claim')).toHaveLength(0);
  });

  it('PATCH /bountyId/resolve still links the job that really is bounty 50', async () => {
    const res = await request(app()).patch('/jobs/47/bountyId/resolve')
      .send({ creator: VICTIM, submissionCloseTime: 1900000000, txHash: '0x' + '11'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.bountyId).toBe(50);
    expect(job(50)).toHaveLength(1);
    expect(job(50)[0].title).toBe('Real task');
  });
});

describe('a failed resolve never unlinks a linked job', () => {
  it('leaves onChain alone', async () => {
    seed();
    mockStorageData.jobs[1].onChain = true;
    mockLogs = [];
    await request(app()).patch('/jobs/47/bountyId/resolve').send({ creator: ATTACKER, submissionCloseTime: 1 });
    expect(job(47)[0].onChain).toBe(true);
  });
});
