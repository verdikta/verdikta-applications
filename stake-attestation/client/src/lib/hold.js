// The maker's hold (StakeAttestation.hold, node P39), as a listing's own page reads and offers it (node P42). A hold
// stops new commits on a listing at once and leaves its pending claims alone; it is one-way, and ends in a roll
// forward or a close. It is not a state: a listing on hold stays Open or Depleted, and the contract's heldAt view
// says since when, or 0.
//
// The site is also used against a contract deployed before the hold, which has neither hold() nor heldAt(). There the
// call is refused: the contract has no such function, so the EVM reverts. That, and only that, reads as "no hold
// here": the page then offers none and says what it said. A read that fails any other way (the node, the network, a
// timeout) is a failed read, as any of the page's reads, and never "not on hold".
import { LISTING_STATES } from '../chain/abi.js';

const stateOf = (l) => LISTING_STATES[Number(l.state)];
/** StakeAttestation.hold and rollForward take an Open or a Depleted listing, and heldAt answers for no other. */
const HOLDABLE = new Set(['Open', 'Depleted']);

/** What a contract with no hold answers to: never on hold, and no hold to offer. */
export const NO_HOLD = Object.freeze({ supported: false, heldAt: 0n });

/** Every text a node's error holds: its message, its data when that is text, and those nested in it (a wallet wraps its node's answer). */
function textsOf(value, depth = 0) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value).flatMap((v) => textsOf(v, depth + 1));
}

/**
 * Whether a failed call was refused by the contract: the EVM ran it and reverted. ethers reports EVERY JSON-RPC error
 * on an eth_call as CALL_EXCEPTION (a rate limit and a block the node does not have included), so that code alone
 * says nothing. A revert is known by what the node reported: the revert's data, which ethers keeps only when the
 * node's own message says "revert" (empty, "0x", for a function the contract does not have), or, from a node that
 * gives an empty revert no data at all or words it elsewhere, the node's own text saying it reverted.
 * @param {unknown} err - what a contract call threw
 */
export function refusedByContract(err) {
  if (err?.code !== 'CALL_EXCEPTION') return false;
  if (typeof err.data === 'string') return true;
  return textsOf(err.info?.error).some((t) => /\brevert/i.test(t));
}

/**
 * The contract's heldAt view for a listing: the time of the hold while the listing is on hold, else 0.
 * @param {{ heldAt: Function }} sa - StakeAttestation on a reader (chain/wallet.js stakeAttestation)
 * @param {bigint|string|number} listingId
 * @param {object} [overrides] - the call's overrides: { blockTag }, the block the listing was read at
 * @returns {Promise<{ supported: boolean, heldAt: bigint }>} supported false: a contract with no hold (NO_HOLD).
 *   Rejects when the read failed any other way.
 */
export async function readHold(sa, listingId, overrides = {}) {
  try {
    return { supported: true, heldAt: BigInt(await sa.heldAt(BigInt(listingId), overrides)) };
  } catch (err) {
    if (refusedByContract(err)) return NO_HOLD;
    throw err;
  }
}

/**
 * The hold as the page states it, from getListing's answer and readHold's at the same block. `heldHere` is the time of
 * a hold this page sent and saw mined (the receipt's Held event): the site's reader may be a block behind the wallet's
 * node, and a read from before the hold must not put the action back on the page. A hold has no resume, so that time
 * stands for as long as the listing is Open or Depleted; the chain's own time replaces it once a read has it.
 * @param {object} listing - getListing's answer
 * @param {{ supported: boolean, heldAt: bigint }} read - readHold's answer
 * @param {bigint|null} [heldHere]
 * @returns {{ supported: boolean, heldAt: bigint, held: boolean }} heldAt 0 and held false when not on hold
 */
export function holdView(listing, read, heldHere = null) {
  const here = heldHere === null ? 0n : BigInt(heldHere);
  let heldAt = 0n;
  // as the contract's view: a hold ends when the listing is Rolled or Closed
  if (HOLDABLE.has(stateOf(listing))) heldAt = read.heldAt !== 0n ? read.heldAt : here;
  return { supported: read.supported || here !== 0n, heldAt, held: heldAt !== 0n };
}

/**
 * hold(): the maker's, once, on an Open or a Depleted listing (ClaimLogic.hold: "not rollable", "already held").
 * Neither a pending claim nor an owed award holds it back. The maker is checked where the wallet is known.
 * @param {object} listing - getListing's answer
 * @param {{ supported: boolean, heldAt: bigint }} hold - readHold's answer, or holdView's
 * @returns {{ can: boolean, why: null|'unsupported'|'state'|'held' }}
 */
export function holdTerms(listing, hold) {
  let why = null;
  if (!hold.supported) why = 'unsupported';
  else if (!HOLDABLE.has(stateOf(listing))) why = 'state';
  else if (hold.heldAt !== 0n) why = 'held';
  return { can: why === null, why };
}
