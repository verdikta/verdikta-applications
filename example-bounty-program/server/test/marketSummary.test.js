/**
 * GET /api/market-summary: aggregates only, public, cached, documented everywhere agents look.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', networkName: 'Base Sepolia', chainId: 84532, bountyEscrowAddress: '0x' + '11'.repeat(20) } }));
jest.mock('../utils/jobStorage', () => ({ listJobs: jest.fn(async () => []) }));

const express = require('express');
const request = require('supertest');
const jobStorage = require('../utils/jobStorage');
const logger = require('../utils/logger');
const clientIdentification = require('../middleware/clientIdentification');
const ms = require('../utils/marketSummary');

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00Z
const nowSec = NOW / 1000;
const H = 3600;
const HUNTER_A = '0x' + 'aa'.repeat(20);
const HUNTER_B = '0x' + 'bb'.repeat(20);
const TITLE = 'Confidential-looking title ZZTOP';
const DESC = 'Secret task text QQQ';
const WORK_ORDER = (service) => `${DESC}\n\nApproved work-order draft SHA-256: ${'a'.repeat(64)}\nService: ${service}\nRequest bytes SHA-256 (result.input_sha256): ${'b'.repeat(64)}\nRequest (exact UTF-8 JSON bytes, no trailing newline):\n{}`;

const job = (over) => ({ jobId: 1, title: TITLE, description: DESC, status: 'OPEN', createdAt: nowSec - 2 * H, submissionOpenTime: nowSec - 2 * H,
  submissionCloseTime: nowSec + 24 * H, bountyAmountWei: '8000000000000000', submissions: [], ...over });
const sub = (over) => ({ hunter: HUNTER_A, submittedAt: nowSec - H, ethMaxBudget: '240000000000000', ...over });
const awarded = (id, amount, openedAgoH, awardedAgoH, service, extra = {}) => job({
  jobId: id, status: 'AWARDED', description: service ? WORK_ORDER(service) : DESC, bountyAmountWei: amount,
  createdAt: nowSec - openedAgoH * H, submissionOpenTime: nowSec - openedAgoH * H,
  submissions: [sub({ paidWinner: true, status: 'APPROVED', submittedAt: nowSec - awardedAgoH * H - 60, finalizedAt: nowSec - awardedAgoH * H }), ...(extra.submissions || [])] });

beforeEach(() => { ms.resetMarketSummaryCache(); jobStorage.listJobs.mockReset(); jobStorage.listJobs.mockResolvedValue([]); jest.spyOn(logger, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('classifyService', () => {
  test('needs all three lines the onboarding composer writes', () => {
    expect(ms.classifyService(WORK_ORDER('source-check-v1'))).toBe('source-check-v1');
    expect(ms.classifyService(WORK_ORDER('evidence-pack-v1'))).toBe('evidence-pack-v1');
    expect(ms.classifyService(WORK_ORDER('review-v1'))).toBe('review-v1');
    expect(ms.classifyService(WORK_ORDER('real-world-task-v1'))).toBe('real-world-task-v1');
    expect(ms.classifyService('Service: source-check-v1')).toBe('unclassified');
    expect(ms.classifyService(WORK_ORDER('source-check-v1').replace(/^Approved.*\n/m, ''))).toBe('unclassified');
    expect(ms.classifyService(WORK_ORDER('source-check-v1').replace(/^Request bytes.*\n/m, ''))).toBe('unclassified');
    expect(ms.classifyService(WORK_ORDER('made-up-v9'))).toBe('unclassified');
    expect(ms.classifyService(undefined)).toBe('unclassified');
    expect(ms.classifyService(null)).toBe('unclassified');
  });
});

describe('quartiles', () => {
  test('withholds a block with fewer than three samples', () => {
    expect(ms.quartiles([5n, 9n], { asString: true })).toEqual({ n: 2, median: null, p25: null, p75: null, suppressed_below_n: 3 });
    expect(ms.quartiles([], { asString: false }).median).toBeNull();
  });
  test('interpolates exactly with BigInt and plain integers', () => {
    expect(ms.quartiles([10n, 20n, 30n], { asString: true })).toEqual({ n: 3, median: '20', p25: '15', p75: '25' });
    // interpolated values are rounded down to whole wei: p25 of [1,2,3] is 1.5
    expect(ms.quartiles([1n, 2n, 3n], { asString: true })).toEqual({ n: 3, median: '2', p25: '1', p75: '2' });
    expect(ms.quartiles([40n, 10n, 20n, 30n], { asString: true })).toEqual({ n: 4, median: '25', p25: '17', p75: '32' });
    expect(ms.quartiles([300, 100, 200], { asString: false })).toEqual({ n: 3, median: 200, p25: 150, p75: 250 });
  });
  test('keeps wei values beyond Number precision', () => {
    const big = 10n ** 24n;
    expect(ms.quartiles([big, big * 2n, big * 3n], { asString: true }).median).toBe((big * 2n).toString());
  });
});

describe('buildMarketSummary', () => {
  const jobs = [
    job({ jobId: 1, description: WORK_ORDER('source-check-v1'), bountyAmountWei: '8000000000000000', submissions: [sub(), sub({ hunter: HUNTER_B, ethMaxBudget: '260000000000000' })] }),
    job({ jobId: 2, description: WORK_ORDER('source-check-v1'), bountyAmountWei: '10000000000000000' }),
    awarded(3, '6000000000000000', 10, 2, 'source-check-v1'),
    awarded(4, '12000000000000000', 20, 5, 'source-check-v1'),
    awarded(5, '1000000000000000', 6, 1, null),
    // awarded long ago: outside the window
    awarded(6, '99000000000000000', 900, 800, 'source-check-v1'),
    job({ jobId: 7, status: 'CLOSED', submissionCloseTime: nowSec - 3 * H, description: WORK_ORDER('evidence-pack-v1'), bountyAmountWei: '2000000000000000' }),
    job({ jobId: 8, status: 'EXPIRED', submissionCloseTime: nowSec - 900 * H * 24, bountyAmountWei: '3000000000000000' }),
    job({ jobId: 9, status: 'ORPHANED', bountyAmountWei: '77000000000000000' }),
    job({ jobId: 10, status: 'cancelled', bountyAmountWei: '88000000000000000' }),
  ];
  const summary = ms.buildMarketSummary(jobs, { now: NOW, windowDays: 30, network: { name: 'base-sepolia', chain_id: 84532 } });

  test('states its scope, network, window and that it is not a quote', () => {
    expect(summary.not_a_quote).toBe(true);
    expect(summary.schema_version).toBe('1.0.0');
    expect(summary.generated_at).toBe('2026-10-01T12:00:00.000Z');
    expect(summary.network).toEqual({ name: 'base-sepolia', chain_id: 84532 });
    expect(summary.window).toMatchObject({ days: 30, to: '2026-10-01T12:00:00.000Z' });
    expect(summary.window.from).toBe('2026-09-01T12:00:00.000Z');
    expect(summary.disclaimer).toMatch(/Not a quote/);
  });

  test('counts open, awarded and closed per service, and ignores orphaned, cancelled and out-of-window jobs', () => {
    const sc = summary.by_service['source-check-v1'];
    expect([sc.open, sc.awarded, sc.closed_unawarded]).toEqual([2, 2, 0]);
    expect(summary.by_service['evidence-pack-v1']).toMatchObject({ open: 0, awarded: 0, closed_unawarded: 1 });
    expect(summary.by_service.unclassified).toMatchObject({ open: 0, awarded: 1, closed_unawarded: 0 });
    expect(summary.all).toMatchObject({ open: 2, awarded: 3, closed_unawarded: 1, sample_size: 6 });
  });

  test('uses the funded amount and withholds thin samples', () => {
    const sc = summary.by_service['source-check-v1'];
    // open 8 and 10 finney, awarded 6 and 12 finney
    expect(sc.bounty_amount_wei).toEqual({ n: 4, median: '9000000000000000', p25: '7500000000000000', p75: '10500000000000000' });
    expect(summary.by_service['evidence-pack-v1'].bounty_amount_wei.median).toBeNull();
    expect(summary.by_service.unclassified.bounty_amount_wei.suppressed_below_n).toBe(3);
  });

  test('time to award runs from open time to the winning finalization', () => {
    // job 3: opened 10h ago, awarded 2h ago = 8h; job 4: 20h ago to 5h ago = 15h; both source-check
    expect(summary.by_service['source-check-v1'].time_to_award_seconds.n).toBe(2);
    expect(summary.all.time_to_award_seconds.n).toBe(3);
    expect(summary.all.time_to_award_seconds.median).toBe(8 * H);
  });

  test('counts distinct active hunters and worst-case prepay without publishing addresses', () => {
    expect(summary.hunters.active_in_window).toBe(2); // HUNTER_A and HUNTER_B, case-insensitively unique
    expect(summary.all.oracle_prepay_wei.n).toBe(5);
    expect(summary.all.oracle_prepay_wei.median).toBe('240000000000000');
  });

  test('contains no addresses, titles or task text anywhere', () => {
    const text = JSON.stringify(summary);
    for (const needle of [HUNTER_A, HUNTER_B, HUNTER_A.toLowerCase(), TITLE, 'ZZTOP', DESC, 'QQQ', 'a'.repeat(64)]) expect(text).not.toContain(needle);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  test('is well-formed for an empty board', () => {
    const empty = ms.buildMarketSummary([], { now: NOW });
    expect(empty.all).toMatchObject({ open: 0, awarded: 0, closed_unawarded: 0, sample_size: 0 });
    expect(empty.hunters.active_in_window).toBe(0);
    expect(Object.keys(empty.by_service)).toEqual(['source-check-v1', 'evidence-pack-v1', 'review-v1', 'real-world-task-v1', 'unclassified']);
  });
});

describe('cache', () => {
  test('serves from cache until the ttl, then recomputes', async () => {
    let t = 1000; const now = () => t; const compute = jest.fn(async () => ({ n: compute.mock.calls.length }));
    expect(await ms.getMarketSummary(compute, { ttlSeconds: 300, now })).toEqual({ n: 1 });
    t += 299 * 1000; expect(await ms.getMarketSummary(compute, { ttlSeconds: 300, now })).toEqual({ n: 1 });
    t += 2 * 1000; expect(await ms.getMarketSummary(compute, { ttlSeconds: 300, now })).toEqual({ n: 2 });
  });
  test('concurrent callers share one computation', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const compute = jest.fn(async () => { await gate; return { ok: true }; });
    const calls = [ms.getMarketSummary(compute), ms.getMarketSummary(compute), ms.getMarketSummary(compute)];
    release(); await Promise.all(calls);
    expect(compute).toHaveBeenCalledTimes(1);
  });
  test('serves the previous summary if a refresh fails, and errors only when there is none', async () => {
    let t = 0; const now = () => t;
    await expect(ms.getMarketSummary(async () => { throw new Error('boom'); }, { ttlSeconds: 1, now })).rejects.toThrow('boom');
    await ms.getMarketSummary(async () => ({ v: 1 }), { ttlSeconds: 1, now });
    t += 5000;
    expect(await ms.getMarketSummary(async () => { throw new Error('boom'); }, { ttlSeconds: 1, now })).toEqual({ v: 1 });
  });
  test('window comes from the environment, bounded, default 30', () => {
    expect(ms.windowDaysFromEnv({})).toBe(30);
    expect(ms.windowDaysFromEnv({ MARKET_SUMMARY_WINDOW_DAYS: '7' })).toBe(7);
    expect(ms.windowDaysFromEnv({ MARKET_SUMMARY_WINDOW_DAYS: '0' })).toBe(30);
    expect(ms.windowDaysFromEnv({ MARKET_SUMMARY_WINDOW_DAYS: '9999' })).toBe(30);
    expect(ms.windowDaysFromEnv({ MARKET_SUMMARY_WINDOW_DAYS: 'x' })).toBe(30);
  });
});

describe('route', () => {
  // Same order as server.js: the global auth middleware runs before the agent routes.
  const app = express();
  app.use(clientIdentification);
  app.use(require('../routes/agentRoutes'));

  test('answers unauthenticated GETs through the real auth middleware, cached and labelled', async () => {
    jobStorage.listJobs.mockResolvedValue([job({ jobId: 1, description: WORK_ORDER('source-check-v1') })]);
    const res = await request(app).get('/api/market-summary');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.not_a_quote).toBe(true);
    expect(res.body.network).toEqual({ name: 'Base Sepolia', chain_id: 84532 });
    expect(res.body.by_service['source-check-v1'].open).toBe(1);
    expect(jobStorage.listJobs).toHaveBeenCalledWith({ includeOrphans: false });
  });

  test('ignores query parameters and stays cached across requests', async () => {
    await request(app).get('/api/market-summary');
    await request(app).get('/api/market-summary?window_days=1&creator=0x1');
    expect(jobStorage.listJobs).toHaveBeenCalledTimes(1);
  });

  test('the middleware is really active: an unlisted API path is still refused', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
  });

  test('a storage failure is a 500 with a fallback hint, not a stack trace', async () => {
    jobStorage.listJobs.mockRejectedValue(new Error('disk on fire'));
    const res = await request(app).get('/api/market-summary');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/disk on fire/);
    expect(res.body.error).toMatch(/jobs\.txt/);
  });

  test.each(['/agents.txt', '/llms.txt', '/api/jobs.txt', '/robots.txt'])('%s points agents at it', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/api/market-summary');
  });

  test('/api/docs lists the endpoint and the feed', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.find(e => e.path === '/market-summary')).toMatchObject({ method: 'GET' });
    expect(res.body.feeds.marketSummary).toBe('/api/market-summary');
  });
});
