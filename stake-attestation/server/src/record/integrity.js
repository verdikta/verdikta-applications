// Claims that failed an integrity check (owner decision Q35, design §9.5). On-chain they are DUPLICATE:
// bond back, no award. The chain does not store why, so the record reads it from the justification and
// keeps them apart from the other duplicates, per listing. This is the fold, over the indexed events and
// the store's readings (src/site/evidence.js): no fetch, and nothing here can fail for what an upload says.
//
// A claim counts as having failed integrity only when all of these hold:
//
//   - the chain says so first: its Settled event says DUPLICATE, whatever any text says
//   - its last verdict's CID list is well formed and bounded
//   - every CID on that list has been read: the aggregator joins the clustered oracles', and reading
//     only the first would let that one arbiter move the count
//   - every one says DUPLICATE (integrity) and names the same checks. Report hashes are not compared,
//     since a hash can differ between hosts (the limit recorded as P1 in verdikta/verdikta-arbiter#137)
//
// Anything else is a plain DUPLICATE. `unread` and `disagree` say how many of those are so because a
// justification could not be read, or the arbiters' differ: the count is short by at most those.
import { INTEGRITY_NOTE, justificationCidsOf } from '@verdikta/stake-attestation-shared';

import { codeReview } from '../common.js';
import { assertWording } from '../wording.js';

export const integrityNote = assertWording(INTEGRITY_NOTE);

/** The record reads only these: a settled claim, with the outcome only the chain can state. */
export const isSettledDuplicate = (claim) => claim.state === 'Settled' && claim.outcome === 'DUPLICATE';

const FAILED = 'failed';
const PLAIN = 'plain';
const UNREAD = 'unread';
const DISAGREE = 'disagree';

/** What the store's readings say of one settled DUPLICATE. */
function classify(claim, readings) {
  const cids = justificationCidsOf(claim.justificationCid);
  if (!cids) return { kind: UNREAD };
  const said = cids.map((cid) => readings[cid]);
  if (said.some((reading) => !reading?.says)) return { kind: UNREAD };
  const [first] = said;
  if (said.every((reading) => reading.says === 'other' && reading.settlement === first.settlement)) return { kind: PLAIN };
  const agree = said.every((reading) => reading.says === 'integrity' && reading.checks.join() === first.checks?.join());
  return agree ? { kind: FAILED, checks: first.checks } : { kind: DISAGREE };
}

const tally = () => ({ failed: 0, byCheck: new Map(), otherDuplicates: 0, unread: 0, disagree: 0 });

function add(t, { kind, checks }) {
  if (kind === FAILED) {
    t.failed += 1;
    for (const check of checks) t.byCheck.set(check, (t.byCheck.get(check) ?? 0) + 1);
    return;
  }
  t.otherDuplicates += 1;
  if (kind === UNREAD) t.unread += 1;
  if (kind === DISAGREE) t.disagree += 1;
}

const counts = ({ byCheck, ...t }) => ({
  ...t,
  checks: codeReview.INTEGRITY_CHECKS.filter((check) => byCheck.has(check)).map((check) => ({ check, count: byCheck.get(check) })),
});

/**
 * @param {object} o
 * @param {Iterable<object>} o.claims - the projection's claims at the answer's block
 * @param {Record<string, object>} [o.readings] - the store's evidence (a state file from before it has none)
 * @param {string[]} o.listingIds - the listings to answer for
 * @returns {Record<string, { failed: number, checks: { check: string, count: number }[], otherDuplicates: number, unread: number, disagree: number, late: object }>}
 *   per listing; a late claim counts under `late`, as the chain counts it under later
 */
export function integrityByListing({ claims, readings = {}, listingIds }) {
  const byListing = new Map(listingIds.map((id) => [id, { main: tally(), late: tally() }]));
  for (const claim of claims) {
    const entry = byListing.get(claim.listingId);
    if (entry && isSettledDuplicate(claim)) add(claim.late ? entry.late : entry.main, classify(claim, readings));
  }
  return Object.fromEntries([...byListing].map(([id, { main, late }]) => [id, { ...counts(main), late: counts(late) }]));
}
