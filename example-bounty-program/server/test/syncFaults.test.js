/**
 * Chain and RPC faults around the event sync and the hot poll (round-2 security review, faults
 * direction): reorgs and lagging load-balanced nodes, a failed bootstrap chunk, a stale local
 * round id. The chain is a stub; jobs.json is in memory.
 */

let mockStore;
jest.mock('../utils/jobStorage', () => ({
  readStorageStrict: jest.fn(async () => JSON.parse(JSON.stringify(mockStore))),
  readStorage: jest.fn(async () => JSON.parse(JSON.stringify(mockStore))),
  readSyncState: jest.fn(async () => mockStore.syncState || null),
  getCurrentContractAddress: () => '0xescrow',
  withStorage: jest.fn(async (fn) => {
    const s = JSON.parse(JSON.stringify(mockStore));
    const r = await fn(s, {});
    mockStore = s;
    return r;
  }),
  listJobs: jest.fn(async () => ({ jobs: [] })),
}));
jest.mock('../utils/contractService', () => ({ getContractService: () => global.__chain }));
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0xescrow', keeperPrivateKey: '' } }));
jest.mock('../utils/archivalService', () => ({ getArchivalService: () => ({ processSubmissions: async () => {} }) }));

const { SyncService, syncHead } = require('../utils/syncService');
const logger = require('../utils/logger');
const { config } = require('../config');

const OLD = '0x' + '11'.repeat(32);
const NEW = '0x' + '22'.repeat(32);

function chain({ head = 1000, count = 0 } = {}) {
  const c = {
    head,
    count,
    getLogsCalls: [],
    countTags: [],
    getBlockNumber: jest.fn(async () => c.head),
    getEventsSince: jest.fn(async (from, to) => { c.getLogsCalls.push([from, to]); if (c.failRange && from <= c.failRange[1] && to >= c.failRange[0]) throw new Error('429 Too Many Requests'); return []; }),
    getBountyCount: jest.fn(async (tag) => { c.countTags.push(tag); return c.count; }),
    getBounty: jest.fn(async () => { throw new Error('bad bountyId'); }),
    getRoundState: jest.fn(async () => c.round),
    contract: { getSubmission: jest.fn(async () => ({ verdiktaAggId: c.chainAggId })) },
  };
  return c;
}

beforeEach(() => {
  mockStore = { jobs: [], nextId: 0 };
  delete config.syncConfirmations;
  for (const k of ['info', 'warn', 'debug', 'error']) jest.spyOn(logger, k).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('event sync cursor under reorgs and lagging nodes', () => {
  test('reads to SYNC_CONFIRMATIONS (default 3) behind the head', async () => {
    global.__chain = chain({ head: 1000 });
    mockStore.syncState = { lastSyncedBlock: 900, lastKnownBountyCount: 0, version: 2 };
    await new SyncService().syncNow();
    expect(global.__chain.getLogsCalls).toEqual([[901, 997]]);
    expect(mockStore.syncState.lastSyncedBlock).toBe(997);
    // and the bounty count is read at that block, not at whatever head the node behind the balancer has
    expect(global.__chain.countTags).toEqual([997]);
  });

  test('a head from a lagging node never moves the cursor back', async () => {
    global.__chain = chain({ head: 950 });
    mockStore.syncState = { lastSyncedBlock: 995, lastKnownBountyCount: 0, version: 2 };
    await new SyncService().syncNow();
    expect(global.__chain.getLogsCalls).toEqual([]);
    expect(mockStore.syncState.lastSyncedBlock).toBe(995);
  });

  test('syncHead honours a configured depth, including 0', () => {
    config.syncConfirmations = 0;
    expect(syncHead(100, 0)).toBe(100);
    config.syncConfirmations = 12;
    expect(syncHead(100, 0)).toBe(88);
    expect(syncHead(100, 95)).toBe(95);
  });

  test('a bootstrap chunk that fails is not skipped: no cursor is written, the next cycle retries', async () => {
    global.__chain = chain({ head: 25_005 });
    global.__chain.failRange = [10_000, 19_999];
    const svc = new SyncService();
    await svc.syncNow();
    expect(mockStore.syncState).toBeUndefined();
    expect(svc.syncErrors).toBe(1);
    delete global.__chain.failRange;
    await svc.syncNow();
    expect(mockStore.syncState.lastSyncedBlock).toBe(25_002);
  });
});

describe('hot poll: the keeper is sent the chain\'s round, not a stale local one', () => {
  test('PROMOTE goes to the round on chain, and the record is healed', async () => {
    global.__chain = chain({ head: 1000, count: 1 });
    global.__chain.round = { nextAction: 'PROMOTE', phaseName: 'closing', hasResult: false, outcome: 'not_ready' };
    global.__chain.chainAggId = NEW;
    mockStore.jobs = [{ jobId: 0, contractAddress: '0xescrow', syncedFromBlockchain: true, status: 'OPEN', _chainFieldsHealed: true, creatorDeterminationPayment: '0.0', bountyAmountWei: '1', submissions: [
      { submissionId: 0, status: 'PENDING_EVALUATION', onChainStatus: 'PendingVerdikta', verdiktaAggId: OLD, aggIds: [OLD] }] }];
    mockStore.syncState = { lastSyncedBlock: 990, lastKnownBountyCount: 1, version: 2 };
    const svc = new SyncService();
    const tended = [];
    svc.roundKeeper = { prune() {}, housekeeping: async () => {}, tend: async (b, s, st) => { tended.push(st.aggId); return {}; } };
    svc.hotBountyIds.add(0);
    await svc.syncNow();
    expect(tended).toEqual([NEW]);
    expect(mockStore.jobs[0].submissions[0].verdiktaAggId).toBe(NEW);
    expect(mockStore.jobs[0].submissions[0].aggIds).toEqual([OLD, NEW]);
  });
});

describe('a restart keeps tending the rounds in flight', () => {
  test('the first cycle of a new process polls (and keeps) every in-flight submission on record', async () => {
    global.__chain = chain({ head: 1000, count: 1 });
    global.__chain.round = { nextAction: 'DRAW', phase: 1, phaseName: 'draw', hasResult: false, outcome: 'not_ready' };
    mockStore.jobs = [{ jobId: 0, contractAddress: '0xescrow', syncedFromBlockchain: true, status: 'OPEN', _chainFieldsHealed: true, creatorDeterminationPayment: '0.0', bountyAmountWei: '1', submissions: [
      { submissionId: 0, status: 'PENDING_EVALUATION', onChainStatus: 'PendingVerdikta', verdiktaAggId: OLD, aggIds: [OLD] }] }];
    mockStore.syncState = { lastSyncedBlock: 990, lastKnownBountyCount: 1, version: 2 };
    const svc = new SyncService();          // a restarted server: nothing in memory
    const tended = [];
    svc.roundKeeper = { prune() {}, housekeeping: async () => {}, tend: async (b, s, st) => { tended.push([b, s, st.nextAction]); return {}; } };
    await svc.syncNow();
    expect(tended).toEqual([[0, 0, 'DRAW']]);
    expect(svc.hotBountyIds.has(0)).toBe(true);
  });
});

describe('the keeper sends a beacon round\'s second draw without waiting out the first one\'s in-flight window', () => {
  const { RoundKeeper, IN_FLIGHT_MS } = require('../utils/roundKeeper');
  test('DRAW in the beacon phase is a new step, not a resend of the first DRAW', async () => {
    const calls = [];
    let t = 1_000_000;
    const fn = () => { const f = async () => { calls.push(t); return { hash: '0x' + calls.length }; }; f.estimateGas = async () => 100_000n; return f; };
    const escrow = { connect: () => ({ drawJury: fn() }) };
    const keeper = new RoundKeeper({ contractService: { contract: escrow }, signer: { getAddress: async () => '0xk' }, logger: { info() {}, warn() {}, debug() {} }, now: () => t });
    expect((await keeper.tend(1, 0, { nextAction: 'DRAW', phase: 1, aggId: OLD })).sent).toBe(true);
    t += 20_000;   // the beacon quorum is in; the requester's 30 s draw priority runs from it
    expect((await keeper.tend(1, 0, { nextAction: 'DRAW', phase: 2, aggId: OLD })).sent).toBe(true);
    t += 5_000;    // but the same phase is still a resend
    expect((await keeper.tend(1, 0, { nextAction: 'DRAW', phase: 2, aggId: OLD })).reason).toBe('in_flight');
    expect(IN_FLIGHT_MS).toBeGreaterThan(25_000);
  });
});

