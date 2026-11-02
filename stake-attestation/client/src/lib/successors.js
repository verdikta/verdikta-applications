// Roll forward (design §7.1, §13.2): the successor is the maker's own listing of the fixed
// version, already open (listed and funded on its own). The page offers the feed's listings by
// the same maker of the same artifact, a repository (and kind) at another commit, and confirms
// each on-chain as rollForward requires: Open, the maker's, without a predecessor, not itself.
import { LISTING_STATES } from '../chain/abi.js';

const OPEN = BigInt(LISTING_STATES.indexOf('Open'));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {object[]} feed - GET /api/feed's listings
 * @param {{ listingId: bigint|string, maker: string, kind: string, repo: string|null }} listing - kind as the feed names it (Repo, Contract)
 */
export function successorCandidates(feed, { listingId, maker, kind, repo }) {
  if (!repo) return [];
  return feed.filter((e) => e.listingId !== String(listingId) && same(e.maker, maker) && e.artifact.kind === kind && e.artifact.repo === repo);
}

/**
 * @param {{ state: bigint, maker: string, predecessor: bigint }} successor - getListing(successorId)
 * @param {{ successorId: bigint, listingId: bigint, account: string }} o
 */
export function confirmSuccessor(successor, { successorId, listingId, account }) {
  return successorId !== listingId && successor.state === OPEN && same(successor.maker, account) && successor.predecessor === 0n;
}
