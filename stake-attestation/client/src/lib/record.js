// The record page's view of GET /api/records/:hash (node P4b1): the server's mirror of the
// contract's recordByHash at its indexed block, the site's labels and the indexed history. The
// record names the artifact by hash, kind and (for a contract) its deployment only; the
// repository and the commit are in the listings' Listed events, which the history carries in
// full. Facts only: counts, amounts (wei, as decimal strings), times (chain seconds) and names
// as the contract has them; no label or wording is decided here.
import { CLASSES, OUTCOMES } from '../chain/abi.js';

const DAY = 86400;
const time = (s) => (BigInt(s) === 0n ? null : Number(s));
const isZeroHash = (h) => /^0x0{64}$/.test(h);

/** The stake label first, then invited and lapsed; 'noPrice' when the server could not price it. */
function labelsOf(listing, label) {
  const out = [];
  if (label?.stake) out.push(label.stake);
  else if (label?.error) out.push('noPrice');
  if (listing.invited) out.push('invited');
  if (listing.lapsed) out.push('lapsed');
  return out;
}

/** Whole dollars over a declared value at risk, as a percentage with two decimals, rounded down. */
function share(stakeUsd, valueAtRiskUsd) {
  if (stakeUsd === null || stakeUsd === undefined || BigInt(valueAtRiskUsd) === 0n) return null;
  const bps = (BigInt(stakeUsd) * 10000n) / BigInt(valueAtRiskUsd);
  return `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}`;
}

const neighbour = (id, hash) => (BigInt(id) === 0n ? null : { id: String(id), hash: isZeroHash(hash) ? null : hash.toLowerCase() });

/** No fact from the server reads as "no", the fact's default. */
const NOT_CHECKED = Object.freeze({ subject: 'repository', proof: 'no', reason: 'NOT_CHECKED_YET', detail: null, repository: null, deployment: null });

function listingView(l, label, blockTimestamp, control) {
  const opened = Number(l.openedAt);
  // it took claims from the opening to its roll forward or close, whichever came first
  const ends = [time(l.rolledAt), time(l.closedAt)].filter((t) => t !== null);
  const end = ends.length ? Math.min(...ends) : blockTimestamp;
  return {
    id: String(l.listingId),
    maker: l.maker,
    state: l.state,
    labels: labelsOf(l, label),
    control: control ?? NOT_CHECKED,
    awards: Object.fromEntries(CLASSES.map((c, i) => [c, String(l.awards[i])])),
    lowest: l.lowestClassCounted,
    bondWei: String(l.bondWei),
    escrowWei: String(l.escrowWei),
    owedWei: String(l.owedWei),
    valueAtRiskUsd: BigInt(l.valueAtRiskUsd) === 0n ? null : String(l.valueAtRiskUsd),
    stakeUsd: label?.stakeUsd ?? null,
    sharePct: share(label?.stakeUsd, l.valueAtRiskUsd),
    listedAt: time(l.listedAt),
    openedAt: opened,
    fundedUntil: time(l.fundedUntil),
    rolledAt: time(l.rolledAt),
    closedAt: time(l.closedAt),
    daysOpen: Math.max(0, Math.floor((end - opened) / DAY)),
    predecessor: neighbour(l.predecessor, l.predecessorHash),
    successor: neighbour(l.successor, l.successorHash),
  };
}

const byOutcome = (counts) => OUTCOMES.map((o, i) => [o, String(counts[i])]);

function findingView(f) {
  return {
    claimId: String(f.claimId),
    listingId: String(f.listingId),
    hunter: f.hunter,
    outcome: f.outcome,
    dispute: f.dispute,
    paidWei: String(f.paidWei),
    owedWei: String(f.owedWei),
    revealedAt: time(f.revealedAt),
    settledAt: time(f.settledAt),
    bcid: f.bcid,
  };
}

/**
 * @param {object} view - GET /api/records/:hash's answer
 */
export function recordView(view) {
  const { record, labels, history, block } = view;
  const h = record.history;
  const a = view.artifact;
  return {
    hash: record.artifactHash.toLowerCase(),
    kind: record.kind,
    artifact: a ? { repo: a.repo, baseCommit: a.baseCommit, chainId: String(a.chainId), address: a.address } : null,
    fork: view.fork ?? null,
    listingCount: String(record.listingCount),
    active: record.active.map(String),
    listings: record.listings.map((l) => listingView(l, labels.listings[String(l.listingId)], block.timestamp, view.control?.[String(l.listingId)])),
    history: {
      claims: String(h.claims),
      judged: String(h.outcomes.reduce((s, x) => s + BigInt(x), 0n)),
      pending: String(h.pending),
      verdicts: byOutcome(h.outcomes),
      duplicates: String(h.outcomes[1]),
      released: String(h.released),
      undisclosed: String(h.undisclosed),
      unrevealed: String(h.unrevealed),
      noVerdict: String(h.noVerdict),
      disputes: { filed: String(h.disputes), held: String(h.disputesHeld), overturned: String(h.disputesOverturned), noVerdict: String(h.disputesNoVerdict) },
      daysSinceLastValidFinding: history.daysSinceLastValidFinding,
    },
    findings: record.findings.filter((f) => !f.late).map(findingView),
    later: {
      claims: String(h.lateClaims),
      verdicts: byOutcome(h.lateOutcomes),
      expired: String(h.lateExpired),
      findings: record.findings.filter((f) => f.late).map(findingView),
    },
    flags: record.flags.map((f) => ({
      claimId: String(f.claimId),
      listingId: String(f.listingId),
      late: Boolean(f.late),
      state: f.state,
      disclosedAt: time(f.disclosedAt),
      verdict: time(f.judgedAt) === null ? null : { outcome: f.outcome, at: Number(f.judgedAt) },
    })),
    notCounted: {
      listings: (view.notCounted?.listings ?? []).map((l) => ({ id: String(l.listingId), maker: l.maker, state: l.state, reason: l.reason, detail: l.detail ?? null })),
      findings: (view.notCounted?.findings ?? []).length,
    },
    block,
    fresh: view.fresh,
    staleReason: view.staleReason,
    placeholders: labels.placeholders ?? [],
  };
}
