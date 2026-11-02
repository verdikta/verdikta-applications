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
