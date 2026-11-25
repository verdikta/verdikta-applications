/**
 * Security: a client-written job record must not take over an on-chain bounty id.
 * PATCH /jobs/:id/bountyId without txHash is unverified. An attacker moves their own
 * job onto a FUTURE bountyId (onChain:true, contractAddress set); when the victim's real bounty with
 * that id is created, the sync links the victim's record to the same id and the attacker's record
 * shadows it (getJob / _findJob return the first match).
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
let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: { getTransactionReceipt: () => Promise.resolve(null) },
    getBounty: (...a) => mockGetBounty(...a),
    contract: {},
  }),
}));
process.env.CHAIN_READ_RETRIES = '1';
process.env.CHAIN_READ_RETRY_MS = '1';

const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');
const { SyncService } = require('../utils/syncService');
const jobStorage = require('../utils/jobStorage');

const VICTIM = '0x' + 'c1'.repeat(20);
const ATTACKER = '0x' + 'ee'.repeat(20);
function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
function job(jobId, evaluationCid, title, creator) { return { jobId, title, creator, bountyAmount: 0.001, threshold: 60, evaluationCid, status: 'OPEN', createdAt: 1789390000, submissionCloseTime: 1789400000, submissionCount: 0, submissions: [] }; }

beforeEach(() => {
  mockGetBounty = jest.fn().mockRejectedValue(Object.assign(new Error('execution reverted: "bad bountyId"'), { reason: 'bad bountyId' }));
  mockStorageData = { jobs: [job(10, 'QmAttacker', 'Fake: pays 100 ETH', ATTACKER), job(11, 'QmVictim', 'Real bounty', VICTIM)], nextId: 12 };
});

it('PATCH without txHash must not link a job to a bountyId it did not create', async () => {
  const r = await request(app()).patch('/jobs/10/bountyId').send({ bountyId: 11 });
  // Expected (secure): refused. Vulnerable: 200, attacker now owns id 11 and the victim was moved.
  expect(r.status).toBeGreaterThanOrEqual(400);
});

it('a job cannot be PATCHed onto a future bountyId without a receipt (it would shadow the real bounty)', async () => {
  const r = await request(app()).patch('/jobs/10/bountyId').send({ bountyId: 12 });
  expect(r.status).toBe(400);
  expect(mockStorageData.jobs.find((j) => j.title.startsWith('Fake')).jobId).toBe(10);
  expect(mockStorageData.jobs.find((j) => j.title.startsWith('Fake')).onChain).toBeFalsy();
  const sync = new SyncService(5);
  const storage = await jobStorage.readStorage();
  mockGetBounty = jest.fn().mockResolvedValue({ creator: VICTIM, evaluationCid: 'QmVictim', bountyAmountWei: '1000', submissionCloseTime: 1789400000 });
  await sync._processEvent({ name: 'BountyCreated', args: { bountyId: 12n, evaluationCid: 'QmVictim', creator: VICTIM, submissionDeadline: 1789400000n }, blockNumber: 1, transactionHash: '0xv' },
    storage, ESCROW, { getBounty: mockGetBounty });
  const at12 = storage.jobs.filter((j) => j.jobId === 12);
  expect(at12.length).toBe(1);
  expect(sync._findJob(storage, 12, ESCROW).evaluationCid).toBe('QmVictim');
});

it('sync: an unlinked API job squatting the new bountyId does not shadow the real bounty', async () => {
  // Attacker's API-only job already holds id 12 (nextId ran ahead of bountyCount); the victim's
  // pending job is 13 and its createBounty landed as bounty 12.
  mockStorageData = { jobs: [job(12, 'QmAttacker', 'Fake: pays 100 ETH', ATTACKER), job(13, 'QmVictim', 'Real bounty', VICTIM)], nextId: 14 };
  mockStorageData.jobs.forEach((j) => { j.contractAddress = ESCROW; });
  const sync = new SyncService(5);
  const storage = await jobStorage.readStorage();
  mockGetBounty = jest.fn().mockResolvedValue({ creator: VICTIM, evaluationCid: 'QmVictim', bountyAmountWei: '1000', submissionCloseTime: 1789400000 });
  await sync._processEvent({ name: 'BountyCreated', args: { bountyId: 12n, evaluationCid: 'QmVictim', creator: VICTIM, submissionDeadline: 1789400000n }, blockNumber: 1, transactionHash: '0xv' },
    storage, ESCROW, { getBounty: mockGetBounty });
  expect(storage.jobs.filter((j) => j.jobId === 12)).toHaveLength(1);
  expect(sync._findJob(storage, 12, ESCROW).evaluationCid).toBe('QmVictim');
  expect(storage.jobs.find((j) => j.evaluationCid === 'QmAttacker')).toBeTruthy(); // kept, not deleted
});

it('sync + merge: the linked bounty keeps its own fields and the squatter is moved, not merged', async () => {
  mockStorageData = { jobs: [job(12, 'QmAttacker', 'Fake: pays 100 ETH', ATTACKER), job(13, 'QmVictim', 'Real bounty', VICTIM)], nextId: 14 };
  mockStorageData.jobs.forEach((j) => { j.contractAddress = ESCROW; });
  mockStorageData.jobs[0].publicSubmissions = true;
  const sync = new SyncService(5);
  const storage = await jobStorage.readStorage();
  mockGetBounty = jest.fn().mockResolvedValue({ creator: VICTIM, evaluationCid: 'QmVictim', bountyAmountWei: '1000', submissionCloseTime: 1789400000 });
  await sync._processEvent({ name: 'BountyCreated', args: { bountyId: 12n, evaluationCid: 'QmVictim', creator: VICTIM, submissionDeadline: 1789400000n }, blockNumber: 1, transactionHash: '0xv' },
    storage, ESCROW, { getBounty: mockGetBounty });
  await jobStorage.withStorage((fresh) => sync._mergeStorageChanges(storage, fresh, ESCROW));
  const at12 = mockStorageData.jobs.filter((j) => j.jobId === 12);
  expect(at12).toHaveLength(1);
  expect(at12[0]).toMatchObject({ evaluationCid: 'QmVictim', creator: VICTIM, syncedFromBlockchain: true });
  expect(at12[0].publicSubmissions).toBeFalsy();              // not inherited from the squatter
  expect(mockStorageData.jobs.filter((j) => j.evaluationCid === 'QmVictim')).toHaveLength(1); // no stale copy
  const squatter = mockStorageData.jobs.find((j) => j.evaluationCid === 'QmAttacker');
  expect(squatter.jobId).toBe(13);                            // moved to the id the victim vacated, kept
  expect(mockStorageData.jobs).toHaveLength(2);
});

it('getJob serves the chain-linked record when an unlinked job shares its id', async () => {
  const squat = { ...job(20, 'QmAttacker', 'Fake', ATTACKER), contractAddress: ESCROW };
  const real = { ...job(20, 'QmVictim', 'Real', VICTIM), contractAddress: ESCROW, syncedFromBlockchain: true };
  mockStorageData = { jobs: [squat, real], nextId: 21 };
  expect((await jobStorage.getJob(20)).evaluationCid).toBe('QmVictim');
});

it('manual sync requests (free API keys) are throttled', async () => {
  const sync = new SyncService(5);
  let runs = 0;
  sync.syncNow = async () => { runs++; };
  expect(await sync.requestSync()).toBe(true);
  for (let i = 0; i < 20; i++) expect(await sync.requestSync()).toBe(false);
  expect(runs).toBe(1);
});
