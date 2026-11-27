const test = require('node:test');
const assert = require('node:assert/strict');
const { describeRound, decodeSlotFlags, mPlus, slotOutcome, PHASE, CODE } = require('../utils/roundModel');
const { DEFAULT_POINTS } = require('../utils/arbiterStatus');

const D = 1, C = 2, P = 4, R = 8, CT = 16;
const M = 5, N = 4;
const asSlots = (flags) => flags.map((f) => ({ flags: f }));

test('decodeSlotFlags and mPlus', () => {
  assert.deepEqual(decodeSlotFlags(D | C | P | R | CT), { dispatched: true, committed: true, promoted: true, revealed: true, counted: true });
  assert.equal(decodeSlotFlags(D).committed, false);
  assert.equal(mPlus(6, 5), 6);
  assert.equal(mPlus(8, 5), 7);
});

test('a settled round is completed, a finalized one awaits settlement', () => {
  const full = D | C | P | R | CT;
  const slots = asSlots([full, full, full, full, D | C | P, D]);
  const r = describeRound({ phase: PHASE.SETTLED, slots, M, N });
  assert.equal(r.kind, 'completed');
  assert.equal(r.label, 'COMPLETED');
  assert.equal(r.analysis.counted, 4);
  assert.equal(r.analysis.nonResponding, 1);
  assert.deepEqual(r.blame, []);
  assert.equal(describeRound({ phase: PHASE.FINAL, slots, M, N }).label, 'COMPLETED (awaiting settlement)');
});

test('commit-phase failure blames every slot that did not commit, skipped slots included', () => {
  const slots = asSlots([D | C, D | C, D, D, D | C, 0]);
  slots[5].skipReason = 'operator owner() call failed';
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots, M, N });
  assert.equal(r.kind, 'failed');
  assert.equal(r.failStage, 'commit');
  assert.deepEqual(r.blame, [
    { slot: 2, stage: 'commit' },
    { slot: 3, stage: 'commit' },
    { slot: 5, stage: 'commit', skipped: 'operator owner() call failed' },
  ]);
  assert.equal(r.analysis.skipped, 1);
  assert.equal(r.analysis.nonResponding, 3);
});

test('no commit at all is likely malformed, kept out of the blame list', () => {
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D, D, D, D, D, D]), M, N });
  assert.equal(r.kind, 'malformed');
  assert.deepEqual(r.blame, []);
  // every slot is skipped at the draw: not a malformed request, the skipped slots are charged
  const sk = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([0, 0, 0, 0, 0, 0]), M, N });
  assert.equal(sk.kind, 'failed');
  assert.equal(sk.blame.length, 6);
});

test('M commits but never closed, or closed and never promoted, is notProgressed: committers paid, no blame', () => {
  const unclosed = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D | C, D | C, D | C, D | C, D | C, D]), M, N });
  assert.equal(unclosed.kind, 'notProgressed');
  assert.equal(unclosed.forfeit, 'committers');
  assert.deepEqual(unclosed.blame, []);
  const unpromoted = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.CLOSING, slots: asSlots([D | C, D | C, D | C, D | C, D | C, D]), M, N });
  assert.equal(unpromoted.kind, 'notProgressed');
  assert.equal(unpromoted.forfeit, 'committers');
});

test('draws that never happen are split by refund vs arbiter pool', () => {
  const pool = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.DRAW, slots: [], M, N, refundTo: 'requester' });
  assert.equal(pool.kind, 'notDrawn');
  assert.equal(pool.notDrawnReason, 'poolShortage');
  assert.equal(pool.forfeit, null);
  const tre = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.DRAW, slots: [], M, N, refundTo: 'pool' });
  assert.equal(tre.notDrawnReason, 'drawPool');
  assert.equal(tre.forfeit, 'pool');
  const bq = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.BEACON, slots: [], M, N });
  assert.equal(bq.notDrawnReason, 'beaconQuorum');
  assert.equal(bq.forfeit, 'pool');
  const c = describeRound({ phase: PHASE.CANCELLED, slots: [], M, N });
  assert.equal(c.kind, 'cancelled');
  assert.equal(c.notDrawnReason, 'cancelled');
  assert.equal(c.forfeit, 'pool');
});

test('reveal-phase failure blames only promoted slots that never revealed', () => {
  const full = D | C | P | R | CT;
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.REVEAL, slots: asSlots([full, full, D | C | P, D | C | P, full, D | C]), M, N });
  assert.equal(r.failStage, 'reveal');
  assert.deepEqual(r.blame.map((b) => b.slot), [2, 3]);
  assert.deepEqual(r.analysis.promotedNotRevealed, [2, 3]);
});

test('draw and beacon failures, cancellations and in-flight phases carry no blame', () => {
  assert.equal(describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.DRAW, slots: [], M, N }).kind, 'notDrawn');
  assert.equal(describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.BEACON, slots: [], M, N }).kind, 'notDrawn');
  assert.equal(describeRound({ phase: PHASE.CANCELLED, slots: [], M, N }).kind, 'cancelled');
  for (const phase of [PHASE.DRAW, PHASE.BEACON, PHASE.COMMIT, PHASE.CLOSING, PHASE.REVEAL]) {
    const r = describeRound({ phase, slots: asSlots([D]), M, N });
    assert.equal(r.kind, 'running');
    assert.deepEqual(r.blame, []);
  }
  assert.equal(describeRound({ phase: 0, slots: [], M, N }).kind, 'unknown');
});

test('late reveals and quality codes are tallied', () => {
  const slots = [
    { flags: D | C | P | R | CT, qcode: 1 },
    { flags: D | C | P | R, qcode: 3, late: true },
    { flags: D | C | P | R | CT, qcode: 2 },
  ];
  const r = describeRound({ phase: PHASE.SETTLED, slots, M, N });
  assert.equal(r.analysis.lateReveals, 1);
  assert.deepEqual(r.analysis.quality, { close: 1, off: 1, far: 1 });
});

const pts = DEFAULT_POINTS;
const so = (over) => slotOutcome({ commits: 5, M, qcode: 0, points: pts, ...over });

test('slotOutcome: finished round', () => {
  const close = so({ settlePhase: PHASE.FINAL, flags: D | C | P | R | CT, qcode: 1 });
  assert.equal(close.code, CODE.DELIVERED | (1 << 4) | CODE.COMMITTED);
  assert.equal(close.tDelta, pts.gain);
  assert.equal(close.qDelta, pts.gain);
  assert.equal(close.frozenSkip, false);
  assert.equal(so({ settlePhase: PHASE.FINAL, flags: D | C | P | R, qcode: 3 }).qDelta, -pts.major);   // late and far
  assert.equal(so({ settlePhase: PHASE.FINAL, flags: D | C | P | R | CT, qcode: 2 }).qDelta, -pts.minor);
  const miss = so({ settlePhase: PHASE.FINAL, flags: D | C | P });
  assert.equal(miss.code, CODE.MISS_FINISHED | CODE.COMMITTED);
  assert.equal(miss.tDelta, -pts.major);
  // committed but not promoted, or never committed: nothing
  assert.equal(so({ settlePhase: PHASE.FINAL, flags: D | C }).scored, false);
  assert.equal(so({ settlePhase: PHASE.FINAL, flags: D }).scored, false);
});

test('slotOutcome: failed in the reveal phase', () => {
  const del = so({ settlePhase: PHASE.REVEAL, flags: D | C | P | R | CT, qcode: 1 });
  assert.equal(del.code, CODE.DELIVERED | CODE.COMMITTED);   // no quality code in a failed round
  assert.equal(del.qDelta, 0);
  const miss = so({ settlePhase: PHASE.REVEAL, flags: D | C | P });
  assert.equal(miss.tDelta, -pts.fail);
  assert.equal(miss.frozenSkip, false);
});

test('slotOutcome: commit phase charges a dispatched non-committer only with M/2..M-1 commits', () => {
  const nc = so({ settlePhase: PHASE.COMMIT, commits: 3, flags: D });
  assert.equal(nc.code, CODE.NOCOMMIT_FAILED);
  assert.equal(nc.tDelta, -pts.nocommit);
  assert.equal(nc.frozenSkip, true);   // no commit: skipped if frozen at the round end
  // a slot whose dispatch failed was never sent the job (review 2026-11-26 #7)
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: 0 }).scored, false);
  assert.match(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: 0 }).note, /never dispatched/);
  // fewer than half of M (5) committed: nobody is charged, a lone commit included
  for (const commits of [0, 1, 2]) assert.equal(so({ settlePhase: PHASE.COMMIT, commits, flags: D }).scored, false);
  assert.match(so({ settlePhase: PHASE.COMMIT, commits: 1, flags: D }).note, /fewer than half/);
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: D | C }).scored, false);
  // ≥ M commits but never closed, or never promoted: nobody is charged
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 5, flags: D }).scored, false);
  assert.equal(so({ settlePhase: PHASE.CLOSING, commits: 6, flags: D }).scored, false);
  assert.match(so({ settlePhase: PHASE.CLOSING, commits: 6, flags: D }).note, /never promoted/);
});
