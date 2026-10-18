/**
 * A passing finalize held up by an earlier, already-evaluated submission that nobody
 * finalized (2026-10-18, mainnet bounty 255: sub 1 passed and sat at AWAIT_EARLIER
 * behind sub 0, whose failing result had been in for hours).
 *
 * POST /finalize and GET /diagnose must name the blocker and hand over the
 * transaction that resolves it; a blocker still in evaluation gets none.
 */

jest.setTimeout(15000);

let mockStorageData = { jobs: [], nextId: 0 };

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_path, data) => {
        mockStorageData = JSON.parse(data);
        return Promise.resolve();
      }),
      rename: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../config', () => ({
  config: {
    network: 'base',
    bountyEscrowAddress: '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6',
    ipfsReadGateways: [],
    chainId: 8453,
    explorer: 'https://basescan.org',
  },
}));

jest.mock('../utils/bountyValidator', () => {
  const actual = jest.requireActual('../utils/bountyValidator');
  return { ...actual, validateBounty: jest.fn().mockResolvedValue({ valid: true, issues: [] }) };
});

jest.mock('../utils/verdiktaService', () => {
  const actual = jest.requireActual('../utils/verdiktaService');
  return { ...actual, isVerdiktaServiceAvailable: () => false };
});

// Chain state: per-submission { hunter, status, nextAction } plus the pending list.
let mockChain;
const mockContract = {
  pendingSubmissionIds: jest.fn(async () => mockChain.pending.map(BigInt)),
  getSubmission: jest.fn(async (_b, id) => {
    const s = mockChain.subs[Number(id)];
    return {
      hunter: s.hunter, status: s.status ?? 1, hunterCid: 'QmHunter', evalWallet: '0xeval',
      verdiktaAggId: '0x' + String(id).padStart(64, '0'), funder: s.hunter,
      submittedAt: Math.floor(Date.now() / 1000) - 7200, finalizedAt: 0, acceptance: 0, rejection: 0,
    };
  }),
  nextAction: jest.fn(async (_b, id) => mockChain.subs[Number(id)].nextAction),
};
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    contract: mockContract,
    checkEvaluationReady: jest.fn().mockResolvedValue({ ready: true, scores: { acceptance: 92, rejection: 8 } }),
    getForceFailEligibility: jest.fn().mockResolvedValue({ eligible: false, hasResult: true }),
    estimateResolveGas: jest.fn(async () => ({ gasLimit: '600000', estimatedGas: '400000', source: 'estimate' })),
  }),
}));

const express = require('express');
const request = require('supertest');
const { ethers } = require('ethers');
const jobRoutes = require('../routes/jobRoutes');
const { findFinalizeBlockers, blockersHint } = require('../utils/finalizeBlockers');

const WINNER = '0xA3b4000000000000000000000000000000000001';
const LOSER = '0x4c72000000000000000000000000000000000002';
const OTHER = '0x9999000000000000000000000000000000000003';
const IFACE = new ethers.Interface([
  'function finalizeSubmission(uint256 bountyId, uint256 submissionId)',
  'function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)',
]);

function app() {
  const a = express();
  a.use(express.json());
  a.locals.ipfsClient = { fetchFromIPFS: jest.fn() };
  a.use('/jobs', jobRoutes);
  return a;
}

function seedJob(subs) {
  mockStorageData = {
    nextId: 256,
    jobs: [{
      jobId: 255, title: 'Bounty 255', creator: '0xcreator', bountyAmount: 0.01, threshold: 80,
      evaluationCid: 'QmEval', classId: 128, status: 'OPEN', createdAt: 1, onChain: true, syncedFromBlockchain: true,
      contractAddress: '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6',
      submissions: subs.map((s, i) => ({ submissionId: i, hunter: s.hunter, status: 'PENDING_EVALUATION', submittedAt: 1 })),
    }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockChain = {
    pending: [0, 1],
    subs: [
      { hunter: LOSER, nextAction: 'FINALIZE' },
      { hunter: WINNER, nextAction: 'AWAIT_EARLIER' },
    ],
  };
  seedJob(mockChain.subs);
});

describe('findFinalizeBlockers', () => {
  it('lists earlier pending submissions by other hunters, lowest first, with the resolving call', async () => {
    mockChain.pending = [3, 0, 2, 1];
    mockChain.subs = [
      { hunter: OTHER, nextAction: 'FORCE_FAIL' },
      { hunter: WINNER, nextAction: 'FINALIZE' },          // same hunter: never blocks
      { hunter: LOSER, nextAction: 'FINALIZE' },
      { hunter: WINNER, nextAction: 'AWAIT_EARLIER' },     // the one being finalized
    ];
    const blockers = await findFinalizeBlockers(mockContract, 255, 3);
    expect(blockers).toEqual([
      { submissionId: 0, hunter: OTHER, nextAction: 'FORCE_FAIL', method: 'failTimedOutSubmission' },
      { submissionId: 2, hunter: LOSER, nextAction: 'FINALIZE', method: 'finalizeSubmission' },
    ]);
  });

  it('ignores later submissions and gives no call for one still in evaluation', async () => {
    mockChain.pending = [0, 1, 2];
    mockChain.subs = [
      { hunter: LOSER, nextAction: 'AWAIT_ORACLE' },
      { hunter: WINNER, nextAction: 'AWAIT_EARLIER' },
      { hunter: OTHER, nextAction: 'FINALIZE' },
    ];
    const blockers = await findFinalizeBlockers(mockContract, 255, 1);
    expect(blockers).toEqual([{ submissionId: 0, hunter: LOSER, nextAction: 'AWAIT_ORACLE', method: null }]);
    expect(blockersHint(blockers)).toMatch(/still in evaluation\. Retry after they resolve/);
  });
});

describe('POST /:jobId/submissions/:submissionId/finalize', () => {
  const finalize = () => request(app()).post('/jobs/255/submissions/1/finalize').send({ hunter: WINNER });

  it('names the unfinalized earlier submission and returns the transaction that resolves it', async () => {
    const res = await finalize();
    expect(res.status).toBe(200);
    expect(res.body.nextAction).toBe('AWAIT_EARLIER');
    expect(res.body.transaction.data).toBe(IFACE.encodeFunctionData('finalizeSubmission', [255, 1]));
    expect(res.body.blockedBy).toEqual([{
      submissionId: 0, hunter: LOSER, nextAction: 'FINALIZE', method: 'finalizeSubmission',
      transaction: {
        to: '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6',
        data: IFACE.encodeFunctionData('finalizeSubmission', [255, 0]),
        value: '0', chainId: 8453, gasLimit: '600000',
      },
    }]);
    expect(res.body.hint).toMatch(/anyone may do: send each blockedBy\[\]\.transaction/);
  });

  it('encodes force-fail for a blocker whose round ended with no result', async () => {
    mockChain.subs[0].nextAction = 'FORCE_FAIL';
    const res = await finalize();
    expect(res.body.blockedBy[0].method).toBe('failTimedOutSubmission');
    expect(res.body.blockedBy[0].transaction.data).toBe(IFACE.encodeFunctionData('failTimedOutSubmission', [255, 0]));
  });

  it('adds nothing when the submission can be finalized now', async () => {
    mockChain.subs[1].nextAction = 'FINALIZE';
    const res = await finalize();
    expect(res.status).toBe(200);
    expect(res.body.nextAction).toBe('FINALIZE');
    expect(res.body.blockedBy).toBeUndefined();
    expect(mockContract.pendingSubmissionIds).not.toHaveBeenCalled();
  });

  it('still returns the finalize calldata if the blocker lookup fails', async () => {
    mockContract.pendingSubmissionIds.mockRejectedValueOnce(new Error('rpc down'));
    const res = await finalize();
    expect(res.status).toBe(200);
    expect(res.body.nextAction).toBe('AWAIT_EARLIER');
    expect(res.body.blockedBy).toBeUndefined();
    expect(res.body.transaction.data).toBe(IFACE.encodeFunctionData('finalizeSubmission', [255, 1]));
  });
});

describe('GET /:jobId/submissions/:submissionId/diagnose', () => {
  it('carries blockedBy and a recommendation for AWAIT_EARLIER', async () => {
    const res = await request(app()).get('/jobs/255/submissions/1/diagnose');
    expect(res.status).toBe(200);
    const { diagnosis } = res.body;
    expect(diagnosis.nextAction).toBe('AWAIT_EARLIER');
    expect(diagnosis.blockedBy).toHaveLength(1);
    expect(diagnosis.blockedBy[0]).toMatchObject({ submissionId: 0, nextAction: 'FINALIZE', method: 'finalizeSubmission' });
    expect(diagnosis.recommendations.some((r) => r.includes('payout waits for earlier submission(s) #0'))).toBe(true);
  });
});
