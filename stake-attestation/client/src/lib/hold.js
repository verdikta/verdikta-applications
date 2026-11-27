// The maker's hold (StakeAttestation.hold, node P39), as a listing's own page reads and offers it (node P42). A hold
// stops new commits on a listing at once and leaves its pending claims alone; it is one-way, and ends in a roll
// forward or a close. It is not a state: a listing on hold stays Open or Depleted, and the contract's heldAt view
// says since when, or 0.
//
// The site is also used against a contract deployed before the hold, which has neither hold() nor heldAt(). There the
// call is refused: the contract has no such function, so the EVM reverts, with the reason of the contract's own
// fallback. That refusal, and only that, reads as "no hold here": the page then offers none and says what it said. A
// read that fails any other way (the node, the network, a timeout, any other error) is a failed read, as any of the
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
 * What a node says of a call the contract deployed before the hold refuses, where it hands over no revert data: the
 * JSON-RPC code of an execution revert, and the reason of the contract's own fallback (its lens's
 * revert("unknown function")), as the node words a revert with a reason.
 */
const LEGACY_REFUSAL = Object.freeze({ code: 3, message: 'execution reverted: unknown function' });

/**
 * Whether a failed call was refused by the contract: the EVM ran it and reverted. ethers reports EVERY JSON-RPC error
 * on an eth_call as CALL_EXCEPTION (a rate limit and a block the node does not have included), so that code alone
 * says nothing. A refusal is known in two ways, and in no other:
 *   1. by the revert's data, which ethers keeps when the node handed it over;
 *   2. with no data, by the node's own error (where ethers puts it for the reader and for a wallet's provider alike:
 *      err.info.error) having that one code and that one whole message. It is the contract's own reason: no failure
 *      of a node or of a network says it, and a contract that has heldAt never reaches that fallback for it.
 * Both are compared as they are. No other code, no other reason, no part of a message, nothing nested in a wallet's
 * own error and no other wording is a refusal: each of those is a failed read.
 * @param {unknown} err - what a contract call threw
 */
export function refusedByContract(err) {
  if (err?.code !== 'CALL_EXCEPTION') return false;
  if (typeof err.data === 'string') return true;
  const said = err.info?.error;
  return said?.code === LEGACY_REFUSAL.code && said.message === LEGACY_REFUSAL.message;
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
