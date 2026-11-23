const test = require('node:test');
const assert = require('node:assert/strict');
const { describeRound, decodeSlotFlags, mPlus, PHASE } = require('../utils/roundModel');

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

test('commit-phase failure blames the dispatched slots that did not commit', () => {
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D | C, D | C, D, D, D | C, 0]), M, N });
  assert.equal(r.kind, 'failed');
  assert.equal(r.failStage, 'commit');
  assert.deepEqual(r.blame, [{ slot: 2, stage: 'commit' }, { slot: 3, stage: 'commit' }]);
});

test('no commit at all is likely malformed, with no blame', () => {
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D, D, D, D, D, D]), M, N });
  assert.equal(r.kind, 'malformed');
  assert.deepEqual(r.blame, []);
});

test('M commits but the window was never closed is not an arbiter failure', () => {
  const r = describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.COMMIT, slots: asSlots([D | C, D | C, D | C, D | C, D | C, D]), M, N });
  assert.equal(r.kind, 'failed');
  assert.deepEqual(r.blame, []);
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
  assert.equal(describeRound({ phase: PHASE.FAILED, failedPhase: PHASE.CLOSING, slots: asSlots([D | C]), M, N }).blame.length, 0);
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
