// The maker's hold (StakeAttestation.hold, node P39), as a listing's own page reads and offers it (node P42). A hold
// stops new commits on a listing at once and leaves its pending claims alone; it is one-way, and ends in a roll
// forward or a close. It is not a state: a listing on hold stays Open or Depleted, and the contract's heldAt view
// says since when, or 0.
//
// The site is also used against a contract deployed before the hold, which has neither hold() nor heldAt(). There the
// call is refused: the contract has no such function, so the EVM reverts, and the node hands over the revert's data.
// That, and only that, reads as "no hold here": the page then offers none and says what it said. A read that fails
// any other way (the node, the network, a timeout, an error with no revert data) is a failed read, as any of the
// page's reads, and never "not on hold".
//
// That a listing is on hold is said from this read alone, made with the listing in one snapshot of one block
// (chain/snapshot.js): never from the receipt of a hold the page sent (lib/pageSays.js).
import { LISTING_STATES } from '../chain/abi.js';

const stateOf = (l) => LISTING_STATES[Number(l.state)];
/** StakeAttestation.hold and rollForward take an Open or a Depleted listing, and heldAt answers for no other. */
const HOLDABLE = new Set(['Open', 'Depleted']);

/** What a contract with no hold answers to: never on hold, and no hold to offer. */
export const NO_HOLD = Object.freeze({ supported: false, heldAt: 0n, held: false });

/**
 * Whether a failed call was refused by the contract: the EVM ran it and reverted. ethers reports EVERY JSON-RPC error
 * on an eth_call as CALL_EXCEPTION (a rate limit and a block the node does not have included), so that code alone
 * says nothing. A revert is known by the contract's own revert data, and by nothing else: ethers keeps that data only
 * when the node handed it over with a message that says "revert". The contract deployed before the hold answers a
 * function it does not have through its lens's fallback, revert("unknown function"), so the data is there. No word
 * of a node's or a wallet's error is read: an error that only says "revert" somewhere, with no data, is a failed read.
 * @param {unknown} err - what a contract call threw
 */
export function refusedByContract(err) {
  return err?.code === 'CALL_EXCEPTION' && typeof err.data === 'string';
}

/**
 * The contract's heldAt view for a listing: the time of the hold while the listing is on hold, else 0. The view
 * itself answers 0 for a listing that is neither Open nor Depleted: a hold ends when the listing is Rolled or Closed.
 * @param {{ heldAt: Function }} sa - StakeAttestation on a snapshot's runner, where the listing is read too
 * @param {bigint|string|number} listingId
 * @returns {Promise<{ supported: boolean, heldAt: bigint, held: boolean }>} supported false: a contract with no hold
 *   (NO_HOLD). Rejects when the read failed any other way.
 */
export async function readHold(sa, listingId) {
  try {
    const heldAt = BigInt(await sa.heldAt(BigInt(listingId)));
    return { supported: true, heldAt, held: heldAt !== 0n };
  } catch (err) {
    if (refusedByContract(err)) return NO_HOLD;
    throw err;
  }
}

/**
 * hold(): the maker's, once, on an Open or a Depleted listing (ClaimLogic.hold: "not rollable", "already held").
 * Neither a pending claim nor an owed award holds it back. The maker is checked where the wallet is known.
 * @param {object} listing - getListing's answer
 * @param {{ supported: boolean, heldAt: bigint }} hold - readHold's answer, of the same block
 * @returns {{ can: boolean, why: null|'unsupported'|'state'|'held' }}
 */
export function holdTerms(listing, hold) {
  let why = null;
  if (!hold.supported) why = 'unsupported';
  else if (!HOLDABLE.has(stateOf(listing))) why = 'state';
  else if (hold.heldAt !== 0n) why = 'held';
  return { can: why === null, why };
}

/**
 * Whether the listing a wallet's node has under an id (`mine`; null: none) is the one a page shows under it: the same
 * maker's, of the same artifact. A hold has no way back, so it is sent only for the listing the page showed the maker.
 */
export function sameListing(mine, shown) {
  const lower = (v) => String(v).toLowerCase();
  return Boolean(mine) && lower(mine.maker) === lower(shown.maker) && lower(mine.artifactHash) === lower(shown.artifactHash);
}
