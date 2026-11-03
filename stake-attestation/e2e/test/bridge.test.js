// The review focus: what the bridge sends the EA and the mock, against a stand-in EA and a stand-in
// mock that record it. The real EA and the real mock are the round's (test/round.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { REAL_CONFIG, revealHashOf } from '../src/aggregatorRound.js';
import { createBridge, evaluateOver, readJobAnswer } from '../src/bridge.js';

const OPERATOR = '0x0000000000000000000000000000000000000001';
const AGG = `0x${'ab'.repeat(32)}`;
const FEE = 120000000000000n;
const CLASS = 133n;
const VECTOR = [0n, 0n, 0n, 0n, 700000n, 300000n];
const salt = (n) => n.toString(16).padStart(20, '0');
const CIDS = ['QmListing', 'QmClaim'];
const ADDENDUM = 'verdikta-disclosure: 0xaa 0xbb QmC 0xcc 0xdd';

function fakeMock({ cids = CIDS, addendum = ADDENDUM, requestedClass = CLASS, maxFee = FEE } = {}) {
  const sent = [];
  const tx = (name, ...args) => {
    sent.push({ name, args });
    return Promise.resolve({ wait: async () => ({}) });
  };
  return {
    sent,
    filters: { RequestAIEvaluation: () => 'filter' },
    queryFilter: async () => [{ args: [AGG], blockNumber: 7 }],
    getRequestCids: async () => cids,
    requestParams: async () => ({ addendum, maxFee, requestedClass, alpha: 500n, estimatedBaseCost: 1n, maxFeeBasedScaling: 3n }),
    maxOracleFee: async () => 400000000000000n,
    setFeeMultiplier: (m) => tx('setFeeMultiplier', m),
    setRefundAmount: (a) => tx('setRefundAmount', a),
    scriptResult: (id, v, c) => tx('scriptResult', id, v, c),
  };
}

/** An EA that follows the commit-reveal protocol: per slot a salt, a commitment, a stored reveal. */
function honestEa(vectorOf = () => VECTOR) {
  const calls = [];
  const store = new Map();
  let n = 0;
  const evaluate = async (body) => {
    calls.push(body);
    const { cid } = body.data;
    if (cid.startsWith('1:')) {
      n += 1;
      const s = salt(n);
      const v = vectorOf(n);
      const hash = revealHashOf(OPERATOR, v, BigInt(`0x${s}`));
      store.set(hash, { s, v, n });
      return { status: 200, json: { status: 'success', data: { aggregatedScore: [BigInt(`0x${hash}`).toString()], justificationCid: '' } } };
    }
    const entry = store.get(cid.slice(2));
    if (!entry) return { status: 500, json: { status: 'errored', data: { aggregatedScore: [0] } } };
    return { status: 200, json: { status: 'success', data: { aggregatedScore: entry.v.map(Number), justificationCid: `QmUpload${entry.n}:${entry.s}` } } };
  };
  return { evaluate, calls };
}

async function serve(mock, evaluate) {
  const bridge = createBridge({ mock, evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
  await bridge.start(0);
  const record = await bridge.done(AGG);
  await bridge.stop();
  return record;
}

test('the job\'s request: K commits with the real cid string and the aggregator\'s hex id, then the first M reveals', async () => {
  const mock = fakeMock();
  const ea = honestEa();
  const record = await serve(mock, ea.evaluate);
  const commits = ea.calls.filter((c) => c.data.cid.startsWith('1:'));
  const reveals = ea.calls.filter((c) => c.data.cid.startsWith('2:'));
  assert.equal(commits.length, REAL_CONFIG.k);
  assert.equal(reveals.length, REAL_CONFIG.m);
  for (const c of commits) assert.equal(c.data.cid, `1:QmListing,QmClaim:${ADDENDUM}`);
  for (const c of [...commits, ...reveals]) {
    assert.equal(c.data.aggId, AGG);
    assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a job\'s external id is a UUID');
  }
  for (const c of reveals) assert.match(c.data.cid, /^2:[0-9a-f]{32}$/, 'the aggregator asks in lowercase hex, not the commit\'s decimal');
  assert.equal(new Set(commits.map((c) => c.id)).size, REAL_CONFIG.k, 'one job per slot');
  assert.equal(record.status, 'fulfilled');
});

test('without an addendum there is no trailing colon', async () => {
  const ea = honestEa();
  await serve(fakeMock({ addendum: '' }), ea.evaluate);
  assert.equal(ea.calls[0].data.cid, '1:QmListing,QmClaim');
});

test('the mock gets what the real contract would hold: the floored mean of the cluster, CIDs comma-joined with no salt, and the real spend', async () => {
  const mock = fakeMock();
  const record = await serve(mock, honestEa().evaluate);
  assert.deepEqual(record.likelihoods, VECTOR);
  const result = mock.sent.filter((s) => s.name === 'scriptResult');
  assert.equal(result.length, 1);
  assert.equal(result[0].args[0], AGG);
  assert.deepEqual(result[0].args[1], VECTOR);
  assert.equal(result[0].args[2].split(',').length, REAL_CONFIG.p);
  assert.doesNotMatch(result[0].args[2], /:/, 'the salt is stripped');
  // set before the result: the worst case is all spent when every fee is at the ceiling
  const refunds = mock.sent.filter((s) => s.name === 'setRefundAmount').map((s) => s.args[0]);
  assert.deepEqual(refunds, [FEE * 6n, 0n], 'first what a timed-out round spends (the base fees), then what this one spent');
  assert.equal(record.spent, FEE * 12n);
});

test('the result goes out at the N-th reveal, as the real contract finalizes inside it: the jobs still out wait for nothing', async () => {
  const mock = fakeMock();
  const ea = honestEa();
  const held = [];
  const hold = (body) => new Promise((resolve) => { held.push(() => ea.evaluate(body).then(resolve)); });
  let commits = 0;
  let reveals = 0;
  const evaluate = (body) => {
    if (body.data.cid.startsWith('1:')) {
      commits += 1;
      return commits <= REAL_CONFIG.m ? ea.evaluate(body) : hold(body);
    }
    reveals += 1;
    return reveals <= REAL_CONFIG.n ? ea.evaluate(body) : hold(body);
  };
  const bridge = createBridge({ mock, evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
  await bridge.start(0);
  const record = await bridge.done(AGG);
  assert.equal(record.status, 'fulfilled');
  assert.equal(mock.sent.filter((s) => s.name === 'scriptResult').length, 1, 'published with three jobs still out');
  assert.equal(record.quiet, false);
  assert.equal(held.length, REAL_CONFIG.k - REAL_CONFIG.m + REAL_CONFIG.m - REAL_CONFIG.n);
  held.forEach((go) => go());
  const quiet = await bridge.quiet(AGG);
  await bridge.stop();
  assert.equal(quiet.quiet, true);
  assert.equal(mock.sent.filter((s) => s.name === 'scriptResult').length, 1, 'and only once');
  // Those that land after it finalized revert, as AggregationComplete, whatever phase they are of.
  assert.deepEqual(quiet.reverted.map((r) => r.reason), ['AggregationComplete', 'AggregationComplete', 'AggregationComplete']);
  assert.deepEqual(quiet.reverted.map((r) => r.phase).sort(), ['commit', 'commit', 'reveal']);
});

test('stopping does not wait for an EA that does not answer: every request still out is ended', async () => {
  const sockets = new Set();
  const server = http.createServer(() => { /* never answers */ });
  server.on('connection', (s) => { sockets.add(s); });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const evaluate = evaluateOver(`http://127.0.0.1:${server.address().port}`);
  const bridge = createBridge({ mock: fakeMock(), evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
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

test('a request found as the bridge stops starts nothing: not while it reads the request, not while it reads the chain', async () => {
  for (const hold of ['getRequestCids', 'queryFilter']) {
    const mock = fakeMock();
    let release;
    const gate = new Promise((r) => { release = r; });
    let reached = false;
    const real = mock[hold];
    mock[hold] = async (...args) => {
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
    const bridge = createBridge({ mock, evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
    await bridge.start(0);
    while (!reached) await new Promise((r) => { setTimeout(r, 2); });
    const stopping = bridge.stop();
    release();
    await stopping;
    assert.equal(calls, 0, `held at ${hold}: no job went out`);
  }
});

test('a transaction that fails at the N-th reveal fails the bridge at once, with jobs still out, and nothing is left unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const mock = fakeMock();
    mock.scriptResult = () => Promise.reject(new Error('the node refused it'));
    const ea = honestEa();
    let commits = 0;
    const evaluate = (body) => {
      if (body.data.cid.startsWith('1:')) {
        commits += 1;
        if (commits > REAL_CONFIG.m) return new Promise(() => {}); // surplus commits, out for good
      }
      return ea.evaluate(body);
    };
    const bridge = createBridge({ mock, evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
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

test('the fee ceiling clamps as the real one does', async () => {
  const mock = fakeMock({ maxFee: 10n ** 18n });
  const record = await serve(mock, honestEa().evaluate);
  assert.equal(record.fee, 400000000000000n);
  assert.equal(record.required, 400000000000000n * 12n);
});

test('the mock\'s multiplier is the real K + B x P', async () => {
  const mock = fakeMock();
  await serve(mock, honestEa().evaluate);
  assert.deepEqual(mock.sent.find((s) => s.name === 'setFeeMultiplier').args, [12n]);
});

test('an EA that abstains on every job: no transaction, no result, and the round stays open at the mock', async () => {
  const mock = fakeMock();
  const record = await serve(mock, async () => ({ status: 500, json: { status: 'errored', error: 'abstain', data: { aggregatedScore: [0] } } }));
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.abstained, REAL_CONFIG.k);
  assert.equal(record.commits, 0);
  assert.equal(mock.sent.filter((s) => s.name === 'scriptResult').length, 0, 'an abstention is never a result');
  assert.deepEqual(mock.sent.filter((s) => s.name === 'setRefundAmount').map((s) => s.args[0]), [FEE * 6n]);
});

test('a 200 with [0] is a zero commit, which the real contract ignores: no reveal, no result', async () => {
  const mock = fakeMock();
  const record = await serve(mock, async () => ({ status: 200, json: { data: { aggregatedScore: [0], justificationCid: '' } } }));
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.ignored.length, REAL_CONFIG.k);
  assert.equal(mock.sent.filter((s) => s.name === 'scriptResult').length, 0);
});

test('fewer than M commits: no reveal goes out', async () => {
  const mock = fakeMock();
  const ea = honestEa();
  let n = 0;
  const record = await serve(mock, async (body) => {
    n += 1;
    return n <= REAL_CONFIG.m - 1 ? ea.evaluate(body) : { status: 503, json: null };
  });
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.commits, REAL_CONFIG.m - 1);
  assert.equal(ea.calls.filter((c) => c.data.cid.startsWith('2:')).length, 0);
});

test('reveals that do not hash to their commits leave fewer than N: no result', async () => {
  const mock = fakeMock();
  const ea = honestEa();
  const record = await serve(mock, async (body) => {
    const answer = await ea.evaluate(body);
    if (body.data.cid.startsWith('2:')) answer.json.data.aggregatedScore = [0, 0, 0, 0, 1000000, 0];
    return answer;
  });
  assert.equal(record.status, 'no-verdict');
  assert.equal(record.ignored.filter((i) => i.reason === 'RevealHashMismatch').length, REAL_CONFIG.m);
  assert.equal(mock.sent.filter((s) => s.name === 'scriptResult').length, 0);
});

test('a request on a class no job is registered for fails the bridge, loudly: the real keeper would have refused it', async () => {
  const bridge = createBridge({ mock: fakeMock({ requestedClass: 128n }), evaluate: honestEa().evaluate, operator: OPERATOR, requestedClass: CLASS, pollMs: 5 });
  await bridge.start(0);
  await assert.rejects(bridge.done(AGG), /class 128/);
  await bridge.stop();
  assert.match(bridge.failure().message, /class 128/);
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
