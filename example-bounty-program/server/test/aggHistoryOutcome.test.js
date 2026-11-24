/**
 * getAggHistory outcome labels (v2 aggregator), notably a failed round with no commits (#40).
 *
 * The chain reads are stubbed on a real VerdiktaService instance so the outcome logic runs
 * unchanged: getRoundInfo reports the round's phase and deadline, getSlot each drawn juror, and
 * getLogs returns no events (timing is optional).
 */
const { ethers } = require('ethers');
const { VerdiktaService, LIKELY_MALFORMED_OUTCOME, arbiterStatus } = require('../utils/verdiktaService');

const AGG_ID = ethers.zeroPadValue('0x07', 32);           // v2 ids are sequential
const AGG = '0x' + '1'.repeat(40);
const CURRENT_BLOCK = 50_000_000;
const now = () => Math.floor(Date.now() / 1000);

function makeService({ phase, jurors = 0, committed = 0, revealed = 0, deadline = now() - 60, failedPhase = 3 }) {
  const svc = new VerdiktaService('http://127.0.0.1:1', AGG, 0);
  const real = svc.aggregator;
  const iface = real.interface;
  svc.provider = { getBlockNumber: async () => CURRENT_BLOCK };
  svc._getBlockTimestamps = async () => ({});
  svc._getLogsChunked = async (address, topics) => {
    if (topics[0] === iface.getEvent('EvaluationFailed').topicHash && phase === 8) {
      const { data, topics: t } = iface.encodeEventLog(iface.getEvent('EvaluationFailed'), [AGG_ID, failedPhase]);
      return [{ data, topics: t, blockNumber: CURRENT_BLOCK - 10, transactionHash: ethers.ZeroHash }];
    }
    return [];
  };
  const stub = {
    interface: iface,
    getAddress: async () => AGG,
    getJury: async () => [6n, 5n, 4n, 3n, 300n],
    getRoundInfo: async () => ({
      phase: BigInt(phase), requestBlock: BigInt(CURRENT_BLOCK - 1500), sealedHash: phase > 1 ? '0x' + 'ab'.repeat(32) : ethers.ZeroHash,
      closeBlock: 0n, received: 10n, baseFees: 6n, bonuses: 0n, rewards: 0n,
      deadline: phase >= 3 ? BigInt(deadline) : 0n, windowEnd: 0n, commits: BigInt(committed), requestTime: BigInt(now() - 3600)
    }),
    getSlot: async (aggId, i) => ({
      oracle: i < jurors ? ethers.getAddress('0x' + String(i + 2).repeat(40)) : ethers.ZeroAddress,
      fee: 1n, key: ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), payee: ethers.ZeroAddress,
      committedAt: 0n, flags: BigInt(1 | (i < committed ? 2 : 0) | (i < revealed ? 4 | 8 | 16 : 0)), qcode: i < revealed ? 1n : 0n,
      commitHash: ethers.ZeroHash
    })
  };
  svc.aggregator = stub;
  return svc;
}

describe('getAggHistory outcome (v2)', () => {
  it('labels a failed drawn round whose jurors never committed LIKELY MALFORMED', async () => {
    const h = await makeService({ phase: 8, jurors: 6 }).getAggHistory(AGG_ID);
    expect(h.found).toBe(true);
    expect(h.analysis.totalSlots).toBe(6);
    // the round's own jury, from getJury (one aggregator serves every jury size)
    expect(h.contractParams).toEqual({ K: 6, M: 5, N: 4, P: 3, timeout: 300 });
    expect(h.analysis.committed).toBe(0);
    expect(h.outcome).toBe(LIKELY_MALFORMED_OUTCOME);
    expect(h.analysis.likelyMalformed).toBe(true);
  });

  it('a drawn round past its deadline with no commits, not yet settled, is LIKELY MALFORMED too', async () => {
    const h = await makeService({ phase: 3, jurors: 6, deadline: now() - 5 }).getAggHistory(AGG_ID);
    expect(h.outcome).toBe(LIKELY_MALFORMED_OUTCOME);
  });

  it('a failed round that had commits is FAILED in the phase it failed in', async () => {
    const h = await makeService({ phase: 8, jurors: 6, committed: 5, revealed: 2, failedPhase: 5 }).getAggHistory(AGG_ID);
    expect(h.outcome).toBe('FAILED (reveal phase)');
    expect(h.analysis.revealed).toBe(2);
    expect(h.analysis.quality.close).toBe(2);
    expect(h.analysis.likelyMalformed).toBe(false);
  });

  it('an undrawn round is never malformed: in process, or cancelled once it can never be drawn', async () => {
    let h = await makeService({ phase: 1 }).getAggHistory(AGG_ID);
    expect(h.analysis.totalSlots).toBe(0);
    expect(h.outcome).toBe('IN PROCESS (draw phase)');
    h = await makeService({ phase: 9 }).getAggHistory(AGG_ID);
    expect(h.outcome).toBe('CANCELLED (never drawn; prepay to the treasury)');
    expect(h.analysis.likelyMalformed).toBe(false);
  });

  it('a round still before its deadline is in process, and a finished one completed', async () => {
    expect((await makeService({ phase: 3, jurors: 6, committed: 2, deadline: now() + 100 }).getAggHistory(AGG_ID)).outcome)
      .toBe('IN PROCESS (commit phase)');
    expect((await makeService({ phase: 7, jurors: 6, committed: 6, revealed: 4 }).getAggHistory(AGG_ID)).outcome)
      .toBe('COMPLETED');
  });

  it('refuses an aggregator other than the escrow\'s', async () => {
    await expect(makeService({ phase: 8, jurors: 6 }).getAggHistory(AGG_ID, { aggregator: '0x' + '2'.repeat(40) }))
      .rejects.toThrow(/not the escrow's aggregator/);
  });

  it('an id the aggregator has no round for is not found', async () => {
    const h = await makeService({ phase: 0 }).getAggHistory(AGG_ID);
    expect(h.found).toBe(false);
  });
});

// A service whose getLogs returns the given events (name -> [args]) and whose slots are given flags.
const TREASURY = ethers.getAddress('0x' + '7'.repeat(40));
const REQUESTER = ethers.getAddress('0x' + '8'.repeat(40));
function eventService({ phase, slotFlags = [], events = {}, info = {}, promoter = null }) {
  const svc = makeService({ phase, jurors: slotFlags.length });
  const iface = svc.aggregator.interface;
  svc._getLogsChunked = async (address, topics) => {
    const name = Object.keys(events).find((n) => iface.getEvent(n).topicHash === topics[0]);
    return (events[name] || []).map((args, k) => {
      const { data, topics: t } = iface.encodeEventLog(iface.getEvent(name), [AGG_ID, ...args]);
      return { data, topics: t, blockNumber: CURRENT_BLOCK - 100 + k, transactionHash: '0x' + String(k + 1).repeat(64) };
    });
  };
  svc.provider.getTransaction = async () => ({ from: promoter });
  const base = svc.aggregator.getRoundInfo;
  Object.assign(svc.aggregator, {
    treasury: async () => TREASURY,
    getRoundInfo: async () => ({ ...(await base()), ...info }),
    getSlot: async (aggId, i) => ({
      oracle: i < slotFlags.length ? ethers.getAddress('0x' + String(i + 2).repeat(40)) : ethers.ZeroAddress,
      fee: 5n, key: ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), payee: ethers.ZeroAddress,
      committedAt: 0n, flags: BigInt(slotFlags[i] ?? 0), qcode: 0n, commitHash: ethers.ZeroHash
    })
  });
  return svc;
}

describe('getAggHistory v2 slots, timing and money', () => {
  it('skipped slots (flags 0, SlotSkipped) are not paid and do not make a round malformed', async () => {
    // slots 0-1 skipped (owner() failed, commit dispatch reverted), 2-5 dispatched and committed
    const h = await eventService({ phase: 8, slotFlags: [0, 0, 3, 3, 3, 3],
      events: { SlotSkipped: [[0, 1], [1, 2]], EvaluationFailed: [[5]] } }).getAggHistory(AGG_ID);
    expect(h.analysis).toMatchObject({ skipped: 2, skippedSlotIds: [0, 1], dispatched: 4, nonResponding: 0, likelyMalformed: false });
    expect(h.slots[0]).toMatchObject({ skipped: true, dispatched: false, basePaidWei: null });
    expect(h.slots[0].skipReasons[0]).toMatchObject({ reason: 1 });
    expect(h.slots[1].skipReasons[0].text).toMatch(/commit request dispatch reverted/);
    expect(h.outcome).toBe('FAILED (reveal phase)');
  });

  it('only skipped slots plus dispatched ones that never committed is malformed; all skipped is not', async () => {
    let h = await eventService({ phase: 8, slotFlags: [0, 1, 1, 1, 1, 1] }).getAggHistory(AGG_ID);
    expect(h.outcome).toBe(LIKELY_MALFORMED_OUTCOME);
    h = await eventService({ phase: 8, slotFlags: [0, 0, 0, 0, 0, 0], events: { EvaluationFailed: [[3]] } }).getAggHistory(AGG_ID);
    expect(h.analysis.likelyMalformed).toBe(false);
    expect(h.outcome).toBe('FAILED (commit phase)');
  });

  it('labels a refund to the treasury vs to the requester, and the failure phase\'s money rule', async () => {
    const h = await eventService({ phase: 8, slotFlags: [3, 3, 3, 3, 3, 3],
      events: { EvaluationFailed: [[4]], RequesterRefunded: [[TREASURY, 1000n]] } }).getAggHistory(AGG_ID);
    expect(h.money.refunds[0]).toMatchObject({ to: TREASURY, toTreasury: true, amountWei: '1000' });
    expect(h.money).toMatchObject({ toTreasuryWei: '1000', refundedWei: '0', treasury: TREASURY });
    expect(h.failure.moneyRule).toMatch(/never promoted: to the treasury/);
    const r = await eventService({ phase: 8, slotFlags: [3, 3, 3, 3, 3, 3],
      events: { EvaluationFailed: [[5]], RequesterRefunded: [[REQUESTER, 700n]] } }).getAggHistory(AGG_ID);
    expect(r.money).toMatchObject({ toTreasuryWei: '0', refundedWei: '700' });
    expect(r.money.refunds[0].toTreasury).toBe(false);
  });

  it('a cancelled round sends RoundCancelled.toTreasury to the treasury', async () => {
    const h = await eventService({ phase: 9, events: { RoundCancelled: [[900n]] } }).getAggHistory(AGG_ID);
    expect(h.money).toMatchObject({ toTreasuryWei: '900', cancelled: { toTreasuryWei: '900' } });
  });

  it('splits rewards into draw, promote (rewards - draw - beacons) and beacons, and finds the promoter', async () => {
    const P = ethers.getAddress('0x' + '9'.repeat(40));
    const h = await eventService({ phase: 7, slotFlags: [31, 31, 31, 31, 3, 3], promoter: P, info: { rewards: 70n },
      events: { JuryDrawn: [[REQUESTER, 20n]], BeaconStageStarted: [[4n]], BeaconPayment: [[P, 15n], [REQUESTER, 15n]],
        CommitPhaseComplete: [[5n]], BonusPayment: [[0n, P, 15n], [2n, P, 15n]] } }).getAggHistory(AGG_ID);
    expect(h.money.rewards).toMatchObject({ drawWei: '20', beaconsWei: '30', promoteWei: '20', promoter: P });
    expect(h.money.beacons).toMatchObject({ stageStarted: true, picked: 4 });
    expect(h.promotion).toMatchObject({ promoted: 5, promoter: P });
    expect(h.slots.map((x) => x.inCluster)).toEqual([true, false, true, false, false, false]);
  });

  it('with no BonusPayment (zero fees) the cluster is unknown', async () => {
    const h = await eventService({ phase: 7, slotFlags: [31, 31, 31, 31, 3, 3] }).getAggHistory(AGG_ID);
    expect(h.analysis.clusterKnown).toBe(false);
    expect(h.slots[0].inCluster).toBeNull();
  });

  it('an undrawn round past a day after its request is draw-expired (cancel only, to the treasury)', async () => {
    const h = await eventService({ phase: 1, info: { requestTime: BigInt(now() - 86400 - 60) } }).getAggHistory(AGG_ID);
    expect(h.outcome).toBe('DRAW EXPIRED: can only be cancelled (prepay to the treasury)');
    expect(h.analysis.drawExpired).toBe(true);
  });
});

describe('arbiterStatus (v2 keeper state)'
, () => {
  const base = { flags: 1, blockedUntil: 0, frozen: false, qualityScore: 600, timelinessScore: 550 };
  it('reads registration, pause, exit, ban, stake, block, freeze and re-sync', () => {
    expect(arbiterStatus(base)).toBe('active');
    expect(arbiterStatus({ ...base, qualityScore: 500, timelinessScore: 500 })).toBe('new');
    expect(arbiterStatus({ ...base, flags: 0 })).toBe('inactive');
    // paused, exiting, under-staked: inactive; banned: blocked (as is the Table 2 lock)
    for (const f of [2, 8, 32]) expect(arbiterStatus({ ...base, flags: 1 | f })).toBe('inactive');
    expect(arbiterStatus({ ...base, flags: 1 | 4 })).toBe('blocked');
    expect(arbiterStatus({ ...base, blockedUntil: now() + 100 })).toBe('blocked');
    expect(arbiterStatus({ ...base, frozen: true })).toBe('frozen');
    expect(arbiterStatus({ ...base, flags: 1 | 64 })).toBe('frozen');
  });
});
