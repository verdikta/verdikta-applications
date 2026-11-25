/**
 * PATCH /jobs/:jobId/bountyId must be safe when several bounties are created in parallel and
 * their on-chain ids land in a different order than the API job ids:
 *  - the receipt (BountyCreated) identifies the job, not the caller's naming;
 *  - an UNLINKED sibling occupying the target id is swapped to the vacated id, never deleted;
 *  - a receipt the RPC has not indexed yet is retried, then answered "retry", never acted on blind.
 * Plus: the sync's BountyCreated matcher prefers the evaluationCid over creator+deadline.
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
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'ab'.repeat(20), chainId: 84532, explorer: 'https://sepolia.basescan.org' } }));
let mockReceipts = {};          // txHash -> receipt | null
let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: { getTransactionReceipt: (h) => Promise.resolve(mockReceipts[h] === undefined ? null : mockReceipts[h]) },
    getBounty: (...a) => mockGetBounty(...a),
    contract: {},
  }),
}));
process.env.CHAIN_READ_RETRIES = '2';
process.env.CHAIN_READ_RETRY_MS = '1';

const { ethers } = require('ethers');
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');
const { findPendingJobForBountyCreated } = require('../utils/syncService');

const CREATOR = '0x' + 'c1'.repeat(20);
const iface = new ethers.Interface(['event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)']);
function receiptFor(bountyId, evaluationCid, address = ESCROW, creator = CREATOR) {
  const { topics, data } = iface.encodeEventLog('BountyCreated', [bountyId, creator, evaluationCid, 128, 60, 1000n, 1789400000]);
  return { blockNumber: 100, logs: [{ address, topics, data }] };
}
function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
function job(jobId, evaluationCid, title) { return { jobId, title, creator: CREATOR, bountyAmount: 0.001, threshold: 60, evaluationCid, status: 'OPEN', createdAt: 1789390000, submissionCloseTime: 1789400000, submissionCount: 0, submissions: [] }; }
const byId = (id) => mockStorageData.jobs.find((j) => j.jobId === id);

beforeEach(() => {
  mockGetBounty = jest.fn().mockRejectedValue(Object.assign(new Error('execution reverted: "bad bountyId"'), { reason: 'bad bountyId' }));
  mockReceipts = {};
  // API ids 36 (OSI) and 39 (supply&demand); on chain they landed swapped: OSI = bounty 39, supply = bounty 36
  mockStorageData = { jobs: [job(35, 'QmDoppler', 'Doppler'), job(36, 'QmOSI', 'OSI model'), job(39, 'QmSupply', 'Supply and demand')], nextId: 40 };
  mockReceipts['0xtxSupply'] = receiptFor(36, 'QmSupply');
  mockReceipts['0xtxOSI'] = receiptFor(39, 'QmOSI');
});

async function link(namedJobId, bountyId, txHash) {
  return request(app()).patch(`/jobs/${namedJobId}/bountyId`).send({ bountyId, txHash, blockNumber: 100 });
}
function expectFinalState() {
  expect(mockStorageData.jobs).toHaveLength(3);                       // nothing deleted
  expect(byId(36)).toMatchObject({ evaluationCid: 'QmSupply', onChain: true, txHash: '0xtxSupply' });
  expect(byId(39)).toMatchObject({ evaluationCid: 'QmOSI', onChain: true, txHash: '0xtxOSI' });
  expect(byId(35)).toMatchObject({ evaluationCid: 'QmDoppler' });
}

describe('PATCH /bountyId with swapped parallel creates', () => {
  it('order A: the job that must move onto an unlinked sibling id swaps the sibling instead of deleting it', async () => {
    const r1 = await link(39, 36, '0xtxSupply');          // supply: API 39 → bounty 36 (sibling 36 = OSI is unlinked)
    expect(r1.status).toBe(200);
    expect(mockStorageData.jobs).toHaveLength(3);
    expect(byId(36).evaluationCid).toBe('QmSupply');
    expect(byId(39).evaluationCid).toBe('QmOSI');           // sibling moved to the vacated id, still unlinked
    expect(byId(39).onChain).toBeFalsy();
    const r2 = await link(36, 39, '0xtxOSI');              // OSI: caller still names it 36; receipt CID locates it at 39
    expect(r2.status).toBe(200);
    expect(r2.body.job.jobId).toBe(39);
    expectFinalState();
  });
  it('order B: the same two links in the opposite order converge to the same state', async () => {
    const r1 = await link(36, 39, '0xtxOSI');
    expect(r1.status).toBe(200);
    expect(mockStorageData.jobs).toHaveLength(3);
    expect(byId(39).evaluationCid).toBe('QmOSI');
    expect(byId(36).evaluationCid).toBe('QmSupply');        // supply swapped down to 36, unlinked
    const r2 = await link(39, 36, '0xtxSupply');
    expect(r2.status).toBe(200);
    expect(r2.body.job.jobId).toBe(36);
    expectFinalState();
  });
  it('a receipt the node has not indexed yet is retried, then answered 409 retry with nothing changed', async () => {
    mockReceipts['0xtxSupply'] = null;
    const r = await link(39, 36, '0xtxSupply');
    expect(r.status).toBe(409);
    expect(r.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(byId(39)).toMatchObject({ evaluationCid: 'QmSupply' });
    expect(byId(39).onChain).toBeFalsy();
    expect(byId(36)).toMatchObject({ evaluationCid: 'QmOSI' });
  });
  it('a claimed bountyId that disagrees with the receipt is rejected', async () => {
    const r = await link(39, 37, '0xtxSupply');            // receipt says 36
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/mismatch/i);
    expect(mockStorageData.jobs).toHaveLength(3);
  });
  it('a linked job with a different CID on the target id is never displaced', async () => {
    mockStorageData.jobs.push({ ...job(36, 'QmOther', 'Other real bounty'), onChain: true, syncedFromBlockchain: true });
    mockStorageData.jobs = mockStorageData.jobs.filter((j) => !(j.jobId === 36 && j.evaluationCid === 'QmOSI'));
    const r = await link(39, 36, '0xtxSupply');
    expect(r.status).toBe(409);
    expect(byId(36).evaluationCid).toBe('QmOther');
  });
});

describe('sync BountyCreated matcher', () => {
  it('prefers the exact evaluationCid over an earlier creator+deadline match', () => {
    const jobs = [job(36, 'QmA', 'a'), job(37, 'QmB', 'b'), job(38, 'QmC', 'c')];
    const hit = findPendingJobForBountyCreated(jobs, { evaluationCid: 'QmC', creator: CREATOR, deadline: 1789400000 });
    expect(hit.jobId).toBe(38);
  });
  it('falls back to creator+deadline only when no CID matches, and skips synced or orphaned records', () => {
    const jobs = [{ ...job(36, 'QmA', 'a'), syncedFromBlockchain: true }, { ...job(37, 'QmB', 'b'), status: 'ORPHANED' }, job(38, 'QmC', 'c')];
    const hit = findPendingJobForBountyCreated(jobs, { evaluationCid: 'QmZ', creator: CREATOR, deadline: 1789400010 });
    expect(hit.jobId).toBe(38);
    expect(findPendingJobForBountyCreated(jobs, { evaluationCid: 'QmZ', creator: '0x' + 'd'.repeat(40), deadline: 1789400010 })).toBeNull();
  });
});

// sec4-outside: a pending job's evaluationCid is public; another wallet's createBounty carrying it
// (a dust bounty sent first) must not take the job, through the PATCH or through the sync.
describe('evaluationCid squatting', () => {
  const SQUATTER = '0x' + '5'.repeat(40);
  it('PATCH with a receipt whose creator is not the job\'s answers 409 and changes nothing', async () => {
    mockReceipts['0xtxSquat'] = receiptFor(36, 'QmSupply', ESCROW, SQUATTER);
    const before = JSON.stringify(mockStorageData);
    const r = await link(39, 36, '0xtxSquat');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/different creator/);
    expect(JSON.stringify(mockStorageData)).toBe(before);
  });
  it('the sync matcher does not link a job to a bounty by another creator, even on its CID', () => {
    const jobs = [job(38, 'QmC', 'c')];
    expect(findPendingJobForBountyCreated(jobs, { evaluationCid: 'QmC', creator: SQUATTER, deadline: 1 })).toBeNull();
    expect(findPendingJobForBountyCreated(jobs, { evaluationCid: 'QmC', creator: CREATOR.toUpperCase().replace('0X', '0x'), deadline: 1 }).jobId).toBe(38);
    expect(findPendingJobForBountyCreated([{ ...job(38, 'QmC', 'c'), creator: undefined }], { evaluationCid: 'QmC', creator: SQUATTER, deadline: 1 }).jobId).toBe(38);
  });
});
