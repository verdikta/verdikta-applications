/**
 * The round keeper (utils/roundKeeper.js): sends the step the escrow lens's nextAction names, after
 * simulating it, to the right contract; never resends while a tx may be in flight; leaves finalize to
 * others; withdraws its own rewards. Contracts are stubs.
 */
const { RoundKeeper, IN_FLIGHT_MS } = require('../utils/roundKeeper');
const classPresets = require('../../shared/classPresets');

const quiet = { info() {}, warn() {}, debug() {} };
const AGG_ID = '0x' + '00'.repeat(31) + '07';

function stubContract(name, calls, { failEstimate = false } = {}) {
  const fn = (method) => {
    const f = async (...args) => { calls.push({ name, method, args: args.slice(0, -1), opts: args[args.length - 1] }); return { hash: `0x${name}-${method}` }; };
    f.estimateGas = async () => { if (failEstimate) throw new Error('execution reverted: TooEarly'); return 100_000n; };
    return f;
  };
  return new Proxy({}, { get: (_, prop) => (prop === 'then' ? undefined : prop === 'connect' ? () => stubContract(name, calls, { failEstimate }) : fn(prop)) });
}

function makeKeeper({ failEstimate = false, owed = 0n } = {}) {
  const calls = [];
  let t = 1_000_000;
  const escrow = stubContract('escrow', calls, { failEstimate });
  const agg = stubContract('aggregator', calls, { failEstimate });
  agg.ethOwed = async () => owed;
  const cs = {
    contract: escrow,
    provider: { getBalance: async () => 10n ** 18n },
    getAggregatorFor: async () => agg,
    getAggregators: async () => ['0xagg'],
    getAggregatorAt: () => ({ ethOwed: async () => owed, connect: () => ({ withdrawEth: async () => { calls.push({ name: 'aggregator', method: 'withdrawEth' }); return { hash: '0xw' }; } }) })
  };
  const keeper = new RoundKeeper({ contractService: cs, signer: { getAddress: async () => '0xkeeper' }, logger: quiet, now: () => t });
  return { keeper, calls, advance: (ms) => { t += ms; } };
}

describe('RoundKeeper', () => {
  test('DRAW, CLOSE_FAILED and EXPIRE_RERUN go to the escrow with (bountyId, submissionId)', async () => {
    for (const action of ['DRAW', 'CLOSE_FAILED', 'EXPIRE_RERUN']) {
      const { keeper, calls } = makeKeeper();
      const r = await keeper.tend(5, 2, { nextAction: action, aggId: AGG_ID });
      expect(r.sent).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('escrow');
      expect(calls[0].args).toEqual([5, 2]);
      expect(calls[0].opts.gasLimit).toBe(125_000n);   // estimate + 25%
    }
  });

  test('CLOSE_COMMITS and PROMOTE go to the bounty\'s aggregator with the round id', async () => {
    for (const [action, method] of [['CLOSE_COMMITS', 'closeCommits'], ['PROMOTE', 'promote']]) {
      const { keeper, calls } = makeKeeper();
      await keeper.tend(5, 2, { nextAction: action, aggId: AGG_ID });
      expect(calls[0]).toMatchObject({ name: 'aggregator', method, args: [AGG_ID] });
    }
  });

  test('leaves FINALIZE, waits and resolved states alone', async () => {
    const { keeper, calls } = makeKeeper();
    for (const action of ['FINALIZE', 'AWAIT_ORACLE', 'AWAIT_EARLIER', 'RERUN', 'DONE', undefined]) {
      expect((await keeper.tend(1, 0, { nextAction: action })).sent).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('does not send a step whose simulation fails', async () => {
    const { keeper, calls } = makeKeeper({ failEstimate: true });
    const r = await keeper.tend(1, 0, { nextAction: 'DRAW', aggId: AGG_ID });
    expect(r).toMatchObject({ sent: false, reason: 'simulation_failed' });
    expect(calls).toHaveLength(0);
  });

  test('does not resend the same step while it may be in flight, then retries', async () => {
    const { keeper, calls, advance } = makeKeeper();
    await keeper.tend(1, 0, { nextAction: 'PROMOTE', aggId: AGG_ID });
    expect((await keeper.tend(1, 0, { nextAction: 'PROMOTE', aggId: AGG_ID })).reason).toBe('in_flight');
    advance(IN_FLIGHT_MS + 1);
    keeper.prune();
    expect((await keeper.tend(1, 0, { nextAction: 'PROMOTE', aggId: AGG_ID })).sent).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('withdraws its own rewards from aggregators that owe it', async () => {
    const owing = makeKeeper({ owed: 5n });
    expect(await owing.keeper.withdrawRewards()).toHaveLength(1);
    const none = makeKeeper({ owed: 0n });
    expect(await none.keeper.withdrawRewards()).toHaveLength(0);
  });
});

describe('shared/classPresets', () => {
  test('presets follow item 15: R <= Q <= N, Jumbo alone has beacons, offers ascend', () => {
    let last = -1;
    for (const c of classPresets.CLASS_PRESETS) {
      expect(c.forfeitLine).toBeLessThanOrEqual(c.quota);
      expect(c.quota).toBeLessThanOrEqual(c.N);
      expect(c.withBeacons).toBe(c.key === 'jumbo');
      expect(c.offeredUpToUsd).toBeGreaterThan(last);
      last = c.offeredUpToUsd;
    }
  });

  test('presetForBounty picks the smallest class offered for the amount', () => {
    expect(classPresets.presetForBounty(20).key).toBe('bondless-small');
    expect(classPresets.presetForBounty(100).key).toBe('small');
    expect(classPresets.presetForBounty(500).key).toBe('medium');
    expect(classPresets.presetForBounty(5000).key).toBe('large');
    expect(classPresets.presetForBounty(1e6).key).toBe('jumbo');
  });

  test('toBountyParams converts USD at the given price and takes overrides', () => {
    const p = classPresets.toBountyParams('medium', 2500);
    expect(p).toMatchObject({ jury: 1, quota: 3, forfeitLine: 2, withBeacons: false });
    expect(p.bond).toBe((10n ** 18n / 50n).toString());           // $50 at $2,500 = 0.02 ETH
    expect(p.minOracleFee).toBe((10n ** 14n).toString());          // $0.25 at $2,500 = 0.0001 ETH
    expect(classPresets.toBountyParams('medium', 2500, { bond: 0n }).bond).toBe('0');
    expect(() => classPresets.toBountyParams('nope', 2500)).toThrow(/unknown bounty class/);
    expect(() => classPresets.usdToWei(1, 0)).toThrow(/ethUsd/);
  });

  test('minAttemptCostWei is K x floor, plus 2 beacon values for Jumbo', () => {
    expect(classPresets.minAttemptCostWei('medium', 10n)).toBe(80n);
    expect(classPresets.minAttemptCostWei('jumbo', 10n)).toBe(520n);
  });
});

describe('GET /api/classes/presets', () => {
  jest.doMock('../utils/ethPrice', () => ({ getEthPriceUsd: async () => ({ usd: 2500 }) }));
  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(require('../routes/classRoutes'));

  test('lists the presets with wei values and suggests a class for ?usd=', async () => {
    const res = await request(app).get('/api/classes/presets?usd=500');
    expect(res.status).toBe(200);
    expect(res.body.classes.map((c) => c.key)).toEqual(classPresets.CLASS_PRESETS.map((c) => c.key));
    expect(res.body.suggested).toBe('medium');
    expect(res.body.classes.find((c) => c.key === 'medium').wei.bond).toBe((10n ** 18n / 50n).toString());
    expect(res.body).toMatchObject({ maxRounds: 6, rerunWindowSeconds: 7200, ethUsd: 2500 });
  });
});
