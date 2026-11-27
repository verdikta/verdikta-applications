/**
 * Pure helpers for v2 ReputationAggregator rounds: phase / slot-flag decoding,
 * the outcome of one round, which arbiter slots a failed round is charged to, and
 * the keeper outcome (and score change) settlement reports for each slot.
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

/** Keeper outcome codes (ReputationKeeper T_* / C_COMMITTED, ReputationAggregator._settle). */
const CODE = Object.freeze({ NONE: 0, DELIVERED: 1, MISS_FINISHED: 2, MISS_FAILED: 3, NOCOMMIT_FAILED: 4, COMMITTED: 0x80 });
const CODE_NAMES = Object.freeze({
  0: 'none', 1: 'delivered', 2: 'promoted miss (round finished)', 3: 'promoted miss (round failed)', 4: 'no commit (round failed)',
});

/**
 * Outcome, tallies and blame for one round.
 *
 * @param {object} r
 * @param {number} r.phase        getRoundInfo phase (0 = no such round)
 * @param {number|null} r.failedPhase  EvaluationFailed(aggId, phase) if seen
 * @param {Array<{flags:number, late?:boolean, qcode?:number, skipReason?:string}>} r.slots
 *   getSlot per index. A slot skipped at the draw (owner() failed, dispatch
 *   reverted) has its key set and flags 0; skipReason comes from SlotSkipped.
 * @param {number} r.M  commits required (the round's aggregator config)
 * @param {number} r.N  reveals required
 * @param {boolean} [r.fulfilled]  a FulfillAIEvaluation was seen
 * @param {'requester'|'pool'|null} [r.refundTo]  payee of the round's
 *   RequesterRefunded, when seen: 'pool' when it is address(0), the arbiter pool
 *   (a draw failure after a beacon stage pays the pool when the keeper's
 *   selection walk does not cover the class list)
 * @returns {{ kind, label, failStage, notDrawnReason, forfeit, analysis,
 *   blame: Array<{slot:number, stage:'commit'|'reveal', skipped?:string}> }}
 *   kind: 'completed' | 'running' | 'malformed' | 'failed' | 'notProgressed' |
 *         'notDrawn' | 'cancelled' | 'unknown'
 *   notDrawnReason (notDrawn / cancelled): 'poolShortage' | 'drawPool' |
 *         'beaconQuorum' | 'cancelled'
 *   forfeit: where the unspent prepay went instead of back to the requester:
 *         'pool' (the arbiter pool, ethOwed(address(0)), paid out an eighth per
 *         draw to a random registered arbiter), 'committers' (a never-promoted
 *         round: equal CommitPayment shares to the slots that committed, the
 *         indivisible rest to the pool), or null (refunded, or not ended)
 *   blame is only non-empty for a failed round whose failure an arbiter caused.
 */
function describeRound({ phase, failedPhase = null, slots = [], M, N, fulfilled = false, refundTo = null }) {
  const decoded = slots.map((s, i) => ({
    slot: i, ...decodeSlotFlags(s.flags), late: !!s.late, qcode: Number(s.qcode) || 0, skipReason: s.skipReason || null,
  }));
  const dispatched = decoded.filter((s) => s.dispatched);
  const committed = decoded.filter((s) => s.committed);
  const promoted = decoded.filter((s) => s.promoted);
  const revealed = decoded.filter((s) => s.revealed);
  const counted = decoded.filter((s) => s.counted);
  const notCommitted = decoded.filter((s) => !s.committed);
  const analysis = {
    totalSlots: decoded.length,
    dispatched: dispatched.length,
    skipped: decoded.length - dispatched.length,
    committed: committed.length,
    promoted: promoted.length,
    revealed: revealed.length,
    counted: counted.length,
    lateReveals: revealed.filter((s) => !s.counted).length,
    nonResponding: notCommitted.length,
    nonRespondingSlotIds: notCommitted.map((s) => s.slot),
    promotedNotRevealed: promoted.filter((s) => !s.revealed).map((s) => s.slot),
    quality: {
      close: decoded.filter((s) => s.qcode === 1).length,
      off: decoded.filter((s) => s.qcode === 2).length,
      far: decoded.filter((s) => s.qcode === 3).length,
    },
  };

  const out = (kind, label, extra = {}) => ({
    kind, label, failStage: null, notDrawnReason: null, forfeit: null, analysis, blame: [], ...extra,
  });
  const ph = Number(phase) || 0;
  const fp = failedPhase != null ? Number(failedPhase) : null;

  if (ph === PHASE.NONE) return out('unknown', 'NOT FOUND');
  if (fulfilled || ph === PHASE.FINAL || ph === PHASE.SETTLED) {
    return out('completed', ph === PHASE.FINAL ? 'COMPLETED (awaiting settlement)' : 'COMPLETED');
  }
  if (ph === PHASE.CANCELLED) {
    return out('cancelled', 'CANCELLED (never drawn: prepay sent to the arbiter pool)', { notDrawnReason: 'cancelled', forfeit: 'pool' });
  }
  if (ph === PHASE.DRAW) return out('running', 'IN PROCESS (awaiting jury draw)');
  if (ph === PHASE.BEACON) return out('running', 'IN PROCESS (beacon stage)');
  if (ph === PHASE.COMMIT) return out('running', `IN PROCESS (commit phase, ${committed.length}/${M} commits)`);
  if (ph === PHASE.CLOSING) return out('running', 'IN PROCESS (commit window closed, awaiting promotion)');
  if (ph === PHASE.REVEAL) return out('running', `IN PROCESS (reveal phase, ${counted.length}/${N} reveals)`);

  // ph === FAILED from here
  if (fp === PHASE.DRAW) {
    if (refundTo === 'pool') {
      return out('notDrawn', 'FAILED (no jury could be drawn after the beacon stage: prepay sent to the arbiter pool)', {
        failStage: 'draw', notDrawnReason: 'drawPool', forfeit: 'pool',
      });
    }
    return out('notDrawn', 'FAILED (no jury could be drawn: too few eligible arbiters; requester refunded)', {
      failStage: 'draw', notDrawnReason: 'poolShortage',
    });
  }
  if (fp === PHASE.BEACON) {
    return out('notDrawn', 'FAILED (beacon quorum missed: the rest of the prepay sent to the arbiter pool)', {
      failStage: 'beacons', notDrawnReason: 'beaconQuorum', forfeit: 'pool',
    });
  }
  if (fp === PHASE.COMMIT || (fp == null && promoted.length === 0)) {
    if (committed.length >= M) {
      // enough commits, but nobody closed the window after T+: nobody is charged
      // and the unspent prepay is shared by the slots that committed (CommitPayment)
      return out('notProgressed', 'NOT PROGRESSED (commit window never closed with ≥ M commits: prepay shared by the committers)', {
        failStage: 'commit', forfeit: 'committers',
      });
    }
    if (dispatched.length > 0 && committed.length === 0) {
      // Every drawn arbiter is still docked points.nocommit by the keeper (unless
      // frozen at the round end); the classification only keeps these rounds out
      // of the arbiter-failure count, since a request every node rejects is
      // usually unusable.
      return out('malformed', 'LIKELY MALFORMED (no arbiter committed; each drawn arbiter still loses the no-commit timeliness penalty unless frozen at the round end)', { failStage: 'commit' });
    }
    // _settle charges T_NOCOMMIT_FAILED to every slot without a commit, including
    // slots skipped at the draw (key set, flags 0)
    return out('failed', `FAILED (commit phase: ${committed.length}/${M} commits)`, {
      failStage: 'commit',
      blame: notCommitted.map((s) => ({
        slot: s.slot, stage: 'commit', ...(s.dispatched ? {} : { skipped: s.skipReason || 'skipped at the draw' }),
      })),
    });
  }
  if (fp === PHASE.CLOSING) {
    return out('notProgressed', 'NOT PROGRESSED (commit window closed, never promoted: prepay shared by the committers)', {
      failStage: 'closing', forfeit: 'committers',
    });
  }
  return out('failed', `FAILED (reveal phase: ${counted.length}/${N} reveals)`, {
    failStage: 'reveal',
    blame: promoted.filter((s) => !s.revealed).map((s) => ({ slot: s.slot, stage: 'reveal' })),
  });
}

/**
 * The keeper outcome _settle reports for one slot, and the score change
 * applyOutcomes would make from it. Mirrors ReputationAggregator._settle and
 * ReputationKeeper.applyOutcomes; pure.
 *
 * @param {object} p
 * @param {number} p.settlePhase  the round's phase when it was settled: 3 commit,
 *   4 closing, 5 reveal (from EvaluationFailed at settlement), or 6 final (it
 *   settled as finished). Draw / beacon failures are never settled.
 * @param {number} p.commits  commits the round received
 * @param {number} p.M        commits required
 * @param {number} p.flags    the slot's flags
 * @param {number} [p.qcode]  the slot's quality code (1 close, 2 off, 3 far)
 * @param {object} p.points   keeper points() (gain, minor, major, fail, nocommit, start, cap)
 * @returns {{ code, codeName, committed, tDelta, qDelta, scored, frozenSkip, note }}
 *   code includes the C_COMMITTED bit (0x80) and the quality bits (q << 4).
 *   tDelta / qDelta are the expected changes before the cap and before a score
 *   that reaches 0 restarts at `start` (which also blocks the arbiter).
 *   frozenSkip: the keeper skips this outcome (OutcomeSkippedFrozen) if the
 *   arbiter was frozen at the round end — true only for a scored slot without a commit.
 */
function slotOutcome({ settlePhase, commits, M, flags, qcode = 0, points }) {
  const f = decodeSlotFlags(flags);
  const ph = Number(settlePhase);
  const failed = ph !== PHASE.FINAL;
  let code = CODE.NONE;
  if (ph === PHASE.COMMIT) {
    // -nocommit only to a dispatched slot that did not commit, only if the round failed for lack of
    // commits (not for want of a closeCommits call), and only if at least half of M committed
    // (ReputationAggregator.settle; review 2026-11-26 #7)
    const c = Number(commits);
    if (f.dispatched && !f.committed && c < Number(M) && 2 * c >= Number(M)) code = CODE.NOCOMMIT_FAILED;
  } else if (ph === PHASE.CLOSING) {
    code = CODE.NONE;   // enough commits arrived; nobody promoted, so nobody failed to deliver
  } else if (f.promoted) {
    if (f.revealed) code = failed ? CODE.DELIVERED : CODE.DELIVERED | ((Number(qcode) & 3) << 4);
    else code = failed ? CODE.MISS_FAILED : CODE.MISS_FINISHED;
  }
  if (code !== CODE.NONE && f.committed) code |= CODE.COMMITTED;

  const te = code & 0x0f;
  const qe = (code >> 4) & 0x03;
  const tDelta = { 1: points.gain, 2: -points.major, 3: -points.fail, 4: -points.nocommit }[te] ?? 0;
  const qDelta = { 1: points.gain, 2: -points.minor, 3: -points.major }[qe] ?? 0;
  const scored = code !== CODE.NONE;
  const frozenSkip = scored && !f.committed;
  let note = null;
  if (!scored) {
    note = ph === PHASE.CLOSING || (ph === PHASE.COMMIT && Number(commits) >= Number(M))
      ? 'not scored: the round had enough commits but was never promoted'
      : ph === PHASE.COMMIT && !f.dispatched
        ? 'not scored: the job was never dispatched to this slot'
        : ph === PHASE.COMMIT && !f.committed && 2 * Number(commits) < Number(M)
          ? 'not scored: fewer than half of M committed (the request\'s or a shared failure)'
          : 'not scored';
  } else if (frozenSkip) {
    note = 'skipped by the keeper if the arbiter was frozen at the round end';
  }
  return {
    code,
    codeName: CODE_NAMES[te] || String(te),
    committed: f.committed,
    tDelta,
    qDelta,
    scored,
    frozenSkip,
    note,
  };
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
  CODE,
  CODE_NAMES,
  slotOutcome,
};
