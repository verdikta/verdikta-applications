/**
 * Arbiter score spread (utils/scoreSpread.js): reveal decoding and commit check,
 * per-round spread, the report served by GET /api/analytics/score-spread, and the
 * incremental collector skipping rounds that are already settled.
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
const vec = (accept) => [String(Math.round((100 - accept) * 10000)), String(Math.round(accept * 10000))];
const reveal = (slot, accept, extra = {}) => ({
  slot, operator: '0x' + '11'.repeat(20), jobId: ethers.hexlify(ethers.toUtf8Bytes('a'.repeat(32))),
  block: 100 + slot, counted: slot < 3, scores: vec(accept), cid: `QmJust${slot}`, hashOk: true, ...extra
});
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

describe('reveal decoding and commit check', () => {
  test('decodes an operator fulfill and reproduces the aggregator commit hash', () => {
    const operator = '0x' + '22'.repeat(20);
    const callback = '0x' + '33'.repeat(20);
    const rid = id(7);
    const scores = ['120000', '880000'];
    const salt = 'abcdef0123456789abcd';
    const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256[]', 'string'], [rid, scores, `QmCid:${salt}`]);
    const tx = ss.OPERATOR_IFACE.encodeFunctionData('fulfillOracleRequestV', [rid, 0, callback, '0x12345678', 0, data]);

    const dec = ss.decodeOperatorFulfill(tx);
    expect(dec).toEqual({ requestId: rid, callback, scores, cid: `QmCid:${salt}` });
    const cs = ss.parseCidSalt(dec.cid);
    expect(cs).toEqual({ cid: 'QmCid', salt: BigInt('0x' + salt) });

    const enc = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256[]', 'uint256'], [operator, scores, BigInt('0x' + salt)]);
    expect(ss.revealCommitHash(operator, scores, cs.salt)).toBe(ethers.sha256(enc).slice(0, 34).toLowerCase());
    expect(ss.revealCommitHash(operator, ['120001', '879999'], cs.salt)).not.toBe(ss.revealCommitHash(operator, scores, cs.salt));
  });

  test('rejects malformed salts and non-fulfill calldata', () => {
    expect(ss.parseCidSalt('QmCid')).toBeNull();
    expect(ss.parseCidSalt('QmCid:xyz')).toBeNull();
    expect(() => ss.decodeOperatorFulfill('0xdeadbeef')).toThrow('not an operator fulfill call');
  });

  test('shows ASCII Chainlink jobIds as text', () => {
    expect(ss.jobIdText(ethers.hexlify(ethers.toUtf8Bytes('c7bcd383e05a49eda9f795d1c21a4c53')))).toBe('c7bcd383e05a49eda9f795d1c21a4c53');
    expect(ss.jobIdText(id(1))).toBe(id(1));
  });
});

describe('roundSpread', () => {
  test('sample sd of the accept share over every usable reveal', () => {
    const r = ss.roundSpread([reveal(0, 90), reveal(1, 92), reveal(2, 91), reveal(3, 40)]);
    expect(r.n).toBe(4);
    expect(r.sd).toBeCloseTo(sd([90, 92, 91, 40]), 6);
    expect(r.median).toBeCloseTo(90.5, 6);
    expect(r.range).toBeCloseTo(52, 6);
    expect(r.maxDev).toBeCloseTo(50.5, 6);
  });

  test('normalizes vectors to shares of 100 and drops off-length reveals', () => {
    const r = ss.roundSpread([
      { slot: 0, scores: ['1', '9'] },
      { slot: 1, scores: ['20', '80'] },
      { slot: 2, scores: ['5', '90', '5'] }
    ]);
    expect(r.n).toBe(2);
    expect(r.accept).toEqual([90, 80]);
  });

  test('needs at least two reveals', () => {
    expect(ss.roundSpread([reveal(0, 90)])).toBeNull();
    expect(ss.roundSpread([])).toBeNull();
  });
});

function fixture() {
  const rounds = {
    [id(1)]: { aggId: id(1), startTs: NOW - 1 * DAY - 100, settled: true, finalAccept: 91,
      reveals: [reveal(0, 90), reveal(1, 92), reveal(2, 91), reveal(3, 40)] },
    [id(2)]: { aggId: id(2), startTs: NOW - 10 * DAY, settled: true, finalAccept: 80,
      reveals: [reveal(0, 80), reveal(1, 80), reveal(2, 80)] },
    // A reveal that failed the commit check is excluded.
    [id(3)]: { aggId: id(3), startTs: NOW - 2 * DAY, settled: true,
      reveals: [reveal(0, 70), reveal(1, 74), reveal(2, 10, { hashOk: false })] },
    // Outside a 14-day window.
    [id(4)]: { aggId: id(4), startTs: NOW - 20 * DAY, settled: true, reveals: [reveal(0, 10), reveal(1, 90)] },
    // Only one reveal reached the chain.
    [id(5)]: { aggId: id(5), startTs: NOW - 3 * DAY, settled: true, reveals: [reveal(0, 50)] }
  };
  const jobs = [
    { jobId: 7, title: 'Essay', threshold: 80, submissions: [
      { submissionId: 0, verdiktaAggId: id(1), submittedAt: NOW - DAY - 120, onChainStatus: 'PassedPaid', acceptance: 91 },
      { submissionId: 1, verdiktaAggId: id(3), submittedAt: NOW - 2 * DAY, onChainStatus: 'Failed' },
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
  return { state: { version: 1, rounds, lastRunAt: 5, lastError: null }, jobs };
}

describe('buildReport', () => {
  test('joins rounds to bounties, worst first, with daily and per-bounty roll-ups', () => {
    const { state, jobs } = fixture();
    const rep = ss.buildReport(state, jobs, { days: 14, now: NOW });

    expect(rep.windowDays).toBe(14);
    expect(rep.samples.map((s) => [s.jobId, s.submissionId])).toEqual([[7, 0], [7, 1], [9, 0]]);
    const worst = rep.samples[0];
    expect(worst).toMatchObject({ threshold: 80, finalScore: 91, n: 4, countedN: 3, status: 'PassedPaid' });
    expect(worst.sd).toBeCloseTo(sd([90, 92, 91, 40]), 2);
    expect(worst.countedSd).toBeCloseTo(1, 2);
    expect(worst.reveals.map((r) => [r.accept, r.counted, r.justificationCid])).toEqual([
      [90, true, 'QmJust0'], [92, true, 'QmJust1'], [91, true, 'QmJust2'], [40, false, 'QmJust3']
    ]);
    expect(worst.reveals[0].jobId).toBe('a'.repeat(32));
    expect(worst.var).toBeUndefined();
    expect(rep.samples[1]).toMatchObject({ n: 2, sd: 2.83 });

    expect(rep.coverage).toEqual({ submissions: 5, pending: 1, notFound: 0, tooFewReveals: 1, failedCommitCheck: 1, undecodable: 0 });
    expect(rep.revealCounts).toEqual({ three: 1, four: 1, other: 1 });

    // Pooled sd = sqrt(sum (n-1) var / sum (n-1)).
    const vars = [[90, 92, 91, 40], [70, 74], [80, 80, 80]].map((a) => [a.length - 1, sd(a) ** 2]);
    const pooled = Math.sqrt(vars.reduce((s, [d, v]) => s + d * v, 0) / vars.reduce((s, [d]) => s + d, 0));
    expect(rep.summary.pooledSd).toBeCloseTo(pooled, 2);
    expect(rep.summary).toMatchObject({ rounds: 3, reveals: 9, agreeFrac: 0.33, outlierFrac: 0.33 });

    expect(rep.daily).toHaveLength(14);
    expect(rep.daily[13].daysAgo).toBe(0);
    expect(rep.daily.find((d) => d.daysAgo === 1)).toMatchObject({ rounds: 1 });
    expect(rep.daily.find((d) => d.daysAgo === 0)).toMatchObject({ rounds: 0, pooledSd: null });
    expect(rep.halves.recent.rounds).toBe(2);
    expect(rep.halves.earlier.rounds).toBe(1);

    // All fixture reveals share one operator, so slot order separates nothing; use the per-slot
    // operators of a dedicated round instead (below). Here: one arbiter key, every reveal counted.
    expect(rep.arbiters).toHaveLength(1);
    expect(rep.arbiters[0].reveals).toBe(9);

    expect(rep.bounties.map((b) => b.jobId)).toEqual([7, 9]);
    expect(rep.bounties[0]).toMatchObject({ title: 'Essay', rounds: 2 });
    expect(rep.bounties[1]).toMatchObject({ rounds: 1, pooledSd: 0 });
  });

  test('per-arbiter gap from the other arbiters in the same round', () => {
    const op = (n) => '0x' + String(n).repeat(40);
    const state = { rounds: {
      [id(1)]: { aggId: id(1), startTs: NOW - DAY, reveals: [
        reveal(0, 90, { operator: op(1) }), reveal(1, 92, { operator: op(2) }), reveal(2, 91, { operator: op(3) }), reveal(3, 40, { operator: op(4) })] },
      [id(2)]: { aggId: id(2), startTs: NOW - 2 * DAY, reveals: [
        reveal(0, 80, { operator: op(1) }), reveal(1, 82, { operator: op(2) }), reveal(2, 50, { operator: op(4) })] }
    } };
    const jobs = [{ jobId: 1, submissions: [
      { submissionId: 0, verdiktaAggId: id(1), submittedAt: NOW - DAY },
      { submissionId: 1, verdiktaAggId: id(2), submittedAt: NOW - 2 * DAY }] }];
    const rep = ss.buildReport(state, jobs, { days: 14, now: NOW });
    const low = rep.arbiters[0];
    expect(low.operator).toBe(op(4));
    expect(low.reveals).toBe(2);
    expect(low.meanGap).toBeCloseTo(((40 - 91) + (50 - 81)) / 2, 2); // -41
    expect(low.farFrac).toBe(1);
    expect(low.worst).toMatchObject({ jobId: 1, submissionId: 0, gap: -51 });
    const one = rep.arbiters.find((a) => a.operator === op(1));
    expect(one.reveals).toBe(2);
    expect(one.meanGap).toBeCloseTo(((90 - (92 + 91 + 40) / 3) + (80 - 66)) / 2, 2);
  });

  test('a longer window includes older rounds', () => {
    const { state, jobs } = fixture();
    const rep = ss.buildReport(state, jobs, { days: 30, now: NOW });
    expect(rep.samples).toHaveLength(4);
    expect(rep.daily).toHaveLength(30);
  });
});

describe('runCollection', () => {
  test('does not touch the RPC for rounds that are already settled', async () => {
    const { state } = fixture();
    state.rounds[id(8)] = { aggId: id(8), startTs: NOW - 40 * DAY, settled: true, reveals: [] };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spread-')), 'state.json');
    fs.writeFileSync(file, JSON.stringify(state));
    const boom = () => { throw new Error('unexpected RPC call'); };
    const provider = { getBlockNumber: boom, getBlock: boom, call: boom, getLogs: boom };
    const targets = [id(1), id(2), id(3), id(5)].map((a) => ({ aggId: a, ts: NOW - DAY }));
    targets.push({ aggId: '0x' + '0'.repeat(64), ts: NOW - DAY });
    const res = await ss.runCollection(targets, provider, '0x' + '44'.repeat(20), { file, now: NOW });
    expect(res).toEqual({ fetched: 0, failed: 0 });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(after.rounds)).not.toContain(id(8)); // aged out of the 30-day look-back
    expect(Object.keys(after.rounds)).toContain(id(4));
    expect(after.rounds[id(1)].reveals).toHaveLength(4);
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
