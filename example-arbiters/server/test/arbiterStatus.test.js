const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FLAGS, deriveStatus, isFrozenAt, exitState, reduceRegistry, flagNames, emptyTally,
} = require('../utils/arbiterStatus');

const NOW = 1_800_000_000;
const base = { flags: FLAGS.REGISTERED, quality: 640, timeliness: 700, offenses: 0, blockedUntil: 0, callSentAt: 0, exitAt: 0 };
const st = (over, ctx = {}) => deriveStatus({ ...base, ...over }, { now: NOW, ...ctx });

test('a registered, scored arbiter with nothing wrong is active and selectable', () => {
  const r = st({});
  assert.equal(r.status, 'active');
  assert.equal(r.selectable, true);
  assert.deepEqual(r.reasons, []);
});

test('never scored (both scores at start, no offenses) is new', () => {
  assert.equal(st({ quality: 500, timeliness: 500 }).status, 'new');
  // an offense means it has been scored (a block restarts scores at start)
  assert.equal(st({ quality: 500, timeliness: 500, offenses: 1 }).status, 'active');
  // a custom start value is honoured
  assert.equal(st({ quality: 450, timeliness: 450 }, { points: { start: 450 } }).status, 'new');
});

test('at risk: quality <= points.major or timeliness <= points.nocommit', () => {
  assert.equal(st({ quality: 200 }).status, 'atRisk');
  assert.equal(st({ quality: 201 }).status, 'active');
  assert.equal(st({ timeliness: 400 }).status, 'atRisk');
  assert.equal(st({ timeliness: 401 }).status, 'active');
  // quality above major but low timeliness: the old min(q, t) <= major rule missed this
  assert.equal(st({ quality: 900, timeliness: 350 }).status, 'atRisk');
  assert.equal(st({ quality: 250 }, { points: { major: 300 } }).status, 'atRisk');
  assert.equal(st({ timeliness: 450 }, { points: { nocommit: 450 } }).status, 'atRisk');
  assert.equal(st({ quality: 150 }).selectable, true);
});

test('timeliness <= points.fail adds the failMissRisk note without changing the status', () => {
  const r = st({ timeliness: 480 });
  assert.equal(r.status, 'active');
  assert.ok(r.reasons.includes('failMissRisk'));
  assert.ok(!st({ timeliness: 501 }).reasons.includes('failMissRisk'));
  // a new arbiter (both at start 500 = fail) carries the note and stays new
  const n = st({ quality: 500, timeliness: 500 });
  assert.equal(n.status, 'new');
  assert.ok(n.reasons.includes('failMissRisk'));
});

test('banned and blocked win over everything', () => {
  assert.equal(st({ flags: FLAGS.REGISTERED | FLAGS.BANNED | FLAGS.EXITING }).status, 'blocked');
  const r = st({ blockedUntil: NOW + 10, flags: FLAGS.REGISTERED | FLAGS.PAUSED });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.reasons.slice(0, 2), ['blocked', 'paused']);
  assert.equal(st({ blockedUntil: NOW - 1 }).status, 'active');
});

test('exiting, paused, under-staked and a fee above the max are inactive', () => {
  for (const f of [FLAGS.EXITING, FLAGS.PAUSED, FLAGS.UNDERSTAKED]) {
    const r = st({ flags: FLAGS.REGISTERED | f });
    assert.equal(r.status, 'inactive');
    assert.equal(r.selectable, false);
  }
  const fee = st({ feeWei: 5n * 10n ** 14n }, { maxOracleFeeWei: 4n * 10n ** 14n });
  assert.equal(fee.status, 'inactive');
  assert.ok(fee.reasons.includes('feeAboveMax'));
  assert.equal(st({ feeWei: 4n * 10n ** 14n }, { maxOracleFeeWei: 4n * 10n ** 14n }).status, 'active');
  assert.equal(st({ flags: 0 }).status, 'inactive');
});

test('frozen: pending call older than callDeadline; younger is only callPending', () => {
  const pending = FLAGS.REGISTERED | FLAGS.CALL_PENDING;
  const frozen = st({ flags: pending, callSentAt: NOW - 61 });
  assert.equal(frozen.status, 'frozen');
  assert.ok(frozen.reasons.includes('frozen'));
  const fresh = st({ flags: pending, callSentAt: NOW - 30 });
  assert.equal(fresh.status, 'active');
  assert.ok(fresh.reasons.includes('callPending'));
  // the keeper's isFrozen() result, when given, wins
  assert.equal(st({ flags: pending, callSentAt: NOW - 30, frozen: true }).status, 'frozen');
  assert.equal(isFrozenAt({ flags: pending, callSentAt: NOW - 100 }, NOW, 120), false);
});

test('a head-0 registration (re-sync flag) is frozen with reason resyncing', () => {
  const r = st({ flags: FLAGS.REGISTERED | FLAGS.CALL_PENDING | FLAGS.RESYNC, callSentAt: NOW - 61, quality: 500, timeliness: 500 });
  assert.equal(r.status, 'frozen');
  assert.ok(r.reasons.includes('resyncing'));
  assert.ok(!r.reasons.includes('frozen'));
  assert.equal(r.selectable, false);
});

test('exitState walks unbonding -> ready, and waits out a block', () => {
  const ex = { flags: FLAGS.REGISTERED | FLAGS.EXITING, exitAt: NOW + 100, blockedUntil: 0 };
  assert.deepEqual(exitState(ex, NOW), { state: 'unbonding', exitAt: NOW + 100, waitSeconds: 100 });
  assert.equal(exitState(ex, NOW + 100).state, 'ready');
  assert.equal(exitState({ ...ex, blockedUntil: NOW + 500 }, NOW + 200).state, 'blockedUntilFree');
  assert.equal(exitState({ flags: FLAGS.REGISTERED }, NOW).state, 'none');
});

test('reduceRegistry keeps keys whose latest event is a registration, in log order', () => {
  const ev = [
    { name: 'ArbiterRemoved', key: '0xAA', blockNumber: 20, logIndex: 0 },
    { name: 'ArbiterRegistered', key: '0xaa', oracle: '0x1', jobId: '0xj1', fee: 1n, blockNumber: 10, logIndex: 3 },
    { name: 'ArbiterRegistered', key: '0xbb', oracle: '0x2', jobId: '0xj2', fee: 2n, blockNumber: 11, logIndex: 0 },
    { name: 'ArbiterRegistered', key: '0xaa', oracle: '0x1', jobId: '0xj1', fee: 3n, blockNumber: 30, logIndex: 1 },
    { name: 'ArbiterRegistered', key: '0xcc', oracle: '0x3', jobId: '0xj3', fee: 4n, blockNumber: 12, logIndex: 0 },
    { name: 'ArbiterRemoved', key: '0xcc', blockNumber: 12, logIndex: 5 },
  ];
  const live = reduceRegistry(ev);
  assert.deepEqual([...live.keys()].sort(), ['0xaa', '0xbb']);
  assert.equal(live.get('0xaa').fee, 3n);
  assert.equal(live.get('0xaa').registeredBlock, 30);
});

test('flagNames and emptyTally', () => {
  assert.deepEqual(flagNames(1 | 8 | 64), ['registered', 'exiting', 'resync']);
  assert.deepEqual(Object.keys(emptyTally()), ['active', 'new', 'atRisk', 'frozen', 'blocked', 'inactive']);
});
