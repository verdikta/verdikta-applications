// The review focus: what the bridge sends the EA and the mock, against a stand-in EA and a stand-in
// v2 mock that keep the round's phases and record every call. The real EA and the real mock are the
// round's (test/round.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { keccak256, toBeHex } from 'ethers';

import { REAL_CONFIG, aggregate, commitmentOf, mPlusOf, pickPromoted, promoteSeedOf } from '../src/aggregatorRound.js';
import { createBridge, evaluateOver, readJobAnswer } from '../src/bridge.js';

const OPERATOR = '0x0000000000000000000000000000000000000001';
const WALLET = '0x00000000000000000000000000000000000000aa';
const BRIDGE = '0x00000000000000000000000000000000000000bb';
const AGG = toBeHex(1, 32);
const FEE = 120000000000000n;
const CEILING = 400000000000000n;
const CLASS = 133n;
const VECTOR = [0n, 0n, 0n, 0n, 700000n, 300000n];
const salt = (n) => n.toString(16).padStart(32, '0');
const CIDS = ['QmListing', 'QmClaim'];
const ADDENDUM = 'verdikta-disclosure: 0xaa 0xbb QmC 0xcc 0xdd';
const SEALED = keccak256('0x5eed');
const blockHashOf = (n) => keccak256(toBeHex(BigInt(n), 32));

/**
 * A stand-in for the v2 mock and its chain: the phases, the real escrow formula, the blocks and the
 * clock. `drawer` decides who draws: 'bridge' (nobody else does), 'requester' (the wallet, through
 * StakeAttestation, at B+2), or 'fail' (a pool shortage at the draw).
 */
function fakeMock({ cids = CIDS, addendum = ADDENDUM, requestedClass = CLASS, maxFee = FEE, minFee = 0n, drawer = 'bridge', keeperActs = false } = {}) {
  const sent = [];
  const eff = maxFee < CEILING ? maxFee : CEILING;
  const juror = minFee > eff ? minFee : eff;
  const cfg = { k: 6, m: 5, n: 4, p: 3, bonus: 3, draw: 2, promote: 1, timeout: 300, tPlus: 155, revealWindow: 120 };
  const state = { block: 7, now: 1000, events: [] };
  const r = { phase: 1, requestBlock: 7, closeBlock: 0, received: 0n, baseFees: 0n, bonuses: 0n, rewards: 0n, deadline: 0, windowEnd: 0, commits: 0, sealedHash: `0x${'00'.repeat(32)}` };
  const tick = () => { state.block += 1; state.now += 2; };
  const tx = (name, args, fn) => {
    sent.push({ name, args });
    tick();
    try {
      fn?.();
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve({ wait: async () => ({}) });
  };
  const required = () => juror * BigInt(cfg.k + cfg.bonus * cfg.p) + eff * BigInt(cfg.draw + cfg.promote);
  const draw = (who) => {
    if (r.phase !== 1) throw new Error('WrongPhase');
    if (state.block < r.requestBlock + 2) throw new Error('TooEarly');
    r.sealedHash = SEALED;
    if (drawer === 'fail') {
      r.phase = 8;
      return;
    }
    r.phase = 3;
    r.deadline = state.now + cfg.timeout;
    r.windowEnd = state.now + cfg.tPlus;
    r.baseFees = juror * BigInt(cfg.k);
    const reward = eff * BigInt(cfg.draw);
    r.rewards += reward;
    state.events.push({ args: [AGG, who, reward] });
  };
  const close = () => {
    r.phase = 4;
    r.closeBlock = state.block;
  };
  const mock = {
    sent,
    state,
    round: r,
    filters: { RequestAIEvaluation: () => 'requests', JuryDrawn: () => 'draws' },
    queryFilter: async (f) => (f === 'requests' ? [{ args: [AGG], blockNumber: 7 }] : state.events),
    getRequestCids: async () => cids,
    requestParams: async () => ({ addendum, maxFee, minFee, requestedClass, alpha: 500n, estimatedBaseCost: 1n, maxFeeBasedScaling: 3n, withBeacons: false }),
    maxOracleFee: async () => CEILING,
    requesterOf: async () => WALLET,
    getRoundInfo: async () => {
      // the requester's draw comes at B+2, and the keeper's T+ close and promote as soon as they are due
      if (drawer !== 'bridge' && r.phase === 1 && state.block >= r.requestBlock + 2) draw(WALLET);
      if (keeperActs && r.phase === 3 && state.now > r.windowEnd && r.commits >= cfg.m) close();
      if (keeperActs && r.phase === 4 && state.block >= r.closeBlock + 2) {
        r.phase = 5;
        r.rewards += eff;
      }
      return { ...r, received: r.received || (r.received = required()) };
    },
    setConfig: (...a) => tx('setConfig', a),
    setBonusMultiplier: (...a) => tx('setBonusMultiplier', a),
    setRewards: (...a) => tx('setRewards', a),
    setTimeouts: (...a) => tx('setTimeouts', a),
    drawJury: (id) => tx('drawJury', [id], () => draw(BRIDGE)),
    scriptCommits: (id, n) => tx('scriptCommits', [id, n], () => {
      if (r.phase !== 3) throw new Error('WrongPhase');
      r.commits += n;
      if (r.commits >= mPlusOf() || (state.now > r.windowEnd && r.commits >= cfg.m)) close();
    }),
    closeCommits: (id) => tx('closeCommits', [id], () => {
      if (r.phase !== 3 || state.now <= r.windowEnd || r.commits < cfg.m) throw new Error('WrongPhase');
      close();
    }),
    promote: (id) => tx('promote', [id], () => {
      if (r.phase !== 4) throw new Error('WrongPhase');
      if (state.block < r.closeBlock + 2) throw new Error('TooEarly');
      r.phase = 5;
      r.rewards += eff;
    }),
    scriptResult: (id, v, c) => tx('scriptResult', [id, v, c], () => {
      if (r.phase < 3 || r.phase > 5) throw new Error('WrongPhase');
      r.phase = 6;
      r.bonuses = juror * BigInt(cfg.bonus * cfg.p);
    }),
  };
  const chain = {
    mine: async () => { tick(); },
    now: async () => BigInt(state.now),
    blockNumber: async () => BigInt(state.block),
    blockHash: async (n) => blockHashOf(n),
    /** Moves the clock on, as chain.advance does. */
    advance: (s) => { state.now += s; },
  };
  return { mock, chain, eff, juror, required };
}

/** An EA that follows the v2 commit-reveal protocol: per job a 128-bit salt, a keccak commitment, a stored reveal. */
function honestEa(vectorOf = () => VECTOR) {
  const calls = [];
  const store = new Map();
  let n = 0;
  const evaluate = async (body) => {
    calls.push(body);
    const { cid, aggId } = body.data;
    if (cid.startsWith('1:')) {
      n += 1;
      const s = salt(n);
      const v = vectorOf(n);
      const hash = commitmentOf(aggId, OPERATOR, v, BigInt(`0x${s}`));
      store.set(hash, { s, v, n });
      return { status: 200, json: { status: 'success', data: { aggregatedScore: [BigInt(`0x${hash}`).toString()], justificationCid: '' } } };
    }
    const entry = store.get(cid.slice(2));
    if (!entry) return { status: 403, json: { status: 'errored', data: { aggregatedScore: [0] } } };
    return { status: 200, json: { status: 'success', data: { aggregatedScore: entry.v.map(Number), justificationCid: `QmUpload${entry.n}:${entry.s}` } } };
  };
  return { evaluate, calls };
}

const bridgeOf = (fake, evaluate, o = {}) => createBridge({ mock: fake.mock, chain: fake.chain, evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 2, drawAfterMs: 20, actAfterMs: 20, ...o });

async function serve(fake, evaluate, o) {
  const bridge = bridgeOf(fake, evaluate, o);
  await bridge.start(0);
  const record = await bridge.done(AGG);
  await bridge.quiet(AGG);
  await bridge.stop();
  return record;
}
const named = (fake, name) => fake.mock.sent.filter((s) => s.name === name);

test('the job\'s requests: K commits with the real cid string and the aggregator\'s hex id, then the M promote() draws, as "2:<64 hex>"', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  const record = await serve(fake, ea.evaluate);
  const commits = ea.calls.filter((c) => c.data.cid.startsWith('1:'));
  const reveals = ea.calls.filter((c) => c.data.cid.startsWith('2:'));
  assert.equal(commits.length, REAL_CONFIG.k);
  assert.equal(reveals.length, REAL_CONFIG.m);
  for (const c of commits) assert.equal(c.data.cid, `1:QmListing,QmClaim:${ADDENDUM}`);
  for (const c of [...commits, ...reveals]) {
    assert.equal(c.data.aggId, AGG);
    assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a job\'s external id is a UUID');
  }
  for (const c of reveals) assert.match(c.data.cid, /^2:[0-9a-f]{64}$/, 'the aggregator asks in 64 lowercase hex, not the commit\'s decimal');
  assert.equal(new Set(commits.map((c) => c.id)).size, REAL_CONFIG.k, 'one job per slot');
  // the slots the real promotion draw names: the seed from blockhash(C + 1)
  const chosen = pickPromoted(Array(6).fill(true), 5, promoteSeedOf(AGG, blockHashOf(fake.mock.round.closeBlock + 1)));
  assert.deepEqual(record.jobs.filter((j) => j.phase === 'reveal').map((j) => j.slot), chosen);
  assert.equal(record.status, 'fulfilled');
});

test('blocks keep coming: the bridge mines to B+2 and draws only once nobody else has', async () => {
  const fake = fakeMock();
  const record = await serve(fake, honestEa().evaluate);
  assert.equal(named(fake, 'drawJury').length, 1);
  assert.equal(record.drawnBy, BRIDGE);
  assert.equal(record.requesterDrawReward, 0n);

  const byRequester = fakeMock({ drawer: 'requester' });
  const r2 = await serve(byRequester, honestEa().evaluate);
  assert.equal(named(byRequester, 'drawJury').length, 0, 'the wallet drew it (StakeAttestation.drawJury)');
  assert.equal(r2.drawnBy, WALLET);
  assert.equal(r2.requesterDrawReward, byRequester.eff * 2n);
});

test('without an addendum there is no trailing colon', async () => {
  const ea = honestEa();
  await serve(fakeMock({ addendum: '' }), ea.evaluate);
  assert.equal(ea.calls[0].data.cid, '1:QmListing,QmClaim');
});

test('the mock gets each commit, and at the N-th reveal what the real contract would hold: the seeded cluster\'s floored mean, CIDs with no salt', async () => {
  const fake = fakeMock();
  const vectors = [VECTOR, [0n, 0n, 0n, 0n, 700001n, 299999n], [0n, 0n, 0n, 0n, 1000000n, 0n], VECTOR, VECTOR, [0n, 0n, 0n, 0n, 700002n, 299998n]];
  const record = await serve(fake, honestEa((n) => vectors[n - 1]).evaluate);
  assert.equal(named(fake, 'scriptCommits').length, REAL_CONFIG.k, 'one per commit; the M+-th closed it');
  const result = named(fake, 'scriptResult');
  assert.equal(result.length, 1);
  assert.equal(result[0].args[0], AGG);
  const counted = record.jobs.filter((j) => j.phase === 'reveal' && (j.outcome === 'reveal' || j.outcome === 'finalized'));
  assert.equal(counted.length, REAL_CONFIG.n);
  const expected = aggregate(counted.map((j) => j.scores), 3, REAL_CONFIG.spreadFloor, SEALED, counted.map((j) => j.slot));
  assert.deepEqual(result[0].args[1], expected.agg);
  assert.deepEqual(record.likelihoods, expected.agg);
  assert.equal(result[0].args[2].split(',').length, REAL_CONFIG.p);
  assert.doesNotMatch(result[0].args[2], /:/, 'the salt is stripped');
  // what the requester did not get back: the base fees, the bonuses, the bridge's draw and promote rewards
  assert.equal(record.spent, fake.juror * 6n + fake.juror * 9n + fake.eff * 3n);
  assert.equal(record.required, fake.required());
});

test('the result goes out at the N-th counted reveal: the jobs still out wait for nothing, and the fifth reveal is late', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  const held = [];
  const hold = (body) => new Promise((resolve) => { held.push(() => ea.evaluate(body).then(resolve)); });
  let reveals = 0;
  const evaluate = (body) => {
    if (body.data.cid.startsWith('1:')) return ea.evaluate(body);
    reveals += 1;
    return reveals <= REAL_CONFIG.n ? ea.evaluate(body) : hold(body);
  };
  const bridge = bridgeOf(fake, evaluate);
  await bridge.start(0);
  const record = await bridge.done(AGG);
  assert.equal(record.status, 'fulfilled');
  assert.equal(named(fake, 'scriptResult').length, 1, 'published with a job still out');
  assert.equal(record.quiet, false);
  assert.equal(held.length, REAL_CONFIG.m - REAL_CONFIG.n);
  held.forEach((go) => go());
  const quiet = await bridge.quiet(AGG);
  await bridge.stop();
  assert.equal(quiet.quiet, true);
  assert.equal(named(fake, 'scriptResult').length, 1, 'and only once');
  assert.equal(quiet.late, 1, 'a promoted slot\'s reveal after finalization: taken as late, never a revert');
  assert.deepEqual(quiet.reverted, []);
});

test('stopping does not wait for an EA that does not answer: every request still out is ended', async () => {
  const sockets = new Set();
  const server = http.createServer(() => { /* never answers */ });
  server.on('connection', (s) => { sockets.add(s); });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const evaluate = evaluateOver(`http://127.0.0.1:${server.address().port}`);
  const bridge = bridgeOf(fakeMock(), evaluate);
  await bridge.start(0);
  while (![...bridge.rounds.values()].some((r) => r.jobs.length === REAL_CONFIG.k)) await new Promise((r) => { setTimeout(r, 5); });
  await new Promise((r) => { setTimeout(r, 50); });
  const started = Date.now();
  const cut = await bridge.stop();
  assert.equal(cut, REAL_CONFIG.k);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  for (const s of sockets) s.destroy();
  server.close();
});

test('whoever waits on a round is told when the bridge stops: a stopping round must get its main flow back', async () => {
  const evaluate = () => new Promise(() => {});
  evaluate.cancelAll = () => 0;
  const bridge = bridgeOf(fakeMock(), evaluate);
  await bridge.start(0);
  const done = bridge.done(AGG);
  const quiet = bridge.quiet(`0x${'cd'.repeat(32)}`);
  const stopping = bridge.stop();
  await assert.rejects(done, /stopped/);
  await assert.rejects(quiet, /stopped/);
  await assert.rejects(bridge.done(AGG), /stopped/, 'and whoever asks afterwards');
  await Promise.race([stopping, new Promise((r) => { setTimeout(r, 200); })]);
});

test('a request found as the bridge stops starts nothing: not while it reads the request, not while it reads the chain', async () => {
  for (const hold of ['getRequestCids', 'queryFilter']) {
    const fake = fakeMock();
    let release;
    const gate = new Promise((r) => { release = r; });
    let reached = false;
    const real = fake.mock[hold];
    fake.mock[hold] = async (...args) => {
      reached = true;
      await gate;
      return real(...args);
    };
    let calls = 0;
    const evaluate = async () => {
      calls += 1;
      return new Promise(() => {}); // an EA that never answers: stopping could not wait for it
    };
    evaluate.cancelAll = () => 0;
    const bridge = bridgeOf(fake, evaluate);
    await bridge.start(0);
    while (!reached) await new Promise((r) => { setTimeout(r, 2); });
    const stopping = bridge.stop();
    release();
    await stopping;
    assert.equal(calls, 0, `held at ${hold}: no job went out`);
  }
});

test('a transaction that fails at the N-th reveal fails the bridge at once, with a job still out, and nothing is left unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const fake = fakeMock();
    fake.mock.scriptResult = () => Promise.reject(new Error('the node refused it'));
    const ea = honestEa();
    let reveals = 0;
    const evaluate = (body) => {
      if (body.data.cid.startsWith('2:')) {
        reveals += 1;
        if (reveals > REAL_CONFIG.n) return new Promise(() => {}); // the fifth reveal, out for good
      }
      return ea.evaluate(body);
    };
    const bridge = bridgeOf(fake, evaluate);
    await bridge.start(0);
    await assert.rejects(bridge.done(AGG), /the node refused it/);
    assert.match(bridge.failure().message, /the node refused it/);
    await new Promise((r) => { setTimeout(r, 20); });
    assert.deepEqual(unhandled, []);
    bridge.stop();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('the fee ceiling clamps as the real one does, and the floor raises what each juror is paid', async () => {
  const clamped = fakeMock({ maxFee: 10n ** 18n });
  const record = await serve(clamped, honestEa().evaluate);
  assert.equal(record.fee, CEILING);
  assert.equal(record.required, CEILING * 18n);
  const floored = fakeMock({ minFee: FEE * 2n });
  const r2 = await serve(floored, honestEa().evaluate);
  assert.equal(r2.juror, FEE * 2n);
  assert.equal(r2.spent, FEE * 2n * 15n + FEE * 3n);
});

test('the mock is set to the real contract\'s K, M, N, P, bonus, rewards and timeouts', async () => {
  const fake = fakeMock();
  await serve(fake, honestEa().evaluate);
  assert.deepEqual(named(fake, 'setConfig')[0].args, [6, 5, 4, 3]);
  assert.deepEqual(named(fake, 'setBonusMultiplier')[0].args, [3]);
  assert.deepEqual(named(fake, 'setRewards')[0].args, [2, 1]);
  assert.deepEqual(named(fake, 'setTimeouts')[0].args, [300, 155, 120]);
  const longer = fakeMock();
  await serve(longer, honestEa().evaluate, { config: { ...REAL_CONFIG, responseTimeoutSeconds: 900 } });
  assert.deepEqual(named(longer, 'setTimeouts')[0].args, [900, 155, 120]);
});

test('an EA that abstains on every job: no commit, no result, and the round stays open at the mock until its deadline', async () => {
  const fake = fakeMock();
  const record = await serve(fake, async () => ({ status: 500, json: { status: 'errored', error: 'abstain', data: { aggregatedScore: [0] } } }));
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.abstained, REAL_CONFIG.k);
  assert.equal(record.commits, 0);
  assert.equal(named(fake, 'scriptCommits').length, 0);
  assert.equal(named(fake, 'scriptResult').length, 0, 'an abstention is never a result');
  assert.equal(fake.mock.round.phase, 3);
  assert.equal(record.spent, fake.juror * 6n + fake.eff * 2n, 'the base fees and the bridge\'s draw reward');
});

test('a 200 with [0] is a zero commit, which the real contract ignores: no reveal, no result', async () => {
  const fake = fakeMock();
  const record = await serve(fake, async () => ({ status: 200, json: { data: { aggregatedScore: [0], justificationCid: '' } } }));
  assert.equal(record.status, 'no-verdict');
  assert.deepEqual(record.ignored.map((i) => i.reason), Array(6).fill('zero commit'));
  assert.equal(named(fake, 'scriptResult').length, 0);
});

test('fewer than M commits: the window never closes, no reveal goes out', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  let n = 0;
  const record = await serve(fake, async (body) => {
    n += 1;
    return n <= REAL_CONFIG.m - 1 ? ea.evaluate(body) : { status: 503, json: null };
  });
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.commits, REAL_CONFIG.m - 1);
  assert.equal(named(fake, 'closeCommits').length, 0);
  assert.equal(ea.calls.filter((c) => c.data.cid.startsWith('2:')).length, 0);
});

test('M commits but not M+, all before T+: after T+ the keeper closes and promotes, or the bridge does', async () => {
  for (const keeperActs of [true, false]) {
    const fake = fakeMock({ keeperActs });
    const ea = honestEa();
    let n = 0;
    let answered = 0;
    const evaluate = async (body) => {
      if (body.data.cid.startsWith('1:')) {
        n += 1;
        if (n === REAL_CONFIG.k) {
          // the sixth job abstains once the other five are in, and the clock passes T+ (155 s)
          while (answered < REAL_CONFIG.m) await new Promise((r) => { setTimeout(r, 2); });
          await new Promise((r) => { setTimeout(r, 20); });
          fake.chain.advance(200);
          return { status: 503, json: null };
        }
        const a = await ea.evaluate(body);
        answered += 1;
        return a;
      }
      return ea.evaluate(body);
    };
    const record = await serve(fake, evaluate);
    assert.equal(record.status, 'fulfilled', `keeper ${keeperActs}`);
    assert.equal(record.commits, REAL_CONFIG.m);
    assert.equal(named(fake, 'closeCommits').length, keeperActs ? 0 : 1);
    assert.equal(named(fake, 'promote').length, keeperActs ? 0 : 1);
    assert.equal(record.closedBy, keeperActs ? null : 'bridge');
  }
});

test('after T+, the M-th commit closes the window at once (at the mock too), and promote follows', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  let n = 0;
  const record = await serve(fake, async (body) => {
    if (body.data.cid.startsWith('1:')) {
      n += 1;
      if (n === 1) fake.chain.advance(200);
      if (n === REAL_CONFIG.k) return { status: 503, json: null };
    }
    return ea.evaluate(body);
  });
  assert.equal(record.status, 'fulfilled');
  assert.equal(named(fake, 'closeCommits').length, 0);
  assert.equal(named(fake, 'scriptCommits').length, REAL_CONFIG.m);
});

test('a reveal after the deadline is not taken: no result', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  const record = await serve(fake, async (body) => {
    if (body.data.cid.startsWith('2:')) fake.chain.advance(400);
    return ea.evaluate(body);
  });
  assert.equal(record.status, 'no-verdict');
  assert.ok(record.ignored.some((i) => i.reason === 'past the deadline'));
});

test('reveals that do not open their commitments leave fewer than N: no result', async () => {
  const fake = fakeMock();
  const ea = honestEa();
  const record = await serve(fake, async (body) => {
    const answer = await ea.evaluate(body);
    if (body.data.cid.startsWith('2:')) answer.json.data.aggregatedScore = [0, 0, 0, 0, 1000000, 0];
    return answer;
  });
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.ignored.filter((i) => i.reason === 'hash mismatch').length, REAL_CONFIG.m);
  assert.equal(named(fake, 'scriptResult').length, 0);
});

test('a round that failed at the draw (a pool shortage) sends no job', async () => {
  const fake = fakeMock({ drawer: 'fail' });
  const ea = honestEa();
  const record = await serve(fake, ea.evaluate);
  assert.equal(record.status, 'no-verdict');
  assert.equal(ea.calls.length, 0);
});

test('a request on a class no job is registered for fails the bridge, loudly: the real keeper would find no juror', async () => {
  const bridge = bridgeOf(fakeMock({ requestedClass: 128n }), honestEa().evaluate);
  await bridge.start(0);
  await assert.rejects(bridge.done(AGG), /class 128/);
  await bridge.stop();
  assert.match(bridge.failure().message, /class 128/);
});

test('a reveal job keeps what it answered, and the round keeps what the request asked of the oracles', async () => {
  const record = await serve(fakeMock(), honestEa().evaluate);
  const reveals = record.jobs.filter((j) => j.phase === 'reveal');
  assert.equal(reveals.length, REAL_CONFIG.m);
  for (const j of reveals) assert.deepEqual(j.scores, VECTOR);
  assert.ok(record.jobs.filter((j) => j.phase === 'commit').every((j) => j.scores === null));
  assert.deepEqual(record.oracle, { alpha: 500n, maxFee: FEE, minFee: 0n, estimatedBaseCost: 1n, maxFeeBasedScaling: 3n, withBeacons: false });
});

test('the job reads only data.aggregatedScore and data.justificationCid, and what it cannot encode ends it with no transaction', () => {
  assert.equal(readJobAnswer({ status: 500, json: { data: { aggregatedScore: [1], justificationCid: '' } } }), null);
  assert.equal(readJobAnswer({ status: 200, json: null }), null);
  assert.equal(readJobAnswer({ status: 200, json: { data: { justificationCid: '' } } }), null);
  assert.equal(readJobAnswer({ status: 200, json: { data: { aggregatedScore: [1] } } }), null);
  assert.equal(readJobAnswer({ status: 200, json: { data: { aggregatedScore: [-1], justificationCid: '' } } }), null);
  assert.equal(readJobAnswer({ status: 200, json: { data: { aggregatedScore: [1.5], justificationCid: '' } } }), null);
  assert.equal(readJobAnswer({ status: 200, json: { data: { aggregatedScore: [(1n << 256n).toString()], justificationCid: '' } } }), null);
  assert.deepEqual(readJobAnswer({ status: 200, json: { data: { aggregatedScore: ['340282366920938463463374607431768211455'], justificationCid: '' } } }), { response: [340282366920938463463374607431768211455n], cid: '' });
});
