/**
 * Pure helpers for the v2 ReputationKeeper registry: arbiter flags, the display
 * status derived from them, and reconstruction of the registered set from the
 * keeper's ArbiterRegistered / ArbiterRemoved logs.
 *
 * No I/O here, so the logic is unit-tested directly (test/arbiterStatus.test.js).
 *
 * v2 has no call counts, recent-score history or mild/severe thresholds (v1's
 * inputs to "new" / "unresponsive"). What it has instead:
 *   - flags: 1 registered, 2 paused, 4 banned, 8 exiting, 16 health call pending,
 *     32 under-staked, 64 re-syncing its hash chain;
 *   - blockedUntil (a score reached 0: blocked for lockDuration x 2^offenses);
 *   - the liveness freeze (a health call unanswered for more than callDeadline);
 *   - two scores, quality and timeliness, 0..cap (default 1000), starting at
 *     `start` (500). A score that reaches 0 blocks the arbiter.
 */

const FLAGS = Object.freeze({
  REGISTERED: 1,
  PAUSED: 2,
  BANNED: 4,
  EXITING: 8,
  CALL_PENDING: 16,
  UNDERSTAKED: 32,
  RESYNC: 64,
});

/** Display buckets, in the order the UI shows them. */
const STATUSES = Object.freeze(['active', 'new', 'atRisk', 'frozen', 'blocked', 'inactive']);

/** Selectable buckets: an arbiter in one of these can be drawn for a jury. */
const SELECTABLE = new Set(['active', 'new', 'atRisk']);

/** Keeper defaults (Points struct, callDeadline) for when the config read fails. */
const DEFAULT_POINTS = Object.freeze({ gain: 20, minor: 50, major: 200, fail: 500, nocommit: 400, start: 500, cap: 1000 });
const DEFAULT_CALL_DEADLINE = 60;

function flagNames(flags) {
  const f = Number(flags) || 0;
  return Object.entries(FLAGS).filter(([, bit]) => f & bit).map(([name]) => name.toLowerCase());
}

/**
 * Is the arbiter frozen at `now` (unix seconds)? Mirrors the keeper's _frozenAt:
 * a health call is pending and more than callDeadline has passed since it was
 * sent. A re-sync backdates callSentAt, so a re-syncing arbiter is frozen at once.
 */
function isFrozenAt(a, now, callDeadline = DEFAULT_CALL_DEADLINE) {
  const f = Number(a.flags) || 0;
  return (f & FLAGS.CALL_PENDING) !== 0 && now > Number(a.callSentAt || 0) + Number(callDeadline);
}

/**
 * Derive the display status of one arbiter.
 *
 * @param {object} a  getArbiter() fields as numbers: flags, quality, timeliness,
 *   offenses, blockedUntil, callSentAt, exitAt, plus optional feeWei (bigint) and
 *   frozen (the keeper's isFrozen(), preferred over the local computation).
 * @param {object} ctx { now (unix s), points, callDeadline, maxOracleFeeWei (bigint|null) }
 * @returns {{ status: string, reasons: string[], selectable: boolean }}
 *   `status` is one of STATUSES; `reasons` lists every condition that applies
 *   (most severe first), e.g. ['exiting', 'callPending'], for tooltips/badges.
 *
 * Priority (first match wins for `status`):
 *   banned / blocked              -> 'blocked'
 *   exiting / paused / under-staked / fee above the aggregator's max -> 'inactive'
 *   re-syncing / frozen           -> 'frozen'
 *   quality <= points.major (one far reveal, -major, reaches 0) or
 *   timeliness <= points.nocommit (one failed round without a commit, -nocommit,
 *   reaches 0)                    -> 'atRisk'
 *   both scores still at `start` with no offenses (never scored) -> 'new'
 *   otherwise                     -> 'active'
 *
 * Note that does not change the status:
 *   failMissRisk  timeliness <= points.fail: one promoted miss in a failed round
 *                 (-fail) would block it. With the default points every new
 *                 arbiter (timeliness 500 = fail) carries it and stays 'new'.
 */
function deriveStatus(a, ctx = {}) {
  const now = ctx.now != null ? ctx.now : Math.floor(Date.now() / 1000);
  const points = { ...DEFAULT_POINTS, ...(ctx.points || {}) };
  const callDeadline = ctx.callDeadline != null ? ctx.callDeadline : DEFAULT_CALL_DEADLINE;
  const f = Number(a.flags) || 0;
  const reasons = [];

  if (!(f & FLAGS.REGISTERED)) reasons.push('unregistered');
  if (f & FLAGS.BANNED) reasons.push('banned');
  if (Number(a.blockedUntil || 0) > now) reasons.push('blocked');
  if (f & FLAGS.EXITING) reasons.push('exiting');
  if (f & FLAGS.PAUSED) reasons.push('paused');
  if (f & FLAGS.UNDERSTAKED) reasons.push('understaked');
  if (ctx.maxOracleFeeWei != null && a.feeWei != null && BigInt(a.feeWei) > BigInt(ctx.maxOracleFeeWei)) {
    reasons.push('feeAboveMax');
  }
  if (f & FLAGS.RESYNC) reasons.push('resyncing');
  const frozen = a.frozen != null ? !!a.frozen : isFrozenAt(a, now, callDeadline);
  if (frozen && !(f & FLAGS.RESYNC)) reasons.push('frozen');
  else if (!frozen && (f & FLAGS.CALL_PENDING) && !(f & FLAGS.RESYNC)) reasons.push('callPending');

  const q = Number(a.quality);
  const t = Number(a.timeliness);
  const lowScore = Number.isFinite(q) && Number.isFinite(t) && (q <= points.major || t <= points.nocommit);
  if (lowScore) reasons.push('lowScore');
  if (Number.isFinite(t) && t <= points.fail) reasons.push('failMissRisk');
  const unscored = q === points.start && t === points.start && !Number(a.offenses);
  if (unscored) reasons.push('new');

  const has = (r) => reasons.includes(r);
  let status;
  if (has('banned') || has('blocked')) status = 'blocked';
  else if (has('unregistered') || has('exiting') || has('paused') || has('understaked') || has('feeAboveMax')) status = 'inactive';
  else if (has('resyncing') || has('frozen')) status = 'frozen';
  else if (lowScore) status = 'atRisk';
  else if (unscored) status = 'new';
  else status = 'active';

  return { status, reasons, selectable: SELECTABLE.has(status) };
}

/** Empty per-status tally ({ active: 0, new: 0, ... }). */
function emptyTally() {
  return Object.fromEntries(STATUSES.map((s) => [s, 0]));
}

/**
 * Exit state of an arbiter for the My Arbiters UI.
 * @returns {{ state: 'none'|'unbonding'|'ready'|'blockedUntilFree', exitAt: number, waitSeconds: number }}
 *   'ready': completeExit can be sent now; 'blockedUntilFree': unbonding is over
 *   but completeExit reverts (Blocked) until blockedUntil passes.
 */
function exitState(a, now) {
  const f = Number(a.flags) || 0;
  const exitAt = Number(a.exitAt || 0);
  if (!(f & FLAGS.EXITING)) return { state: 'none', exitAt, waitSeconds: 0 };
  if (now < exitAt) return { state: 'unbonding', exitAt, waitSeconds: exitAt - now };
  const blockedUntil = Number(a.blockedUntil || 0);
  if (blockedUntil > now) return { state: 'blockedUntilFree', exitAt, waitSeconds: blockedUntil - now };
  return { state: 'ready', exitAt, waitSeconds: 0 };
}

/**
 * Rebuild the registered set from keeper logs.
 *
 * @param {Array<{name: 'ArbiterRegistered'|'ArbiterRemoved', key: string, oracle?: string,
 *   jobId?: string, fee?: bigint|string, blockNumber: number, logIndex: number}>} events
 *   in any order.
 * @returns {Map<string, {key, oracle, jobId, fee, registeredBlock}>} keyed by the
 *   lowercased arbiter key, for every key whose latest event is a registration.
 *   (A banned key's completeExit emits ArbiterRemoved too, so a tombstone drops out.)
 */
function reduceRegistry(events) {
  const sorted = [...events].sort((x, y) => (x.blockNumber - y.blockNumber) || (x.logIndex - y.logIndex));
  const live = new Map();
  for (const e of sorted) {
    const k = String(e.key).toLowerCase();
    if (e.name === 'ArbiterRegistered') {
      live.set(k, { key: e.key, oracle: e.oracle, jobId: e.jobId, fee: e.fee, registeredBlock: e.blockNumber });
    } else if (e.name === 'ArbiterRemoved') {
      live.delete(k);
    }
  }
  return live;
}

module.exports = {
  FLAGS,
  STATUSES,
  SELECTABLE,
  DEFAULT_POINTS,
  DEFAULT_CALL_DEADLINE,
  flagNames,
  isFrozenAt,
  deriveStatus,
  emptyTally,
  exitState,
  reduceRegistry,
};
