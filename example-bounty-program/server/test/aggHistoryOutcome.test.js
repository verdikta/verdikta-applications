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
  const svc = new VerdiktaService('http://127.0.0.1:1', [AGG], 0);
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
    K: async () => 6n, M: async () => 5n, N: async () => 4n, P: async () => 3n,
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
  svc.aggregators = [stub];
  svc.aggregator = stub;
  return svc;
}

describe('getAggHistory outcome (v2)', () => {
  it('labels a failed drawn round whose jurors never committed LIKELY MALFORMED', async () => {
    const h = await makeService({ phase: 8, jurors: 6 }).getAggHistory(AGG_ID);
    expect(h.found).toBe(true);
    expect(h.analysis.totalSlots).toBe(6);
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
    expect(h.outcome).toBe('CANCELLED (never drawn)');
    expect(h.analysis.likelyMalformed).toBe(false);
  });

  it('a round still before its deadline is in process, and a finished one completed', async () => {
    expect((await makeService({ phase: 3, jurors: 6, committed: 2, deadline: now() + 100 }).getAggHistory(AGG_ID)).outcome)
      .toBe('IN PROCESS (commit phase)');
    expect((await makeService({ phase: 7, jurors: 6, committed: 6, revealed: 4 }).getAggHistory(AGG_ID)).outcome)
      .toBe('COMPLETED');
  });

  it('an id the aggregator has no round for is not found', async () => {
    const h = await makeService({ phase: 0 }).getAggHistory(AGG_ID);
    expect(h.found).toBe(false);
  });
});

describe('arbiterStatus (v2 keeper state)', () => {
  const base = { flags: 1, blockedUntil: 0, frozen: false, qualityScore: 600, timelinessScore: 550 };
  it('reads registration, pause, exit, ban, stake, block, freeze and re-sync', () => {
    expect(arbiterStatus(base)).toBe('active');
    expect(arbiterStatus({ ...base, qualityScore: 500, timelinessScore: 500 })).toBe('new');
    expect(arbiterStatus({ ...base, flags: 0 })).toBe('inactive');
    for (const f of [2, 4, 8, 32]) expect(arbiterStatus({ ...base, flags: 1 | f })).toBe('inactive');
    expect(arbiterStatus({ ...base, blockedUntil: now() + 100 })).toBe('blocked');
    expect(arbiterStatus({ ...base, frozen: true })).toBe('frozen');
    expect(arbiterStatus({ ...base, flags: 1 | 64 })).toBe('frozen');
  });
});
