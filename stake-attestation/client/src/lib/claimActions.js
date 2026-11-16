// Which of the maker's actions the claim page offers (design §13.2), by the contract's own rules
// (ClaimLogic.release and ClaimLogic.dispute) and the lens's times, all on the chain's clock. The
// contract decides in the end: the page re-reads the claim just before it sends anything.
import { OUTCOMES } from '../chain/abi.js';

const LOW = OUTCOMES.indexOf('LOW');

/**
 * release(): the claim is disclosed and its fix window still open (the lens's claimState is
 * Committed until revealableAt; a released, rolled or ended window reads Revealable or later).
 * @param {{ disclosedAt: bigint, state: string, revealableAt: bigint, now: bigint }} o - state is the lens's claimState name
 * @returns {{ offer: boolean, why: null|'notDisclosed'|'windowOver', until: bigint|null }}
 */
export function releaseOffer({ disclosedAt, state, revealableAt, now }) {
  if (disclosedAt === 0n) return { offer: false, why: 'notDisclosed', until: null };
  if (state !== 'Committed' || now >= revealableAt) return { offer: false, why: 'windowOver', until: null };
  return { offer: true, why: null, until: revealableAt };
}

/**
 * dispute(): a judged valid outcome (LOW..CRITICAL), not disputed yet, before the lens's
 * disputeDeadline (judgedAt + disputeWindow; 0 when no dispute is possible).
 * @param {{ state: string, outcome: string, dispute: string, deadline: bigint, now: bigint }} o
 * @returns {{ offer: boolean, why: null|'notJudged'|'notValid'|'disputed'|'windowOver', until: bigint|null }}
 */
export function disputeOffer({ state, outcome, dispute, deadline, now }) {
  const no = (why) => ({ offer: false, why, until: null });
  if (dispute !== 'None') return no('disputed');
  if (state !== 'Judged') return no('notJudged');
  if (OUTCOMES.indexOf(outcome) < LOW) return no('notValid');
  if (deadline === 0n || now >= deadline) return no('windowOver');
  return { offer: true, why: null, until: deadline };
}

/** The round a claim in `state` waits for: its own ('claim'), a dispute's ('dispute'), or none. */
export function pendingRound(state) {
  if (state === 'Revealed') return 'claim';
  if (state === 'Disputed') return 'dispute';
  return null;
}

/**
 * Whether the round a watch of `kind` waits for is over in this read of the claim: a claim round
 * once the claim left Revealed; a dispute round once the claim records a dispute (a read that
 * does not yet show the maker's dispute is stale, not over) and has left Disputed.
 * @param {'claim'|'dispute'} kind
 * @param {{ state: string, dispute: string }} claim - the lens's state name and DisputeResult name
 */
export function roundOver(kind, { state, dispute }) {
  if (kind === 'claim') return state !== 'Revealed';
  return dispute !== 'None' && state !== 'Disputed';
}

const VERDICT = new Set(['Held', 'Overturned']);
// ClaimRules.THRESHOLD and a point of mass (design §13.2, erratum E8: 1% of SCORE_SCALE)
const THRESHOLD = 500_001n;
const POINT = 10_000n;

/**
 * What the claim page says of the settlement safeguards (design §13.2, errata E7-E9), from one
 * block's reads: the claim's fields and the lens's appealDeadline, settleableAt, retriggerDeadline,
 * confirmWindow and judgeVector (its `narrow` and `awardWei` for the claim's vector), with the
 * listing's confirmAboveWei. A bond is stated only once settle has moved it, by settle's rule.
 * @param {{ state: string, outcome: string|null, dispute: string, disputeKind: string, late: boolean, now: bigint,
 *   appealDeadline: bigint, settleableAt: bigint, retriggerDeadline: bigint, confirmOpensAt: bigint, confirmDeadline: bigint,
 *   narrow: boolean|null, awardWei: bigint, confirmAboveWei: bigint }} o
 * @returns {{ roundKind: string, appeal: null|{ open: boolean, until: bigint }, appealRetrigger: null|{ until: bigint },
 *   waiver: boolean, confirmation: null|{ state: string, opensAt: bigint|null, deadline: bigint|null },
 *   narrow: boolean|null, bond: null|'returned'|'returnedNarrow'|'forfeited' }}
 */
export function safeguardView(o) {
  const judged = o.state === 'Judged';
  const invalid = o.outcome === 'INVALID';
  // the lens's appealDeadline is non-zero only for a claim round's INVALID no panel round judged
  const appeal = judged && invalid && o.disputeKind === 'None' && o.appealDeadline !== 0n
    ? { open: o.now < o.appealDeadline, until: o.appealDeadline }
    : null;
  const appealRetrigger = judged && o.disputeKind === 'Appeal' && o.dispute === 'NoVerdict' && o.retriggerDeadline !== 0n
    ? { until: o.retriggerDeadline }
    : null;
  // until settleableAt only the hunter may settle an INVALID, and that waives the appeal (or its re-trigger)
  const waiver = judged && invalid && o.settleableAt > o.now;

  let confirmation = null;
  if (o.confirmDeadline !== 0n) {
    let state = 'closed';
    // a round of the dispute panel is open: the confirmation's, or a maker's dispute that may be it
    if (o.state === 'Disputed') state = 'pending';
    else if (o.now < o.confirmOpensAt) state = 'awaiting';
    else if (o.now < o.confirmDeadline) state = 'open';
    confirmation = { state, opensAt: o.confirmOpensAt, deadline: o.confirmDeadline };
  } else if (o.disputeKind === 'Confirmation' && VERDICT.has(o.dispute)) {
    confirmation = { state: o.dispute === 'Held' ? 'held' : 'overturned', opensAt: null, deadline: null };
  } else if (o.state === 'Settled' && !o.late && !VERDICT.has(o.dispute) && o.awardWei > o.confirmAboveWei) {
    // ClaimRules.awaitsConfirmation at settle: no panel verdict, so it paid from the deadline
    confirmation = { state: 'noVerdict', opensAt: null, deadline: null };
  }

  let bond = null;
  if (o.state === 'Settled') bond = invalid ? (o.narrow ? 'returnedNarrow' : 'forfeited') : 'returned';
  return { roundKind: o.disputeKind, appeal, appealRetrigger, waiver, confirmation, narrow: invalid ? o.narrow : null, bond };
}

/**
 * A listing's two safeguard terms, fixed at list() (errata E8, E9): its narrow-INVALID band, empty at
 * THRESHOLD, with its floor in points; and its confirmation size, `all` at 0 (every counted award waits).
 * @param {{ narrowInvalidFloor: bigint, confirmAboveWei: bigint }} l - getListing's
 */
export function safeguardTerms({ narrowInvalidFloor, confirmAboveWei }) {
  const floor = BigInt(narrowInvalidFloor);
  const empty = floor >= THRESHOLD;
  let points = null;
  if (!empty) {
    const whole = floor / POINT;
    const rest = (floor % POINT).toString().padStart(4, '0').replace(/0+$/, '');
    points = rest ? `${whole}.${rest}` : String(whole);
  }
  const size = BigInt(confirmAboveWei);
  return { band: { empty, floor, points }, size: { all: size === 0n, wei: size } };
}
