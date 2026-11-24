const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { VerdiktaService, toAggId, juryTally } = require('../utils/verdiktaService');

const AGG = '0x00000000000000000000000000000000000000a1';
const KEEPER = '0x00000000000000000000000000000000000000b2';
const keeperIface = new ethers.Interface([
  'event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness)',
  'event OutcomeSkippedFrozen(bytes32 indexed key)',
  'event ArbiterBlocked(bytes32 indexed key, uint256 until, uint256 offenses, uint256 burned)',
]);
const aggIface = new ethers.Interface(['event RoundSettled(bytes32 indexed aggRequestId, bool failed)']);
const id = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const key = (n) => ethers.zeroPadValue(ethers.toBeHex(0x1000 + n), 32);
const log = (address, frag, args, index) => {
  const iface = address === AGG ? aggIface : keeperIface;
  const { topics, data } = iface.encodeEventLog(frag, args);
  return { address, topics, data, index };
};

test('toAggId takes a decimal round number or a bytes32 id', () => {
  assert.equal(toAggId('7'), id(7));
  assert.equal(toAggId(id(7).toUpperCase().replace('0X', '0x')), id(7));
  assert.equal(toAggId('0'), null);
  assert.equal(toAggId('0x12'), null);
  assert.equal(toAggId('abc'), null);
});

test("_settleKeeperEvents keeps only this round's keeper events from a multi-round settle tx", async () => {
  const svc = new VerdiktaService('http://127.0.0.1:1', AGG);
  svc.reputationKeeper = new ethers.Contract(KEEPER, keeperIface.fragments, svc.provider);
  svc.keeperAddress = KEEPER;
  const logs = [
    // round 3 settles first in the same transaction
    log(KEEPER, 'ScoresUpdated', [key(1), 520, 480], 0),
    log(AGG, 'RoundSettled', [id(3), false], 1),
    // round 4: the one asked for
    log(KEEPER, 'ScoresUpdated', [key(1), 500, 100], 2),
    log(KEEPER, 'OutcomeSkippedFrozen', [key(2)], 3),
    log(KEEPER, 'ArbiterBlocked', [key(3), 999, 2, 0], 4),
    log(KEEPER, 'ScoresUpdated', [key(3), 640, 500], 5),
    log('0x00000000000000000000000000000000000000c3', 'ScoresUpdated', [key(9), 1, 1], 6),   // not the keeper
    log(AGG, 'RoundSettled', [id(4), true], 7),
    log(KEEPER, 'ScoresUpdated', [key(1), 1, 1], 8),
  ];
  svc._getReceiptProvider = () => ({ getTransactionReceipt: async () => ({ logs }) });
  const out = await svc._settleKeeperEvents('0xabc', id(4));
  assert.deepEqual(Object.keys(out).sort(), [key(1), key(2), key(3)].map((k) => k.toLowerCase()).sort());
  assert.deepEqual(out[key(1).toLowerCase()], { scored: true, quality: 500, timeliness: 100 });
  assert.deepEqual(out[key(2).toLowerCase()], { scored: false, skippedFrozen: true });
  assert.deepEqual(out[key(3).toLowerCase()], { blockedUntil: 999, offenses: 2, scored: true, quality: 640, timeliness: 500 });
});

test('_getJury reads a round\'s own jury, caches it, and returns null for an unknown round', async () => {
  const svc = new VerdiktaService('http://127.0.0.1:1', AGG);
  const juries = { [id(5).toLowerCase()]: [21n, 16n, 13n, 10n, 300n] };
  let calls = 0;
  svc._agg = () => ({
    getJury: async (aggId) => {
      calls++;
      const [K, M, N, P, timeout] = juries[String(aggId).toLowerCase()] || [0n, 0n, 0n, 0n, 0n];
      return { K, M, N, P, timeout };
    },
  });
  const j = await svc._getJury(id(5));
  assert.deepEqual(j, { K: 21, M: 16, N: 13, P: 10, timeout: 300, mPlus: 19 });
  await svc._getJury(id(5));
  assert.equal(calls, 1);
  assert.equal(await svc._getJury(id(6)), null);
});

test('juryTally groups rounds by their jury, most used first', () => {
  const small = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
  const jumbo = { K: 50, M: 38, N: 27, P: 17, timeout: 600 };
  const out = juryTally([{ jury: jumbo }, { jury: small }, { jury: { ...small } }, { jury: null }]);
  assert.deepEqual(out, [{ ...small, rounds: 2 }, { ...jumbo, rounds: 1 }]);
});
