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
//
// The settlement safeguards (design §13.2, errata E7-E9; node P18). Each claim also carries what
// its events say of them, in the contract's names:
//   disputeKind     the latest dispute-panel round's kind: None, Maker, Confirmation, Appeal
//   dispute         how that round stands: None, Pending, Held, Overturned, NoVerdict
//   appealDeadline  a claim round's INVALID that no panel round has judged: judgedAt +
//                   disputeWindow, the lens's appealDeadline; null otherwise or once settled
//   appeal          null, or { rounds, result, retriggerDeadline }: the appeal's rounds (it and its
//                   one re-trigger), its result, and the re-trigger's deadline while it is open
//   confirmation    null when the claim round's award is at or below the listing's size (or the
//                   claim is late), else { status, rounds, opensAt, deadline }: Awaiting (no round
//                   open, none returned a verdict), Pending (a round open), Held or Overturned (a
//                   dispute-panel verdict, the maker's dispute or a confirmation), PaidWithoutVerdict
//                   (settle paid the first verdict from the deadline: ConfirmationNoVerdict)
//   confirmationRefunds  each ConfirmationRefunded: where a round's unspent prepay went
//   narrowInvalid   null, or { validMass } once settle returned an INVALID's bond (NarrowInvalid)
//   bond            null until settled, then the contract's settlement of it: returned or forfeited
// The windows come from the listing's terms, read at its Listed block (indexer.js); a listing
// indexed without them (a state file from before node P18) has none, and its claims' windows are
// null. Each listing carries its floor and size, and `program` the values the owner's setter
// events (NarrowInvalidFloorSet, ConfirmAboveWeiSet) leave for the next list(): null for one set
// before the indexer's first block. None of this is published for a claim that is not: the feed's
// events of such a claim keep only their ids (publicEvent).
import { FEED_EVENTS, outcomeRank } from '../chain/abi.js';

const LOW = outcomeRank('LOW');
const FEED = new Set(FEED_EVENTS);
const PANEL_KIND = Object.freeze({ Disputed: 'Maker', Appealed: 'Appeal', ConfirmationRequested: 'Confirmation' });

/** ClaimRules.awardFor: the table's award for an outcome at or above the class counted, else 0. */
function awardFor(terms, outcome) {
  const o = outcomeRank(outcome);
  if (o < LOW || o < outcomeRank(terms.lowestClassCounted)) return 0n;
  return BigInt(terms.awards[o - LOW]);
}

/** The safeguards' view of a claim, from its events and its listing's terms (see the top of this file). */
function safeguards(c, terms) {
  const verdict = c.dispute === 'Held' || c.dispute === 'Overturned';
  c.appealDeadline = terms && c.state === 'Judged' && c.outcome === 'INVALID' && c.dispute === 'None' && c.judgedAt !== null
    ? c.judgedAt + terms.disputeWindow
    : null;
  if (c.appealRounds > 0) {
    const retriggerOpen = terms && c.state === 'Judged' && c.disputeKind === 'Appeal' && c.dispute === 'NoVerdict' && !c.appealRetriggered;
    c.appeal = {
      rounds: c.appealRounds,
      result: c.disputeKind === 'Appeal' ? c.dispute : 'None',
      retriggerDeadline: retriggerOpen ? c.disputeEndedAt + terms.revealWindow : null,
    };
  } else {
    c.appeal = null;
  }
  // ClaimRules.awaitsConfirmation, for the claim round's verdict
  const awaited = c.claimRoundOutcome !== null && !c.late && (terms
    ? awardFor(terms, c.claimRoundOutcome) > BigInt(terms.confirmAboveWei)
    : c.confirmationRounds > 0 || c.confirmationNoVerdict);
  if (!awaited) {
    c.confirmation = null;
  } else {
    let status = 'Awaiting';
    if (c.confirmationNoVerdict) status = 'PaidWithoutVerdict';
    else if (verdict) status = c.dispute;
    else if (c.state === 'Disputed') status = 'Pending';
    const opensAt = terms && c.judgedAt !== null ? c.judgedAt + terms.disputeWindow : null;
    c.confirmation = { status, rounds: c.confirmationRounds, opensAt, deadline: opensAt === null ? null : opensAt + terms.revealWindow };
  }
  delete c.claimRoundOutcome;
  delete c.appealRounds;
  delete c.appealRetriggered;
  delete c.confirmationRounds;
  delete c.confirmationNoVerdict;
}

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
  Appealed: 'Disputed',
  ConfirmationRequested: 'Disputed',
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
  const program = { narrowInvalidFloor: null, confirmAboveWei: null };
  for (const e of events) {
    const a = e.args;
    if (e.name === 'NarrowInvalidFloorSet') program.narrowInvalidFloor = a.newFloor;
    else if (e.name === 'ConfirmAboveWeiSet') program.confirmAboveWei = a.newWei;
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
        // fixed at list(), read at the Listed block (indexer.js); null in a state from before node P18
        terms: e.terms ?? null,
        narrowInvalidFloor: e.terms?.narrowInvalidFloor ?? null,
        confirmAboveWei: e.terms?.confirmAboveWei ?? null,
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
      claims.set(a.claimId, {
        claimId: a.claimId, listingId: a.listingId, late: e.name === 'LateClaim', state: 'Committed', disclosed: false, outcome: null, justificationCid: null, published: false,
        judgedAt: null, disputeKind: 'None', dispute: 'None', disputeEndedAt: null, confirmationRefunds: [], narrowInvalid: null, bond: null,
        // folded into appeal and confirmation once the events are read
        claimRoundOutcome: null, appealRounds: 0, appealRetriggered: false, confirmationRounds: 0, confirmationNoVerdict: false,
      });
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
    if (e.name === 'Judged') {
      c.judgedAt = e.timestamp;
      c.claimRoundOutcome = a.outcome;
    }
    if (PANEL_KIND[e.name]) {
      c.disputeKind = PANEL_KIND[e.name];
      c.dispute = 'Pending';
      if (e.name === 'Appealed') c.appealRounds += 1;
      if (e.name === 'ConfirmationRequested') c.confirmationRounds += 1;
    }
    if (e.name === 'Retriggered' && c.state === 'Judged' && c.disputeKind === 'Appeal' && c.dispute === 'NoVerdict') c.appealRetriggered = true;
    if (e.name === 'DisputeJudged') {
      c.dispute = a.result;
      c.disputeEndedAt = e.timestamp;
    }
    if (e.name === 'DisputeFailed') {
      c.dispute = 'NoVerdict';
      c.disputeEndedAt = e.timestamp;
    }
    if (e.name === 'ConfirmationRefunded') c.confirmationRefunds.push({ toOwedWei: a.toOwedWei, toEscrowWei: a.toEscrowWei, toMakerWei: a.toMakerWei });
    if (e.name === 'ConfirmationNoVerdict') c.confirmationNoVerdict = true;
    if (e.name === 'NarrowInvalid') c.narrowInvalid = { validMass: a.validMass };
    if (e.name === 'Settled') {
      c.outcome = a.outcome;
      c.published = outcomeRank(a.outcome) >= LOW;
      // settle's own rule: an INVALID's bond goes to the maker unless NarrowInvalid came before it
      c.bond = a.outcome === 'INVALID' && !c.narrowInvalid ? 'forfeited' : 'returned';
    }
  }
  for (const c of claims.values()) safeguards(c, listings.get(c.listingId)?.terms ?? null);
  return { listings, claims, listingsByHash, program };
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
