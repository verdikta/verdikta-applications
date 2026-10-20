/**
 * PATCH /jobs/:jobId/bountyId warns when the bounty went on chain with a deadline other
 * than the one POST /jobs/create planned. Mainnet #302 (2026-10-19): the agent encoded
 * 1792548000 (Oct 21 02:00Z) itself, 22 hours before the deadline its wager terms named.
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
let mockChainDeadline;
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    provider: { getTransactionReceipt: (h) => Promise.resolve(mockReceipts[h] ?? null) },
    getBounty: async () => ({ creator: '0x' + 'c1'.repeat(20), evaluationCid: 'QmWager', submissionCloseTime: mockChainDeadline }),
    contract: {},
  }),
}));
process.env.CHAIN_READ_RETRIES = '2';
process.env.CHAIN_READ_RETRY_MS = '1';

const { ethers } = require('ethers');
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

const CREATOR = '0x' + 'c1'.repeat(20);
const PROMISED = 1792627200;    // 2026-10-22T00:00:00Z, the date in the terms
const ENCODED = 1792548000;     // 2026-10-21T02:00:00Z, what went on chain
const iface = new ethers.Interface(['event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)']);

function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
function seed(fields) {
  mockStorageData = { nextId: 303, jobs: [{
    jobId: 302, title: 'Wager', creator: CREATOR, bountyAmount: 0.0005, threshold: 80, evaluationCid: 'QmWager',
    status: 'OPEN', createdAt: 1792452210, submissionOpenTime: 1792452210, submissions: [], ...fields,
  }] };
}
function link(chainDeadline) {
  mockChainDeadline = chainDeadline;
  const { topics, data } = iface.encodeEventLog('BountyCreated', [302, CREATOR, 'QmWager', 128, 80, 500000000000000n, chainDeadline]);
  mockReceipts = { '0xtx302': { blockNumber: 100, logs: [{ address: ESCROW, topics, data }] } };
  return request(app()).patch('/jobs/302/bountyId').send({ bountyId: 302, txHash: '0xtx302', blockNumber: 100 });
}
const job302 = () => mockStorageData.jobs.find((j) => j.jobId === 302);

describe('PATCH /bountyId deadline check', () => {
  it('warns when the on-chain deadline is 22 hours before the planned one, and still links', async () => {
    seed({ submissionCloseTime: PROMISED, plannedSubmissionCloseTime: PROMISED, submissionDeadlineExact: true });
    const res = await link(ENCODED);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.warnings).toEqual([expect.objectContaining({
      code: 'DEADLINE_MISMATCH',
      plannedSubmissionDeadline: PROMISED,
      plannedSubmissionDeadlineIso: '2026-10-22T00:00:00.000Z',
      onChainSubmissionDeadline: ENCODED,
      onChainSubmissionDeadlineIso: '2026-10-21T02:00:00.000Z',
      differenceSeconds: -79200,
    })]);
    expect(res.body.warnings[0].message).toMatch(/22h earlier than the 2026-10-22T00:00:00.000Z/);
    expect(res.body.warnings[0].fix).toMatch(/submissionDeadline/);
    // The chain wins in storage; the plan is kept for later comparison.
    expect(job302()).toMatchObject({ onChain: true, submissionCloseTime: ENCODED, plannedSubmissionCloseTime: PROMISED });
  });

  it('holds an exact deadline to the second', async () => {
    seed({ submissionCloseTime: PROMISED, plannedSubmissionCloseTime: PROMISED, submissionDeadlineExact: true });
    const res = await link(PROMISED + 1);
    expect(res.body.warnings?.[0]).toMatchObject({ code: 'DEADLINE_MISMATCH', differenceSeconds: 1 });
  });

  it('says nothing when an exact deadline matches', async () => {
    seed({ submissionCloseTime: PROMISED, plannedSubmissionCloseTime: PROMISED, submissionDeadlineExact: true });
    const res = await link(PROMISED);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });

  it('allows a window-based deadline the drift of a slow wallet confirmation, but not more', async () => {
    seed({ submissionCloseTime: PROMISED, plannedSubmissionCloseTime: PROMISED });
    expect((await link(PROMISED + 10 * 60)).body.warnings).toBeUndefined();
    seed({ submissionCloseTime: PROMISED, plannedSubmissionCloseTime: PROMISED });
    const late = await link(PROMISED + 16 * 60);
    expect(late.body.warnings[0]).toMatchObject({ code: 'DEADLINE_MISMATCH', differenceSeconds: 960 });
    expect(late.body.warnings[0].message).toMatch(/16m later/);
  });

  it('still warns when the sync linked the bounty first and overwrote submissionCloseTime', async () => {
    seed({ submissionCloseTime: ENCODED, plannedSubmissionCloseTime: PROMISED, syncedFromBlockchain: true, onChain: true });
    const res = await link(ENCODED);
    expect(res.body.warnings?.[0]).toMatchObject({ code: 'DEADLINE_MISMATCH', differenceSeconds: -79200 });
  });

  it('uses the stored deadline of an older job created before plannedSubmissionCloseTime existed', async () => {
    seed({ submissionCloseTime: PROMISED });
    expect((await link(ENCODED)).body.warnings?.[0]).toMatchObject({ differenceSeconds: -79200 });
  });

  it('has nothing to compare for an older job the sync already overwrote', async () => {
    seed({ submissionCloseTime: ENCODED, syncedFromBlockchain: true });
    expect((await link(ENCODED)).body.warnings).toBeUndefined();
  });
});
