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

/**
 * Where a claim that is still to be revealed stands in its listing's commit order (decision D5;
 * ClaimLogic.revealDeadline). Claims on a listing reveal in the order they were committed: one behind
 * the listing's headClaim cannot be revealed, and has no reveal deadline, until every earlier claim is
 * settled or expired, whatever its own fix window says and whether or not the maker releases it.
 * Null once the claim is revealed, settled or expired: the page then has nothing to say of its reveal
 * (a revealed claim keeps the head until it is settled or expired, and a later claim's own page says so).
 *
 * The lens gives a reveal deadline only to a disclosed claim at the head (claimTimes): the later of
 * its fix window's end and the moment it became first, plus the reveal window. While its fix window
 * is open that is the latest it can be (`firm` false): a release or a roll-forward ends the window
 * sooner, and the deadline moves with it. From the deadline on anyone may expire the claim (`over`).
 *
 * An undisclosed claim past its disclose window (`undisclosedOver`) can never be revealed: disclose()
 * refuses it, and anyone may expire it whatever its place in the order (erratum E5).
 * @param {{ claimId: bigint, state: string, disclosedAt: bigint, headClaim: bigint, discloseDeadline: bigint, revealDeadline: bigint, now: bigint }} o
 *   state is the lens's claimState name, headClaim getListing's, the two deadlines claimTimes' (revealDeadline 0 while unknown)
 * @returns {null | { waitsFor: bigint|null, disclosed: boolean, undisclosedOver: boolean, deadline: null|{ at: bigint, firm: boolean, over: boolean } }}
 */
export function queueView({ claimId, state, disclosedAt, headClaim, discloseDeadline, revealDeadline, now }) {
  if (state !== 'Committed' && state !== 'Revealable') return null;
  const disclosed = disclosedAt !== 0n;
  const waitsFor = headClaim !== 0n && headClaim !== claimId ? headClaim : null;
  const known = disclosed && revealDeadline !== 0n;
  return {
    waitsFor,
    disclosed,
    undisclosedOver: !disclosed && now >= discloseDeadline,
    deadline: known ? { at: revealDeadline, firm: state === 'Revealable', over: now >= revealDeadline } : null,
  };
}

/**
 * The claim page's two rows for queueView's answer, each a key of STRINGS.claim with what fills it:
 * `order`, the claim's place, and `reveal`, its reveal deadline (none for an undisclosed claim).
 * `rollable`: the listing can still roll forward (Open or Depleted; StakeAttestation.rollForward), the
 * one thing besides a release that ends a fix window early.
 * @param {ReturnType<typeof queueView>} q
 * @param {{ rollable: boolean }} o
 * @returns {{ order: null|{ key: string, head?: bigint }, reveal: null|{ key: string, at?: bigint } }}
 */
export function queueRows(q, { rollable }) {
  if (!q) return { order: null, reveal: null };
  if (q.undisclosedOver) return { order: { key: 'queueUndisclosedOver' }, reveal: null };
  const order = q.waitsFor === null ? { key: 'queueFirst' } : { key: 'queueWaits', head: q.waitsFor };
  if (!q.disclosed) return { order, reveal: null };
  if (q.deadline === null) return { order, reveal: { key: 'revealUnset' } };
  const { at, firm, over } = q.deadline;
  let key = 'revealFirm';
  if (over) key = 'revealOver';
  else if (!firm) key = rollable ? 'revealLatest' : 'revealLatestRelease';
  return { order, reveal: { key, at } };
}

/**
 * A claim whose round ended with no verdict (RoundFailed; erratum E6): the hunter may send the round
 * again before the lens's retriggerDeadline, and from it on anyone may expire the claim, which is what
 * takes it out of the commit order a later claim waits in.
 * @param {{ state: string, retriggerDeadline: bigint, now: bigint }} o
 * @returns {null | { key: 'retriggerUntil'|'retriggerOver', at: bigint }}
 */
export function retriggerRow({ state, retriggerDeadline, now }) {
  if (state !== 'RoundFailed' || retriggerDeadline === 0n) return null;
  return { key: now < retriggerDeadline ? 'retriggerUntil' : 'retriggerOver', at: retriggerDeadline };
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
