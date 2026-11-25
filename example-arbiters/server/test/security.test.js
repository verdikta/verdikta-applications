// Regression tests for the security review fixes (RPC fan-out, key leaks, cache
// growth, unauthenticated refresh, alerts ingest ordering).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { ethers } = require('ethers');

const { redact } = require('../utils/redact');
const { VerdiktaService, getVerdiktaService } = require('../utils/verdiktaService');
const { AnalyticsCacheService } = require('../utils/analyticsCacheService');
const { oracleHealthWindow, refreshAllowed } = require('../routes/analyticsRoutes');

test('redact strips an RPC key from an ethers-style error message', () => {
  const env = { INFURA_API_KEY: 'abcdef0123456789abcdef0123456789', LOG_RPC_URL: 'https://x.example/v2/SeCrEtAlchemyKey99', PORT: '5008' };
  const msg = 'server response 429 Too Many Requests (request={  }, info={ "requestUrl": '
    + '"https://base-mainnet.infura.io/v3/abcdef0123456789abcdef0123456789", "responseStatus": "429" })';
  const out = redact(msg, env);
  assert.ok(!out.includes('abcdef0123456789abcdef0123456789'));
  assert.ok(out.includes('https://base-mainnet.infura.io/v3/[redacted]'));
  assert.equal(redact('GET https://x.example/v2/SeCrEtAlchemyKey99 failed', env), 'GET [redacted] failed');
  assert.equal(redact('see /v2/SeCrEtAlchemyKey99', env), 'see [redacted]');
  // Non-secret values (and short ones) are left alone.
  assert.equal(redact('port 5008 ok', env), 'port 5008 ok');
});

test('getAllOracles coalesces concurrent fresh reads into bounded walks', async () => {
  const svc = new VerdiktaService('http://127.0.0.1:1', null, { networkKey: 'base-sepolia' });
  let walks = 0;
  const starts = [];
  svc._walkOracles = async () => {
    walks++;
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 30));
    const data = [{ walk: walks }];
    svc._oraclesCache = { data, ts: Date.now() };
    return data;
  };
  // 25 anonymous "fresh" reads at once: one walk runs, one is queued behind it.
  const asked = Date.now();
  const res = await Promise.all(Array.from({ length: 25 }, () => svc.getAllOracles({ maxAgeMs: 0 })));
  assert.ok(walks <= 2, `expected at most 2 walks, got ${walks}`);
  // Every caller got data from a walk that started at or after it asked.
  for (const r of res) assert.ok(starts[r[0].walk - 1] >= asked);

  // A caller arriving while a walk runs never receives that (older) walk.
  walks = 0; starts.length = 0;
  const first = svc.getAllOracles({ maxAgeMs: 0 });
  await new Promise((r) => setTimeout(r, 10));
  const lateAsk = Date.now();
  const late = await svc.getAllOracles({ maxAgeMs: 0 });
  await first;
  assert.equal(late[0].walk, 2);
  assert.ok(starts[1] >= lateAsk);
});

test('getOwnedArbiters reads withdrawable() only for the wallet\'s own operators', async () => {
  const svc = new VerdiktaService('http://127.0.0.1:1', null, { networkKey: 'base-sepolia' });
  const ops = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)].map(ethers.getAddress);
  const me = '0x' + '99'.repeat(20);
  svc.getReputationKeeper = async () => ({});
  svc._getStatusCtx = async () => ({});
  svc.getAllOracles = async () => ops.map((o, i) => ({ key: `k${i}`, oracle: o, jobId: `0x${i}` }));
  let ownerAge = null;
  svc.getOwnerMap = async (addrs, opts) => {
    ownerAge = opts?.maxAgeMs;
    return Object.fromEntries(addrs.map((a) => [a.toLowerCase(), a === ops[1] ? me : '0x' + '77'.repeat(20)]));
  };
  let withdrawableFor = null;
  svc.getWithdrawableMap = async (addrs) => { withdrawableFor = addrs; return { [ops[1].toLowerCase()]: 0n }; };
  svc._computeFunding = async () => ({ perOp: {}, gasPrice: 0n });
  svc._fundingForClient = () => null;
  svc.getJobSenderMap = async () => ({});
  svc.getEthOwed = async () => 0n;
  const out = await svc.getOwnedArbiters(me);
  assert.deepEqual(withdrawableFor, [ops[1]]);
  assert.equal(ownerAge, 60_000);
  assert.equal(out.operators.length, 1);
  assert.equal(out.operators[0].operator, ops[1]);
});

test('getJobSenderMap shares one scan between concurrent callers', async () => {
  const svc = new VerdiktaService('http://127.0.0.1:1', null, { networkKey: 'base-sepolia' });
  let scans = 0;
  svc._scanJobSenders = async () => { scans++; await new Promise((r) => setTimeout(r, 20)); return { a: 1 }; };
  const op = '0x' + '44'.repeat(20);
  await Promise.all([svc.getJobSenderMap(op, ['0xA', '0xb']), svc.getJobSenderMap(op, ['0xB', '0xa']), svc.getJobSenderMap(op, ['0xa', '0xb'])]);
  assert.equal(scans, 1);
});

test('oracle-health windows snap to the served set', () => {
  assert.equal(oracleHealthWindow(undefined), 14);
  assert.equal(oracleHealthWindow('abc'), 14);
  assert.equal(oracleHealthWindow('1'), 1);
  assert.equal(oracleHealthWindow('2'), 7);
  assert.equal(oracleHealthWindow('14'), 14);
  assert.equal(oracleHealthWindow('15'), 30);
  assert.equal(oracleHealthWindow('59'), 60);
  assert.equal(oracleHealthWindow('9999'), 60);
});

test('refresh is honoured at most once per 30 s per key', () => {
  const t = 1_000_000_000_000;
  assert.equal(refreshAllowed('test_k', t), true);
  assert.equal(refreshAllowed('test_k', t + 1000), false);
  assert.equal(refreshAllowed('test_other', t + 1000), true);
  assert.equal(refreshAllowed('test_k', t + 30_001), true);
});

test('the analytics cache is bounded', () => {
  const c = new AnalyticsCacheService(60_000, 3);
  for (let i = 0; i < 10; i++) c.set(`agg_${i}`, { i });
  assert.equal(c.getStats().size, 3);
  assert.equal(c.get('agg_0'), null);
  assert.deepEqual(c.get('agg_9').data, { i: 9 });
  // Re-setting a key makes it the newest, so it survives the next eviction.
  c.set('agg_7', { i: 7 });
  c.set('agg_10', { i: 10 });
  assert.ok(c.get('agg_7'));
  assert.equal(c.get('agg_8'), null);
});

test('alerts ingest rejects an unregistered operator before any owner() read', async () => {
  const svc = getVerdiktaService('base-sepolia');
  const registered = ethers.getAddress('0x' + '55'.repeat(20));
  svc.getAllOracles = async () => [{ oracle: registered, key: 'k' }];
  let ownerReads = 0;
  svc.getOwnerMap = async (addrs) => { ownerReads++; return Object.fromEntries(addrs.map((a) => [a.toLowerCase(), null])); };

  const app = express();
  app.use(express.json());
  app.use('/api/alerts', require('../routes/alertsRoutes'));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const wallet = ethers.Wallet.createRandom();
  const post = async (operator) => {
    const ts = new Date().toISOString();
    const status = 'OK';
    const sig = await wallet.signMessage(`verdikta-arbiter-watchdog:v1:${operator.toLowerCase()}:base_sepolia:${status}:${ts}`);
    const r = await fetch(`http://127.0.0.1:${port}/api/alerts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator, network: 'base_sepolia', status, ts, signer: wallet.address, sig }),
    });
    return r.status;
  };
  try {
    assert.equal(await post(ethers.Wallet.createRandom().address), 422);
    assert.equal(ownerReads, 0);
    // A registered operator still gets the owner check (503 here: owner unknown).
    assert.equal(await post(registered), 503);
    assert.equal(ownerReads, 1);
  } finally {
    server.close();
  }
});
