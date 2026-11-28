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

test('commit-phase failure blames the dispatched slots that did not commit, when half of the seats committed', () => {
  const slots = asSlots([D | C, D | C, D, D, D | C, 0]);
  slots[5].skipReason = 'operator owner() call failed';
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots, M, N });
  assert.equal(r.kind, 'failed');
  assert.equal(r.failStage, 'commit');
  // 3 of 6 seats committed: the contract charges slots 2 and 3; slot 5 was never sent the job
  assert.deepEqual(r.blame, [
    { slot: 2, stage: 'commit' },
    { slot: 3, stage: 'commit' },
  ]);
  assert.equal(r.analysis.skipped, 1);
  assert.equal(r.analysis.nonResponding, 3);
});

test('no commit at all is likely malformed, kept out of the blame list', () => {
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D, D, D, D, D, D]), M, N });
  assert.equal(r.kind, 'malformed');
  assert.deepEqual(r.blame, []);
  // every slot is skipped at the draw: not a malformed request, and nobody was sent the job to be charged for
  const sk = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([0, 0, 0, 0, 0, 0]), M, N });
  assert.equal(sk.kind, 'failed');
  assert.deepEqual(sk.blame, []);
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
const so = (over) => slotOutcome({ commits: 5, M, K: 6, qcode: 0, points: pts, ...over });

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

test('slotOutcome: commit phase charges a dispatched non-committer only with K/2..M-1 commits', () => {
  const nc = so({ settlePhase: PHASE.COMMIT, commits: 3, flags: D });
  assert.equal(nc.code, CODE.NOCOMMIT_FAILED);
  assert.equal(nc.tDelta, -pts.nocommit);
  assert.equal(nc.frozenSkip, true);   // no commit: skipped if frozen at the round end
  // a slot whose dispatch failed was never sent the job (review 2026-11-26 #7)
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: 0 }).scored, false);
  assert.match(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: 0 }).note, /never dispatched/);
  // fewer than half of K (6) committed: nobody is charged, a lone commit included
  for (const commits of [0, 1, 2]) assert.equal(so({ settlePhase: PHASE.COMMIT, commits, flags: D }).scored, false);
  assert.match(so({ settlePhase: PHASE.COMMIT, commits: 1, flags: D }).note, /fewer than half/);
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 3, flags: D | C }).scored, false);
  // ≥ M commits but never closed, or never promoted: nobody is charged
  assert.equal(so({ settlePhase: PHASE.COMMIT, commits: 5, flags: D }).scored, false);
  assert.equal(so({ settlePhase: PHASE.CLOSING, commits: 6, flags: D }).scored, false);
  assert.match(so({ settlePhase: PHASE.CLOSING, commits: 6, flags: D }).note, /never promoted/);
});

test('the no-commit rule counts against K, not M (review 2026-11-28): K 12, M 7', () => {
  const big = (commits, flags) => slotOutcome({ settlePhase: PHASE.COMMIT, commits, M: 7, K: 12, flags, qcode: 0, points: pts });
  for (const commits of [4, 5]) assert.equal(big(commits, D).scored, false, `${commits} commits: more than half of M, fewer than half of K`);
  assert.equal(big(6, D).code, CODE.NOCOMMIT_FAILED);
  assert.equal(big(6, D | C).scored, false);
  // describeRound's blame follows the same rule: dispatched non-committers, only when half of the seats committed
  const few = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D | C, D, D, D, D, D]), M, N });
  assert.deepEqual(few.blame ?? [], []);
  assert.match(few.label, /nobody is charged/);
  const half = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D | C, D | C, D | C, D, D, 0]), M, N });
  assert.deepEqual(half.blame.map((b) => b.slot), [3, 4]);   // the undispatched slot 5 is not blamed
});
