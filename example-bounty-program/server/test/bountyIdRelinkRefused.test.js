/**
 * Review 2026-11-27, item 4: PATCH /jobs/:id/bountyId on a job that is ALREADY linked.
 *   - The creator check only ran for unlinked jobs, and an evaluationCid is public: a receipt of the
 *     attacker's own dust bounty carrying the victim's CID renumbered the victim's linked record.
 *   - blockNumber was stored as sent (any JSON value up to the body limit, and the sync kept it).
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
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'ab'.repeat(20), chainId: 84532, explorer: 'https://sepolia.basescan.org' } }));
let mockReceipt = null;
let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: { getTransactionReceipt: () => Promise.resolve(mockReceipt) },
    getBounty: (...a) => mockGetBounty(...a),
    contract: {},
  }),
}));
process.env.CHAIN_READ_RETRIES = '1';
process.env.CHAIN_READ_RETRY_MS = '1';

const express = require('express');
const request = require('supertest');
const { ethers } = require('ethers');
const jobRoutes = require('../routes/jobRoutes');

const ESCROW = '0x' + 'ab'.repeat(20);
const VICTIM = '0x' + 'c1'.repeat(20);
const ATTACKER = '0x' + 'ee'.repeat(20);
const TX = '0x' + '11'.repeat(32);
const iface = new ethers.Interface([
  'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)',
]);
function receiptFor(bountyId, creator, cid, blockNumber = 777) {
  const { topics, data } = iface.encodeEventLog(iface.getEvent('BountyCreated'), [bountyId, creator, cid, 1, 60, 1000n, 1789400000n]);
  return { blockNumber, logs: [{ address: ESCROW, topics, data }] };
}
function app() { const a = express(); a.use(express.json({ limit: '2mb' })); a.use('/jobs', jobRoutes); return a; }
function job(jobId, evaluationCid, title, creator, extra = {}) {
  return { jobId, title, creator, bountyAmount: 0.001, threshold: 60, evaluationCid, status: 'OPEN', createdAt: 1789390000,
    submissionCloseTime: 1789400000, submissionCount: 0, submissions: [], ...extra };
}

beforeEach(() => {
  mockGetBounty = jest.fn().mockRejectedValue(new Error('rpc down'));
  mockStorageData = { jobs: [
    job(5, 'QmVictim', 'Real bounty', VICTIM, { onChain: true, syncedFromBlockchain: true, contractAddress: ESCROW, txHash: '0xreal', blockNumber: 100 }),
  ], nextId: 6 };
});

it("a receipt of the attacker's bounty with the victim's CID cannot renumber the victim's linked job", async () => {
  mockReceipt = receiptFor(9, ATTACKER, 'QmVictim');
  const r = await request(app()).patch('/jobs/5/bountyId').send({ bountyId: 9, txHash: TX });
  expect(r.status).toBe(409);
  expect(mockStorageData.jobs).toHaveLength(1);
  expect(mockStorageData.jobs[0]).toMatchObject({ jobId: 5, txHash: '0xreal', blockNumber: 100, creator: VICTIM });
});

it('the body blockNumber is never stored: the receipt block is', async () => {
  mockStorageData = { jobs: [job(5, 'QmMine', 'Pending', VICTIM)], nextId: 6 };
  mockReceipt = receiptFor(5, VICTIM, 'QmMine', 4242);
  const r = await request(app()).patch('/jobs/5/bountyId').send({ bountyId: 5, txHash: TX, blockNumber: { junk: 'x'.repeat(100000) } });
  expect(r.status).toBe(200);
  expect(mockStorageData.jobs[0]).toMatchObject({ jobId: 5, onChain: true, txHash: TX, blockNumber: 4242 });
});

it('re-sending the real receipt for a linked job is accepted and changes nothing else', async () => {
  mockReceipt = receiptFor(5, VICTIM, 'QmVictim', 100);
  const r = await request(app()).patch('/jobs/5/bountyId').send({ bountyId: 5, txHash: TX, blockNumber: 'ignored' });
  expect(r.status).toBe(200);
  expect(mockStorageData.jobs[0]).toMatchObject({ jobId: 5, creator: VICTIM, blockNumber: 100 });
});
