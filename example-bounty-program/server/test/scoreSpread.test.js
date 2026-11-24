/**
 * Arbiter score spread (utils/scoreSpread.js), v2 model: a round's samples are its N counted reveals
 * (getOutcomeScores at the FUND index), the cluster is the BonusPayment payees (unknown without
 * bonuses), the pass count follows BountyRules.judge, every re-run round is kept, and the report is
 * served by GET /api/analytics/score-spread; the incremental collector skips settled rounds.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'AB'.repeat(20) } }));
jest.mock('../utils/verdiktaService', () => ({ getVerdiktaService: () => null, isVerdiktaServiceAvailable: () => false }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({}) }));
let mockJobs = [];
jest.mock('../utils/jobStorage', () => ({ listJobs: jest.fn(async () => ({ jobs: mockJobs })), readStorage: jest.fn(async () => ({ jobs: mockJobs })) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { ethers } = require('ethers');
const ss = require('../utils/scoreSpread');
const { analyticsCache } = require('../utils/analyticsCacheService');

const NOW = 1_800_000_000;
const DAY = 86400;
const id = (n) => '0x' + n.toString(16).padStart(64, '0');
// A counted reveal: its raw FUND score (0..1,000,000) and arbiter.
const reveal = (slot, accept, extra = {}) => ({
  slot, operator: '0x' + '11'.repeat(20), key: '0x' + String(slot + 1).padStart(64, '0'),
  jobId: ethers.hexlify(ethers.toUtf8Bytes('a'.repeat(32))), block: 100 + slot, fund: String(Math.round(accept * 10000)), ...extra
});
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

describe('roundSpread', () => {
  test('sample sd of the scores', () => {
    const r = ss.roundSpread([90, 92, 91, 40]);
    expect(r.n).toBe(4);
    expect(r.sd).toBeCloseTo(sd([90, 92, 91, 40]), 6);
    expect(r.median).toBeCloseTo(90.5, 6);
    expect(r.range).toBeCloseTo(52, 6);
    expect(r.maxDev).toBeCloseTo(50.5, 6);
  });

  test('needs at least two scores', () => {
    expect(ss.roundSpread([90])).toBeNull();
    expect(ss.roundSpread([])).toBeNull();
  });
});

describe('judgeRound (BountyRules.judge: Q of N at the threshold)', () => {
  const raw = (xs) => xs.map((x) => String(x * 10000));
  test('counts scores at or above threshold x 10,000; pass at Q, soft fail at R, else hard fail', () => {
    expect(ss.judgeRound(raw([80, 79.99, 95, 80]), 80, 3, 1)).toEqual({ passCount: 3, outcome: 'pass' });
    expect(ss.judgeRound(raw([80, 10, 10, 10]), 80, 3, 1)).toEqual({ passCount: 1, outcome: 'soft_fail' });
    expect(ss.judgeRound(raw([10, 10, 10, 10]), 80, 3, 1)).toEqual({ passCount: 0, outcome: 'hard_fail' });
  });
  test('without the quota the count is known but not the outcome', () => {
    expect(ss.judgeRound(raw([90, 90]), 80, null, null)).toEqual({ passCount: 2, outcome: null });
  });
});

describe('submissionRoundIds', () => {
  test('every re-run round, oldest first, deduplicated with verdiktaAggId', () => {
    expect(ss.submissionRoundIds({ aggIds: [id(1), id(2)], verdiktaAggId: id(2) })).toEqual([id(1), id(2)]);
    expect(ss.submissionRoundIds({ verdiktaAggId: id(3) })).toEqual([id(3)]);
    expect(ss.submissionRoundIds({ verdiktaAggId: '0x' + '0'.repeat(64) })).toEqual([]);
  });
});

// Rounds are cached under <jobId>:<aggId> (v2 ids are sequential per aggregator).
function keyed(rounds, jobs) {
  const out = {};
  for (const j of jobs) for (const sub of j.submissions) for (const a of ss.submissionRoundIds(sub)) if (rounds[a]) out[ss.roundKey(j.jobId, a)] = rounds[a];
  return out;
}

const fin = (extra) => ({ settled: true, finalized: true, reqBlock: 1000, ...extra });
function fixture() {
  const rounds = {
    // small jury: N = 4 counted reveals; cluster (bonus-paid) = slots 0, 1, 2
    [id(1)]: fin({ aggId: id(1), startTs: NOW - 1 * DAY - 100, finalAccept: 91, cluster: [0, 1, 2],
      late: [{ slot: 4, qcode: 3 }], reveals: [reveal(0, 90), reveal(1, 92), reveal(2, 91), reveal(3, 40)] }),
    // zero fees: no BonusPayment, cluster unknown
    [id(2)]: fin({ aggId: id(2), startTs: NOW - 10 * DAY, finalAccept: 80, cluster: null,
      reveals: [reveal(0, 80), reveal(1, 80), reveal(2, 80), reveal(3, 80)] }),
    // the first round of a re-run submission: soft fail
    [id(3)]: fin({ aggId: id(3), startTs: NOW - 2 * DAY, cluster: [0, 1],
      reveals: [reveal(0, 70), reveal(1, 74), reveal(2, 10), reveal(3, 12)] }),
    // Outside a 14-day window.
    [id(4)]: fin({ aggId: id(4), startTs: NOW - 20 * DAY, reveals: [reveal(0, 10), reveal(1, 90)] }),
    // A dead round: no result
    [id(5)]: { aggId: id(5), startTs: NOW - 3 * DAY, settled: true, finalized: false, phase: 8, reveals: [], toTreasuryWei: '500', beacons: 4 },
    // the re-run of id(3)
    [id(7)]: fin({ aggId: id(7), startTs: NOW - 2 * DAY + 3600, cluster: [0, 1, 2],
      reveals: [reveal(0, 85), reveal(1, 84), reveal(2, 86), reveal(3, 20)] })
  };
  const jobs = [
    { jobId: 7, title: 'Essay', threshold: 80, decisionSettings: { jury: 0, quota: 3, forfeitLine: 1 }, submissions: [
      { submissionId: 0, verdiktaAggId: id(1), submittedAt: NOW - DAY - 120, onChainStatus: 'PassedPaid', acceptance: 91 },
      { submissionId: 1, aggIds: [id(3), id(7)], verdiktaAggId: id(7), submittedAt: NOW - 2 * DAY, onChainStatus: 'PassedUnpaid' },
      // Creator approval: no arbiter round.
      { submissionId: 2, verdiktaAggId: '0x' + '0'.repeat(64), submittedAt: NOW - DAY, onChainStatus: 'PassedPaid' }
    ] },
    { jobId: 9, title: 'Code', threshold: 75, submissions: [
      { submissionId: 0, verdiktaAggId: id(2), submittedAt: NOW - 10 * DAY, onChainStatus: 'PassedPaid' },
      { submissionId: 1, verdiktaAggId: id(4), submittedAt: NOW - 20 * DAY },
      { submissionId: 2, verdiktaAggId: id(5), submittedAt: NOW - 3 * DAY },
      { submissionId: 3, verdiktaAggId: id(6), submittedAt: NOW - 600 } // not collected yet
    ] }
  ];
  return { state: { version: 3, rounds: keyed(rounds, jobs), lastRunAt: 5, lastError: null }, jobs };
}

describe('buildReport', () => {
  test('joins every round (re-runs included) to bounties, with pass counts, cluster and roll-ups', () => {
    const { state, jobs } = fixture();
    const rep = ss.buildReport(state, jobs, { days: 14, now: NOW });

    expect(rep.windowDays).toBe(14);
    expect(rep.samples.map((s) => [s.jobId, s.submissionId, s.round])).toEqual([[7, 1, 1], [7, 1, 2], [7, 0, 1], [9, 0, 1]]);
    const worst = rep.samples.find((s) => s.aggId === id(1));
    expect(worst).toMatchObject({ threshold: 80, quota: 3, finalScore: 91, n: 4, status: 'PassedPaid', passCount: 3, outcome: 'pass',
      clusterKnown: true, clusterN: 3, lateReveals: 1 });
    expect(worst.sd).toBeCloseTo(sd([90, 92, 91, 40]), 2);
    expect(worst.clusterSd).toBeCloseTo(1, 2);
    expect(worst.reveals.map((r) => [r.accept, r.inCluster])).toEqual([[90, true], [92, true], [91, true], [40, false]]);
    expect(worst.reveals[0].jobId).toBe('a'.repeat(32));
    expect(worst.reveals[0].key).toBe('0x' + '1'.padStart(64, '0'));
    expect(worst.var).toBeUndefined();
    expect(worst.clusterVar).toBeUndefined();

    // the re-run's first round soft-failed; the submission's status describes only its latest round
    const first = rep.samples.find((s) => s.aggId === id(3));
    expect(first).toMatchObject({ round: 1, rounds: 2, passCount: 0, outcome: 'hard_fail', status: null });
    expect(rep.samples.find((s) => s.aggId === id(7))).toMatchObject({ round: 2, passCount: 3, outcome: 'pass', status: 'PassedUnpaid' });
    // no quota on the record: count only; no BonusPayment: cluster unknown
    expect(rep.samples.find((s) => s.aggId === id(2))).toMatchObject({ passCount: 4, outcome: null, clusterKnown: false, clusterSd: null });

    expect(rep.coverage).toEqual({ submissions: 5, rounds: 6, pending: 1, notFound: 0, noResult: 1, badShape: 0, tooFewReveals: 0, lateReveals: 1 });
    expect(rep.revealCounts).toEqual({ 4: 4 });
    expect(rep.outcomes).toEqual({ pass: 2, soft_fail: 0, hard_fail: 1, unknown: 1 });

    // Pooled sd = sqrt(sum (n-1) var / sum (n-1)).
    const all = [[90, 92, 91, 40], [70, 74, 10, 12], [85, 84, 86, 20], [80, 80, 80, 80]];
    const vars = all.map((a) => [a.length - 1, sd(a) ** 2]);
    const pooled = Math.sqrt(vars.reduce((s, [d, v]) => s + d * v, 0) / vars.reduce((s, [d]) => s + d, 0));
    expect(rep.summary.pooledSd).toBeCloseTo(pooled, 2);
    expect(rep.summary).toMatchObject({ rounds: 4, reveals: 16 });
    // cluster: only the bonus-paid reveals of rounds with a known cluster
    const cl = [[90, 92, 91], [70, 74], [85, 84, 86]].map((x) => [x.length - 1, sd(x) ** 2]);
    const cpooled = Math.sqrt(cl.reduce((s, [d, v]) => s + d * v, 0) / cl.reduce((s, [d]) => s + d, 0));
    expect(rep.summaryCluster.pooledSd).toBeCloseTo(cpooled, 2);
    expect(rep.summaryCluster).toMatchObject({ rounds: 3, unknownRounds: 1 });
    expect(rep.daily.find((d) => d.daysAgo === 1).clusterPooledSd).toBeCloseTo(1, 2);

    expect(rep.daily).toHaveLength(14);
    expect(rep.daily[13].daysAgo).toBe(0);
    expect(rep.daily.find((d) => d.daysAgo === 0)).toMatchObject({ rounds: 0, pooledSd: null });
    expect(rep.halves.recent.rounds).toBe(3);
    expect(rep.halves.earlier.rounds).toBe(1);

    // arbiters are keyed by keeper key (one per slot here)
    expect(rep.arbiters).toHaveLength(4);
    expect(rep.arbiters.every((a) => a.key && a.reveals === 4)).toBe(true);

    expect(rep.bounties.map((b) => b.jobId)).toEqual([7, 9]);
    expect(rep.bounties[0]).toMatchObject({ title: 'Essay', rounds: 3, quota: 3 });
    expect(rep.bounties[1]).toMatchObject({ rounds: 1, pooledSd: 0 });
  });

  test('a one-number result: the length-1 score is the FUND score', () => {
    const state = { rounds: { ['1:' + id(1)]: fin({ aggId: id(1), startTs: NOW - DAY, outcomes: 1, cluster: null,
      reveals: [reveal(0, 60), reveal(1, 70)] }) } };
    const jobs = [{ jobId: 1, threshold: 65, decisionSettings: { quota: 1, forfeitLine: 1 }, submissions: [{ submissionId: 0, verdiktaAggId: id(1), submittedAt: NOW - DAY }] }];
    const s = ss.buildReport(state, jobs, { days: 14, now: NOW }).samples[0];
    expect(s.reveals.map((r) => r.accept)).toEqual([60, 70]);
    expect(s).toMatchObject({ passCount: 1, outcome: 'pass' });
  });

  test('per-arbiter gap from the other arbiters in the same round', () => {
    const k = (n) => '0x' + String(n).repeat(64);
    const state = { rounds: {
      ['1:' + id(1)]: fin({ aggId: id(1), startTs: NOW - DAY, reveals: [
        reveal(0, 90, { key: k(1) }), reveal(1, 92, { key: k(2) }), reveal(2, 91, { key: k(3) }), reveal(3, 40, { key: k(4) })] }),
      ['1:' + id(2)]: fin({ aggId: id(2), startTs: NOW - 2 * DAY, reveals: [
        reveal(0, 80, { key: k(1) }), reveal(1, 82, { key: k(2) }), reveal(2, 50, { key: k(4) })] })
    } };
    const jobs = [{ jobId: 1, submissions: [
      { submissionId: 0, verdiktaAggId: id(1), submittedAt: NOW - DAY },
      { submissionId: 1, verdiktaAggId: id(2), submittedAt: NOW - 2 * DAY }] }];
    const rep = ss.buildReport(state, jobs, { days: 14, now: NOW });
    const low = rep.arbiters[0];
    expect(low.key).toBe(k(4));
    expect(low.reveals).toBe(2);
    expect(low.meanGap).toBeCloseTo(((40 - 91) + (50 - 81)) / 2, 2); // -41
    expect(low.farFrac).toBe(1);
    expect(low.worst).toMatchObject({ jobId: 1, submissionId: 0, gap: -51 });
  });

  test('a longer window includes older rounds', () => {
    const { state, jobs } = fixture();
    const rep = ss.buildReport(state, jobs, { days: 30, now: NOW });
    expect(rep.samples).toHaveLength(5);
    expect(rep.daily).toHaveLength(30);
  });
});

describe('summarizeRounds', () => {
  test('counts beacon rounds, prepay lost to the treasury and late reveals', () => {
    const { state } = fixture();
    expect(ss.summarizeRounds(state)).toMatchObject({ rounds: 6, finalized: 5, failed: 1, beaconRounds: 1,
      treasuryRounds: 1, toTreasuryWei: '500', lateReveals: 1, roundsWithLate: 1 });
  });
});

const AGG = '0x' + '44'.repeat(20);
const KEEPER = '0x' + '55'.repeat(20);
const TREASURY = '0x' + '66'.repeat(20);
const { AGGREGATOR_ABI } = require('../utils/aggregatorAbi');
const IFACE = new ethers.Interface(AGGREGATOR_ABI);
const KIFACE = new ethers.Interface(['function jobIdOf(bytes32 key) view returns (bytes32)']);

describe('runCollection', () => {
  test('does not touch the RPC for rounds that are already settled', async () => {
    const { state, jobs } = fixture();
    state.rounds['9:' + id(8)] = { aggId: id(8), startTs: NOW - 40 * DAY, settled: true, reveals: [] };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spread-')), 'state.json');
    fs.writeFileSync(file, JSON.stringify(state));
    const boom = () => { throw new Error('unexpected RPC call'); };
    const provider = { getBlockNumber: boom, getBlock: boom, call: boom, getLogs: boom };
    const targets = jobs.flatMap((j) => j.submissions.flatMap((sub) => ss.submissionRoundIds(sub)).filter((a) => a !== id(6))
      .map((aggId) => ({ jobId: j.jobId, aggId, ts: NOW - DAY, aggregator: AGG })));
    const res = await ss.runCollection(targets, provider, { file, now: NOW });
    expect(res).toEqual({ fetched: 0, failed: 0 });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(after.rounds)).not.toContain('9:' + id(8)); // aged out of the 30-day look-back
    expect(Object.keys(after.rounds)).toContain('9:' + id(4));
    expect(after.rounds['7:' + id(1)].reveals).toHaveLength(4);
  });

  test('keys rounds by bounty: the same id on two aggregators is two rounds', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spread-')), 'state.json');
    const boom = jest.fn(async () => { throw new Error('rpc down'); });
    const provider = { getBlockNumber: boom, getBlock: boom, call: boom, getLogs: boom };
    const targets = [{ jobId: 1, aggId: id(3), ts: NOW - DAY, aggregator: AGG }, { jobId: 2, aggId: id(3), ts: NOW - DAY, aggregator: AGG }];
    await expect(ss.runCollection(targets, provider, { file, now: NOW })).rejects.toThrow('rpc down');
    expect(ss.getStatus().total).toBe(2);   // two cache entries were due, not one
  });
});

describe('fetchRound (v2)', () => {
  // A finalized two-outcome round: counted reveals from slots 4, 1, 0 (in reveal order), one late reveal.
  const fundScores = [900000, 920000, 400000];
  const slotOracle = (s) => '0x' + String(s + 1).repeat(40);
  function provider({ phase = 6, aggregated = [150000, 850000], bonuses = [[4, 5n], [1, 5n]], refunds = [] } = {}) {
    const ret = (fn, vals) => IFACE.encodeFunctionResult(fn, vals);
    const logs = {
      RevealReceived: [[4, false, 0], [1, false, 0], [3, true, 2], [0, false, 0]],
      BonusPayment: bonuses.map(([slot, amt]) => [slot, TREASURY, amt]),
      BeaconStageStarted: [],
      RequesterRefunded: refunds,
      EvaluationFailed: phase === 8 ? [[3]] : []
    };
    return {
      call: async ({ to, data }) => {
        if (to === KEEPER) {
          const tx = KIFACE.parseTransaction({ data });
          return KIFACE.encodeFunctionResult('jobIdOf', [ethers.encodeBytes32String('job' + Number(BigInt(tx.args[0])))]);
        }
        const tx = IFACE.parseTransaction({ data });
        switch (tx.name) {
          case 'getRoundInfo': return ret('getRoundInfo', [phase, 1000, ethers.ZeroHash, 0, 77, 0, 0, 0, NOW - 3000, 0, 4, NOW - 3600]);
          case 'getOutcomeScores': {
            const o = Number(tx.args[1]);
            return ret('getOutcomeScores', o === aggregated.length - 1 && phase >= 6 && phase <= 7 ? [fundScores, true] : [[], false]);
          }
          case 'getEvaluation': return ret('getEvaluation', [aggregated, 'QmA,QmB', true]);
          case 'keeper': return ret('keeper', [KEEPER]);
          case 'treasury': return ret('treasury', [TREASURY]);
          case 'getSlot': {
            const s = Number(tx.args[1]);
            return ret('getSlot', [[slotOracle(s), 1, ethers.zeroPadValue(ethers.toBeHex(s + 1), 32), ethers.ZeroAddress, 0, 31, 1, ethers.ZeroHash]]);
          }
          default: throw new Error('unexpected ' + tx.name);
        }
      },
      getLogs: async ({ topics }) => {
        const name = Object.keys(logs).find((n) => IFACE.getEvent(n).topicHash === topics[0]);
        return (logs[name] || []).map((args, k) => {
          const { data, topics: t } = IFACE.encodeEventLog(IFACE.getEvent(name), [id(5), ...args]);
          return { data, topics: t, blockNumber: 1100 + k, index: 0 };
        });
      }
    };
  }
  const ctx = (p) => ({ provider: p, head: 5000, headTs: NOW, blockTime: 2 });

  test('reads the counted FUND scores in reveal order, the arbiters, their jobIds, the cluster and late reveals', async () => {
    const rec = await ss.fetchRound(ctx(provider()), AGG, id(5), NOW - 3600);
    expect(rec).toMatchObject({ finalized: true, settled: true, finalAccept: 85, outcomes: 2, badShape: false,
      arbitersKnown: true, startTs: NOW - 3600, reqBlock: 1000, cluster: [4, 1], beacons: 0, toTreasuryWei: '0' });
    expect(rec.reveals.map((r) => [r.slot, r.operator, r.fund])).toEqual([
      [4, slotOracle(4), '900000'], [1, slotOracle(1), '920000'], [0, slotOracle(0), '400000']
    ]);
    expect(rec.reveals[0].key).toBe(ethers.zeroPadValue(ethers.toBeHex(5), 32));
    expect(ss.jobIdText(rec.reveals[0].jobId)).toBe('job5');
    expect(rec.late).toEqual([{ slot: 3, qcode: 2, block: 1102 }]);
  });

  test('a one-number result reads outcome 0; no BonusPayment leaves the cluster unknown', async () => {
    const rec = await ss.fetchRound(ctx(provider({ aggregated: [700000], bonuses: [] })), AGG, id(5));
    expect(rec).toMatchObject({ outcomes: 1, finalAccept: 70, cluster: null });
    expect(rec.reveals).toHaveLength(3);
  });

  test('a running round is re-read later; a dead one is final, with where its prepay went', async () => {
    expect(await ss.fetchRound(ctx(provider({ phase: 5 })), AGG, id(5))).toMatchObject({ settled: false, reveals: [] });
    const dead = await ss.fetchRound(ctx(provider({ phase: 8, refunds: [[TREASURY, 300n]] })), AGG, id(5));
    expect(dead).toMatchObject({ settled: true, finalized: false, reveals: [], failPhase: 3, toTreasuryWei: '300', refundedWei: '0' });
    expect(await ss.fetchRound(ctx(provider({ phase: 9 })), AGG, id(5))).toMatchObject({ settled: true, toTreasuryWei: '77' });
  });

  test('an id the aggregator has no round for is notFound', async () => {
    const p = provider({ phase: 0 });
    expect(await ss.fetchRound(ctx(p), AGG, id(5), NOW - 7200)).toMatchObject({ notFound: true, settled: true });
  });
});

describe('GET /api/analytics/score-spread', () => {
  const app = express();
  app.use('/api/analytics', require('../routes/analyticsRoutes'));

  beforeEach(() => analyticsCache.clear());

  test('serves the report for the requested window', async () => {
    const { state, jobs } = fixture();
    mockJobs = jobs;
    const spy = jest.spyOn(ss, 'readState').mockResolvedValue(state);
    const res = await request(app).get('/api/analytics/score-spread?days=400');
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.data.windowDays).toBe(ss.MAX_REPORT_DAYS);
    expect(res.body.data.status).toMatchObject({ running: false });
    expect(Array.isArray(res.body.data.samples)).toBe(true);
  });
});
