// The other listings of a repository (node P35; claim test, item 3). A listing covers one version, a repository at one
// commit, and nothing on-chain relates two listings of one repository unless one rolled forward to the other: a hunter
// who found two in the feed could not tell how they relate. So a feed entry names every other listing the site
// indexed whose artifact.repo is its own, and a record every listing of its repository on another version (its own
// version's are its listings, counted or apart). The repository is the Listed event's string exactly as stored: no
// case, trailing slash or ".git" is folded, since nothing on-chain says two spellings are one repository.
//
// Only listings that opened, as everywhere else on the site (the feed's candidates, the record's listings, the
// archives read): one that never opened takes no claims, has no record and never counts, and anyone can make one for
// the gas of list(), so naming them would let anyone pad every entry of a repository and the reads behind it.
//
// Each one is shown with its state and lapsed as getListing has them at the answer's block, as the feed reads its own
// entries (feed.js); whether it counts is decided when the answer is made (site/index.js), as the record decides it
// for its own listings.
import { outputJson } from '../chain/codec.js';

const byId = (a, b) => (BigInt(a.listingId) < BigInt(b.listingId) ? -1 : BigInt(a.listingId) > BigInt(b.listingId) ? 1 : 0);

/** A listing's state and lapsed from its getListing at a block: lapsed as StakeAttestation.isLapsed has it. */
export function stateAt(onchain, block) {
  const fundedUntil = Number(onchain.fundedUntil);
  return { state: onchain.state, lapsed: fundedUntil !== 0 && block.timestamp >= fundedUntil };
}

/**
 * Reads listings' states at one block, each listing once.
 * @param {(fn: string, args: unknown[]) => Promise<import('ethers').Result>} read - the contract at `block`
 * @param {{ timestamp: number }} block
 * @param {Map<string, { state: string, lapsed: boolean }>} [known] - states already read at this block
 * @returns {(listingId: string) => Promise<{ state: string, lapsed: boolean }>}
 */
export function stateReader(read, block, known = new Map()) {
  return async (listingId) => {
    if (!known.has(listingId)) known.set(listingId, stateAt(outputJson('getListing', (await read('getListing', [listingId]))[0]), block));
    return known.get(listingId);
  };
}

/**
 * The listings of `repo` that opened, but those `except` leaves out, oldest first, each without whether it counts.
 * @param {object} o
 * @param {Map<string, object>} o.listings - the projection's (projection.js)
 * @param {string} o.repo - an artifact.repo, as a Listed event stored it
 * @param {(l: object) => boolean} o.except
 * @param {(listingId: string) => Promise<{ state: string, lapsed: boolean }>} o.stateOf
 * @returns {Promise<{ listingId: string, artifactHash: string, artifact: object, state: string, lapsed: boolean, page: string }[]>}
 */
export async function sameRepository({ listings, repo, except, stateOf }) {
  const out = [];
  for (const l of [...listings.values()].filter((x) => x.opened && x.artifact.repo === repo && !except(x)).sort(byId)) {
    const { state, lapsed } = await stateOf(l.listingId);
    out.push({ listingId: l.listingId, artifactHash: l.artifactHash, artifact: { ...l.artifact }, state, lapsed, page: `/#/fund/${l.listingId}` });
  }
  return out;
}

/** The items as an answer shows them: whether each counts now, beside its state. */
export const withCounted = (items, counts) => items.map(({ page, ...x }) => ({ ...x, counted: counts(x.listingId), page }));
