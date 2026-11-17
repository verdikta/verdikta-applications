// What a maker can do with a listing once it is listed, from getListing's answer, as the contract decides
// it: a top-up (fund() on a listing that has opened), renew() and close(). Pure, so the rules are tested
// without a chain.
import { LISTING_STATES } from '../chain/abi.js';

/** The paid period one listing fee buys: StakeAttestation.LISTING_PERIOD, 30 days. */
export const LISTING_PERIOD = 30 * 86400;

const stateOf = (l) => LISTING_STATES[Number(l.state)];

/**
 * renew(): an Open or Depleted listing's maker pays the listing fee again. It adds LISTING_PERIOD to
 * fundedUntil, or, once the period has lapsed (isLapsed: now >= fundedUntil), runs it from now: a lapsed
 * gap is not bought.
 * @param {object} l - getListing's answer
 * @param {number} now - seconds; the chain's time when known
 * @returns {{ can: boolean, lapsed: boolean, fundedUntil: number, until: number }} `until`: fundedUntil after a renewal sent at `now`
 */
export function renewTerms(l, now) {
  const s = stateOf(l);
  const can = s === 'Open' || s === 'Depleted';
  const fundedUntil = Number(l.fundedUntil);
  const lapsed = can && fundedUntil !== 0 && now >= fundedUntil;
  return { can, lapsed, fundedUntil, until: (fundedUntil > now ? fundedUntil : now) + LISTING_PERIOD };
}

/**
 * close(): the maker ends a listing that is not Closed, has no claim pending (neither settled nor
 * expired) and owes no award; the escrow that is left comes back to the maker.
 * @param {object} l - getListing's answer
 * @returns {{ can: boolean, why: 'closed'|'pending'|'owed'|null, pending: bigint, owedWei: bigint, escrowWei: bigint }}
 */
export function closeTerms(l) {
  const pending = BigInt(l.pendingClaims);
  const owedWei = BigInt(l.owedWei);
  let why = null;
  if (stateOf(l) === 'Closed') why = 'closed';
  else if (pending > 0n) why = 'pending';
  else if (owedWei > 0n) why = 'owed';
  return { can: why === null, why, pending, owedWei, escrowWei: BigInt(l.escrowWei) };
}

/**
 * A top-up: fund() on a listing that has opened (Open, Depleted or Rolled), with no fee. It pays what
 * the listing owes first and escrows the rest. A Depleted listing reopens once nothing is owed and its
 * escrow is back at the top award; a Rolled one stays Rolled.
 * @param {object} l - getListing's answer
 * @returns {{ can: boolean, state: string, escrowWei: bigint, owedWei: bigint, topWei: bigint, toReopenWei: bigint|null }}
 *          `toReopenWei`: for a Depleted listing, the least that reopens it; null for any other
 */
export function topUpTerms(l) {
  const state = stateOf(l);
  const escrowWei = BigInt(l.escrowWei);
  const owedWei = BigInt(l.owedWei);
  const topWei = BigInt(l.awards[3]);
  const short = topWei > escrowWei ? topWei - escrowWei : 0n;
  return {
    can: state === 'Open' || state === 'Depleted' || state === 'Rolled',
    state,
    escrowWei,
    owedWei,
    topWei,
    toReopenWei: state === 'Depleted' ? owedWei + short : null,
  };
}

/**
 * What a top-up of `amountWei` does to the listing, as ClaimLogic.topUp does it.
 * @returns {{ toOwedWei: bigint, toEscrowWei: bigint, escrowAfterWei: bigint, reopens: boolean }}
 */
export function topUpEffect(l, amountWei) {
  const t = topUpTerms(l);
  const amount = BigInt(amountWei);
  const toOwedWei = amount < t.owedWei ? amount : t.owedWei;
  const toEscrowWei = amount - toOwedWei;
  const escrowAfterWei = t.escrowWei + toEscrowWei;
  return { toOwedWei, toEscrowWei, escrowAfterWei, reopens: t.state === 'Depleted' && toOwedWei === t.owedWei && escrowAfterWei >= t.topWei };
}
