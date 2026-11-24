// The other listings of a listing's repository (node P35; claim test, item 3), as the site's pages show them. The feed
// gives each entry's list (sameRepository). A listing's own page reads its version's record, whose sameRepository holds
// the other versions and whose listings, counted or apart, hold the others of this version, at this version's commit.
// One list either way: each other listing once, oldest first, never the listing itself. An answer from a server
// before node P35 has no sameRepository: then the record's own listings, or nothing, and never a failure.
//
// Node P42: each carries `heldAt`, the time its maker put it on hold (unix seconds) while it is on hold, else null:
// the server's field (node P40). A listing on hold is Open or Depleted on-chain and takes no commit, so its state
// alone does not say it. The server says it on a feed entry's and a record's sameRepository and on a record's
// listings shown apart; a record's own counted listings have it in their labels, since `record` is the lens's answer.
// An answer without the field reads as not on hold.

const byId = (a, b) => (BigInt(a.listingId) < BigInt(b.listingId) ? -1 : BigInt(a.listingId) > BigInt(b.listingId) ? 1 : 0);
const item = ({ listingId, baseCommit, state, lapsed, heldAt, counted }) => ({ listingId: String(listingId), baseCommit, state, lapsed: Boolean(lapsed), heldAt: heldAt ?? null, counted: Boolean(counted), page: `#/fund/${listingId}` });
const related = (list) => (Array.isArray(list) ? list.map((x) => item({ ...x, baseCommit: x.artifact?.baseCommit ?? null })) : []);

/** A feed entry's other listings of its repository. */
export function otherListingsOfFeedEntry(entry) {
  return related(entry?.sameRepository).filter((x) => x.listingId !== String(entry.listingId)).sort(byId);
}

/**
 * A listing's other listings of its repository, from its version's record answer (GET /api/records/:hash).
 * @param {object|null} answer
 * @param {string} listingId - the listing whose page this is
 */
export function otherListingsOfRecord(answer, listingId) {
  if (!answer) return [];
  const id = String(listingId);
  const commit = answer.artifact?.baseCommit ?? null;
  const own = [
    ...(answer.record?.listings ?? []).map((l) => item({ ...l, baseCommit: commit, heldAt: answer.labels?.listings?.[String(l.listingId)]?.heldAt, counted: true })),
    ...(answer.notCounted?.listings ?? []).map((l) => item({ ...l, baseCommit: commit, counted: false })),
  ];
  const seen = new Set();
  return [...own, ...related(answer.sameRepository)]
    .filter((x) => x.listingId !== id && !seen.has(x.listingId) && seen.add(x.listingId))
    .sort(byId);
}
