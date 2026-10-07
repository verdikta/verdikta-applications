/**
 * Market summary: aggregate, public context about bounty activity.
 *
 * Pure functions plus a small in-process cache. Aggregates only: no addresses, titles,
 * descriptions or other task content ever leave this module. The result is context for
 * a buyer deciding whether to commission outside work; it is NOT a quote, an offer,
 * supplier availability or a prediction of what a new bounty will cost or attract.
 */

const SCHEMA_VERSION = '1.0.0';
const SERVICE_IDS = ['source-check-v1', 'evidence-pack-v1', 'review-v1', 'real-world-task-v1'];
const UNCLASSIFIED = 'unclassified';
// A quartile block built from fewer samples is withheld: it would describe one or two
// bounties, not a market.
const MIN_SAMPLES = 3;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_TTL_SECONDS = 300;
const HIDDEN_STATUSES = new Set(['ORPHANED', 'CANCELLED']);
const DAY = 86400;

const DISCLAIMER = 'Aggregates of past and open bounties. Not a quote, an offer, supplier availability or a prediction '
  + 'of what a new bounty will cost or attract. The service split is self-declared in each bounty description and is not verified.';

/**
 * A work order committed through the onboarding skill or the website import carries these exact
 * lines in the evaluation description (skills/verdikta-discover/scripts/work-order.mjs).
 * All three must be present; anything else is unclassified. The lines are self-declared
 * and a hostile creator could copy them, so the disclaimer says so and the summary reports
 * medians, which one bounty cannot move far.
 */
const DRAFT_LINE = /^Approved work-order draft SHA-256: [0-9a-f]{64}$/m;
const SERVICE_LINE = new RegExp(`^Service: (${SERVICE_IDS.join('|')})$`, 'm');
const REQUEST_LINE = /^Request bytes SHA-256 \(result\.input_sha256\): [0-9a-f]{64}$/m;

function classifyService(description) {
  if (typeof description !== 'string') return UNCLASSIFIED;
  const service = SERVICE_LINE.exec(description);
  return service && DRAFT_LINE.test(description) && REQUEST_LINE.test(description) ? service[1] : UNCLASSIFIED;
}

function toBigInt(value) {
  try {
    if (value == null || value === '') return null;
    const n = BigInt(value);
    return n >= 0n ? n : null;
  } catch { return null; }
}

/** Linear-interpolated quartiles over BigInt or integer samples; withheld below MIN_SAMPLES. */
function quartiles(samples, { asString }) {
  const n = samples.length;
  if (n < MIN_SAMPLES) return { n, median: null, p25: null, p75: null, suppressed_below_n: MIN_SAMPLES };
  const sorted = samples.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const at = (quarters) => {
    const pos = BigInt((n - 1) * quarters);
    const lo = Number(pos / 4n), rem = pos % 4n;
    const a = BigInt(sorted[lo]), b = BigInt(sorted[Math.min(lo + 1, n - 1)]);
    const v = a + ((b - a) * rem) / 4n;
    return asString ? v.toString() : Number(v);
  };
  return { n, median: at(2), p25: at(1), p75: at(3) };
}

function emptyBucket() {
  return { open: 0, awarded: 0, closed_unawarded: 0, amounts: [], timesToAward: [], prepays: [] };
}

function finishBucket(b) {
  return {
    open: b.open, awarded: b.awarded, closed_unawarded: b.closed_unawarded,
    sample_size: b.open + b.awarded + b.closed_unawarded,
    bounty_amount_wei: quartiles(b.amounts, { asString: true }),
    time_to_award_seconds: quartiles(b.timesToAward, { asString: false }),
    oracle_prepay_wei: quartiles(b.prepays, { asString: true }),
  };
}

function winningSubmission(job) {
  const subs = Array.isArray(job.submissions) ? job.submissions : [];
  return subs.find(s => s && s.paidWinner === true) || subs.find(s => s && (s.status === 'APPROVED' || s.onChainStatus === 'PassedPaid')) || null;
}

/**
 * @param {object[]} jobs      job records as returned by jobStorage.listJobs
 * @param {object}   options   { now (ms), windowDays, network: { name, chain_id }, ttlSeconds }
 */
function buildMarketSummary(jobs, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, network = {}, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const nowSec = Math.floor(now / 1000);
  const fromSec = nowSec - windowDays * DAY;
  const buckets = { all: emptyBucket(), [UNCLASSIFIED]: emptyBucket() };
  for (const id of SERVICE_IDS) buckets[id] = emptyBucket();
  const hunters = new Set();

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || HIDDEN_STATUSES.has(String(job.status).toUpperCase())) continue;
    const status = String(job.status).toUpperCase();
    const service = classifyService(job.description);
    const scoped = [buckets.all, buckets[service]];
    const amount = toBigInt(job.bountyAmountWei);

    // Which bounties are "in scope": open now, or awarded / closed inside the window.
    let inScope = false;
    if (status === 'OPEN') {
      scoped.forEach(b => { b.open += 1; });
      inScope = true;
    } else if (status === 'AWARDED') {
      const win = winningSubmission(job);
      const awardedAt = Number(win?.finalizedAt);
      if (awardedAt >= fromSec && awardedAt <= nowSec) {
        scoped.forEach(b => { b.awarded += 1; });
        inScope = true;
        const openedAt = Number(job.submissionOpenTime ?? job.createdAt);
        if (openedAt > 0 && awardedAt > openedAt) scoped.forEach(b => b.timesToAward.push(awardedAt - openedAt));
      }
    } else if (status === 'CLOSED' || status === 'EXPIRED') {
      const closedAt = Number(job.submissionCloseTime ?? job.createdAt);
      if (closedAt >= fromSec && closedAt <= nowSec) {
        scoped.forEach(b => { b.closed_unawarded += 1; });
        inScope = true;
      }
    }
    if (inScope && amount != null) scoped.forEach(b => b.amounts.push(amount));

    // Hunter activity and worst-case oracle prepay come from submissions made inside the window.
    for (const sub of Array.isArray(job.submissions) ? job.submissions : []) {
      if (!sub || !(Number(sub.submittedAt) >= fromSec)) continue;
      if (typeof sub.hunter === 'string' && sub.hunter) hunters.add(sub.hunter.toLowerCase());
      const prepay = toBigInt(sub.ethMaxBudget);
      if (prepay != null) scoped.forEach(b => b.prepays.push(prepay));
    }
  }

  const by_service = {};
  for (const id of [...SERVICE_IDS, UNCLASSIFIED]) by_service[id] = finishBucket(buckets[id]);
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    cache_ttl_seconds: ttlSeconds,
    network: { name: network.name ?? null, chain_id: network.chain_id ?? null },
    window: { days: windowDays, from: new Date(fromSec * 1000).toISOString(), to: new Date(nowSec * 1000).toISOString() },
    not_a_quote: true,
    disclaimer: DISCLAIMER,
    definitions: {
      scope: 'Bounties that are open now, plus bounties awarded or closed without an award inside the window.',
      bounty_amount_wei: 'The funded amount (bountyAmountWei) of the bounties in scope.',
      time_to_award_seconds: 'From bounty open time to the winning submission\'s finalization as recorded by this server; approximate to the sync interval.',
      oracle_prepay_wei: 'Worst-case ETH prepay (ethMaxBudget) attached to submissions made inside the window; mostly refunded.',
      quartiles: `Linear interpolation, rounded down to a whole unit; withheld (null, suppressed_below_n ${MIN_SAMPLES}) when fewer than ${MIN_SAMPLES} samples exist.`,
    },
    all: finishBucket(buckets.all),
    by_service,
    hunters: { active_in_window: hunters.size, definition: 'Distinct addresses with at least one submission prepared inside the window. Counts only; no addresses are published.' },
  };
}

// ---- in-process cache with one in-flight computation -------------------------------------
const cache = { value: null, expiresAt: 0, inflight: null };

function resetMarketSummaryCache() { cache.value = null; cache.expiresAt = 0; cache.inflight = null; }

/**
 * Serve the cached summary for ttlSeconds. Concurrent callers share one computation, and if a
 * refresh fails the previous summary (its generated_at shows its age) is served instead of an error.
 */
async function getMarketSummary(compute, { ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now } = {}) {
  if (cache.value && now() < cache.expiresAt) return cache.value;
  if (!cache.inflight) {
    cache.inflight = Promise.resolve().then(compute).then(
      (value) => { cache.value = value; cache.expiresAt = now() + ttlSeconds * 1000; cache.inflight = null; return value; },
      (error) => { cache.inflight = null; if (cache.value) return cache.value; throw error; },
    );
  }
  return cache.inflight;
}

function windowDaysFromEnv(env = process.env) {
  const n = Number.parseInt(env.MARKET_SUMMARY_WINDOW_DAYS, 10);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_WINDOW_DAYS;
}

module.exports = {
  SCHEMA_VERSION, SERVICE_IDS, MIN_SAMPLES, DEFAULT_TTL_SECONDS, DEFAULT_WINDOW_DAYS,
  classifyService, quartiles, buildMarketSummary, getMarketSummary, resetMarketSummaryCache, windowDaysFromEnv,
};
