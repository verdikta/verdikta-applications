/**
 * Pure helpers for v2 ReputationAggregator rounds: phase / slot-flag decoding,
 * the outcome of one round, and which arbiter slots a failed round is charged to.
 * Shared by the agg-history drill-down and the oracle-health scan; no I/O, so
 * it is unit-tested directly (test/roundModel.test.js).
 *
 * v2 round lifecycle (getRoundInfo phase): 1 draw, 2 beacons, 3 commit,
 * 4 closing, 5 reveal, 6 final, 7 settled, 8 failed, 9 cancelled.
 * Slot flags (getSlot): 1 dispatched, 2 committed, 4 promoted, 8 revealed, 16 counted.
 * A round draws K arbiters, closes the commit phase at M+ commits (or after T+
 * with at least M), promotes M of the commits, and finalizes at the N-th reveal.
 */

const PHASE = Object.freeze({
  NONE: 0, DRAW: 1, BEACON: 2, COMMIT: 3, CLOSING: 4, REVEAL: 5, FINAL: 6, SETTLED: 7, FAILED: 8, CANCELLED: 9,
});
const PHASE_NAMES = Object.freeze({
  0: 'unknown', 1: 'draw', 2: 'beacons', 3: 'commit', 4: 'closing', 5: 'reveal',
  6: 'final', 7: 'settled', 8: 'failed', 9: 'cancelled',
});
const SLOT = Object.freeze({ DISPATCHED: 1, COMMITTED: 2, PROMOTED: 4, REVEALED: 8, COUNTED: 16 });
const QCODE_NAMES = Object.freeze({ 0: null, 1: 'close', 2: 'off', 3: 'far' });
const SKIP_REASONS = Object.freeze({
  1: 'operator owner() call failed',
  2: 'commit request dispatch reverted',
  3: 'reveal request dispatch reverted',
  4: 'keeper scoring call reverted',
});

/** Decode a slot's flag byte into booleans. */
function decodeSlotFlags(flags) {
  const f = Number(flags) || 0;
  return {
    dispatched: (f & SLOT.DISPATCHED) !== 0,
    committed: (f & SLOT.COMMITTED) !== 0,
    promoted: (f & SLOT.PROMOTED) !== 0,
    revealed: (f & SLOT.REVEALED) !== 0,
    counted: (f & SLOT.COUNTED) !== 0,
  };
}

/** Aggregator M+ (the commit count that closes the window early): M + ceil((K - M) / 2). */
function mPlus(K, M) {
  return M + Math.ceil((K - M) / 2);
}

/**
 * Outcome, tallies and blame for one round.
 *
 * @param {object} r
 * @param {number} r.phase        getRoundInfo phase (0 = no such round)
 * @param {number|null} r.failedPhase  EvaluationFailed(aggId, phase) if seen
 * @param {Array<{flags:number, late?:boolean, qcode?:number}>} r.slots  getSlot per index (undispatched slots included)
 * @param {number} r.M  commits required (current aggregator config)
 * @param {number} r.N  reveals required
 * @param {boolean} [r.fulfilled]  a FulfillAIEvaluation was seen
 * @returns {{ kind, label, failStage, analysis, blame: Array<{slot:number, stage:'commit'|'reveal'}> }}
 *   kind: 'completed' | 'running' | 'malformed' | 'failed' | 'notDrawn' | 'cancelled' | 'unknown'
 *   blame is only non-empty for a failed round whose failure an arbiter caused.
 */
function describeRound({ phase, failedPhase = null, slots = [], M, N, fulfilled = false }) {
  const decoded = slots.map((s, i) => ({ slot: i, ...decodeSlotFlags(s.flags), late: !!s.late, qcode: Number(s.qcode) || 0 }));
  const dispatched = decoded.filter((s) => s.dispatched);
  const committed = decoded.filter((s) => s.committed);
  const promoted = decoded.filter((s) => s.promoted);
  const revealed = decoded.filter((s) => s.revealed);
  const counted = decoded.filter((s) => s.counted);
  const analysis = {
    totalSlots: decoded.length,
    dispatched: dispatched.length,
    committed: committed.length,
    promoted: promoted.length,
    revealed: revealed.length,
    counted: counted.length,
    lateReveals: revealed.filter((s) => !s.counted).length,
    nonResponding: dispatched.filter((s) => !s.committed).length,
    nonRespondingSlotIds: dispatched.filter((s) => !s.committed).map((s) => s.slot),
    promotedNotRevealed: promoted.filter((s) => !s.revealed).map((s) => s.slot),
    quality: {
      close: decoded.filter((s) => s.qcode === 1).length,
      off: decoded.filter((s) => s.qcode === 2).length,
      far: decoded.filter((s) => s.qcode === 3).length,
    },
  };

  const out = (kind, label, extra = {}) => ({ kind, label, failStage: null, analysis, blame: [], ...extra });
  const ph = Number(phase) || 0;
  const fp = failedPhase != null ? Number(failedPhase) : null;

  if (ph === PHASE.NONE) return out('unknown', 'NOT FOUND');
  if (fulfilled || ph === PHASE.FINAL || ph === PHASE.SETTLED) {
    return out('completed', ph === PHASE.FINAL ? 'COMPLETED (awaiting settlement)' : 'COMPLETED');
  }
  if (ph === PHASE.CANCELLED) return out('cancelled', 'CANCELLED (never drawn: prepay sent to the treasury)');
  if (ph === PHASE.DRAW) return out('running', 'IN PROCESS (awaiting jury draw)');
  if (ph === PHASE.BEACON) return out('running', 'IN PROCESS (beacon stage)');
  if (ph === PHASE.COMMIT) return out('running', `IN PROCESS (commit phase, ${committed.length}/${M} commits)`);
  if (ph === PHASE.CLOSING) return out('running', 'IN PROCESS (commit window closed, awaiting promotion)');
  if (ph === PHASE.REVEAL) return out('running', `IN PROCESS (reveal phase, ${counted.length}/${N} reveals)`);

  // ph === FAILED from here
  if (fp === PHASE.DRAW) return out('notDrawn', 'FAILED (no jury could be drawn: too few eligible arbiters)', { failStage: 'draw' });
  if (fp === PHASE.BEACON) return out('notDrawn', 'FAILED (beacon quorum missed)', { failStage: 'beacons' });
  if (fp === PHASE.COMMIT || (fp == null && promoted.length === 0)) {
    if (dispatched.length > 0 && committed.length === 0) {
      return out('malformed', 'LIKELY MALFORMED (no arbiter committed)', { failStage: 'commit' });
    }
    if (committed.length >= M) {
      // enough commits, but nobody closed the window after T+: not an arbiter failure
      return out('failed', 'FAILED (commit window never closed)', { failStage: 'commit' });
    }
    return out('failed', `FAILED (commit phase: ${committed.length}/${M} commits)`, {
      failStage: 'commit',
      blame: dispatched.filter((s) => !s.committed).map((s) => ({ slot: s.slot, stage: 'commit' })),
    });
  }
  if (fp === PHASE.CLOSING) return out('failed', 'FAILED (never promoted)', { failStage: 'closing' });
  return out('failed', `FAILED (reveal phase: ${counted.length}/${N} reveals)`, {
    failStage: 'reveal',
    blame: promoted.filter((s) => !s.revealed).map((s) => ({ slot: s.slot, stage: 'reveal' })),
  });
}

module.exports = {
  PHASE,
  PHASE_NAMES,
  SLOT,
  QCODE_NAMES,
  SKIP_REASONS,
  decodeSlotFlags,
  mPlus,
  describeRound,
};
