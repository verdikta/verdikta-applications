// What the indexed events say, folded once per cursor: the listings (identity, CIDs, whether they
// opened, rolled or closed), the claims (listing, last known state, outcome), where each event
// belongs, and which claims are published.
//
// Publication (design §14): the site publishes only valid findings. A claim is published once it
// settled with an outcome LOW..CRITICAL, the record's findings; every other claim (INVALID,
// DUPLICATE, pending, expired) is a count on the record and nothing more, so wherever the site
// shows its events it shows only the ids. The chain still has everything; the site does not
// republish it.
//
// The claim states here only choose which claims the keeper looks at: it reads each one on-chain
// before it acts.
import { FEED_EVENTS, outcomeRank } from '../chain/abi.js';

const LOW = outcomeRank('LOW');
const FEED = new Set(FEED_EVENTS);

// The claim state each event leaves, in the contract's names (Revealable is never stored).
const CLAIM_STATE = Object.freeze({
  Committed: 'Committed',
  LateClaim: 'Committed',
  Revealed: 'Revealed',
  EvaluationRequested: 'Revealed',
  SubmissionFailed: 'RoundFailed',
  EvaluationFailed: 'RoundFailed',
  Judged: 'Judged',
  Disputed: 'Disputed',
  DisputeJudged: 'Judged',
  DisputeFailed: 'Judged',
  Settled: 'Settled',
  Expired: 'Expired',
});

/** @param {object[]} events - the store's events, in chain order */
export function project(events) {
  const listings = new Map();
  const claims = new Map();
  const listingsByHash = new Map();
  for (const e of events) {
    const a = e.args;
    if (e.name === 'Listed') {
      listings.set(a.listingId, {
        listingId: a.listingId,
        listedTx: e.txHash,
        maker: a.maker,
        artifactHash: a.artifactHash,
        artifact: { kind: a.kind, repo: a.repo, baseCommit: a.baseCommit, chainId: a.chainId, address: a.artifactAddress },
        listingCid: a.listingCid,
        disputeCid: a.disputeCid,
        opened: false,
        rolled: false,
        closed: false,
      });
      if (!listingsByHash.has(a.artifactHash)) listingsByHash.set(a.artifactHash, []);
      listingsByHash.get(a.artifactHash).push(a.listingId);
    } else if (e.name === 'Opened') {
      const l = listings.get(a.listingId);
      if (l) l.opened = true;
    } else if (e.name === 'RolledForward') {
      const l = listings.get(a.listingId);
      if (l) l.rolled = true;
    } else if (e.name === 'Closed') {
      const l = listings.get(a.listingId);
      if (l) l.closed = true;
    }
    if (e.name === 'Committed' || e.name === 'LateClaim') {
      claims.set(a.claimId, { claimId: a.claimId, listingId: a.listingId, late: e.name === 'LateClaim', state: 'Committed', disclosed: false, outcome: null, justificationCid: null, published: false });
    }
    const c = a.claimId !== undefined ? claims.get(a.claimId) : undefined;
    if (!c) continue;
    if (e.name === 'Disclosed') c.disclosed = true;
    if (CLAIM_STATE[e.name]) c.state = CLAIM_STATE[e.name];
    if (e.name === 'Judged' || e.name === 'DisputeJudged') {
      c.outcome = a.outcome;
      // the verdict that stands: a dispute round's replaces the first, and a failed one has no CID
      c.justificationCid = a.justificationCid;
    }
    if (e.name === 'Settled') {
      c.outcome = a.outcome;
      c.published = outcomeRank(a.outcome) >= LOW;
    }
  }
  return { listings, claims, listingsByHash };
}

/** The listing an event belongs to: its own listingId, or its claim's. */
export function listingOf(projection, e) {
  if (e.args.listingId !== undefined) return e.args.listingId;
  if (e.args.claimId !== undefined) return projection.claims.get(e.args.claimId)?.listingId ?? null;
  return null;
}

/**
 * An event as the site shows it: placed by its listing and claim, and, for a claim that is not
 * published, reduced to the ids it carries.
 */
export function publicEvent(projection, e) {
  const listingId = listingOf(projection, e);
  const claimId = e.args.claimId ?? null;
  const base = { name: e.name, blockNumber: e.blockNumber, blockHash: e.blockHash, logIndex: e.logIndex, txHash: e.txHash, timestamp: e.timestamp, listingId, claimId };
  if (claimId !== null && !projection.claims.get(claimId)?.published) {
    const args = { claimId };
    if (e.args.listingId !== undefined) args.listingId = e.args.listingId;
    return { ...base, args, redacted: true };
  }
  return { ...base, args: e.args };
}

/** The feed's events (FEED_EVENTS), as the site shows them. */
export function feedEvents(projection, events) {
  return events.filter((e) => FEED.has(e.name)).map((e) => publicEvent(projection, e));
}
