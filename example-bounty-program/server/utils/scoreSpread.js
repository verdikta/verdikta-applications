/**
 * Arbiter score spread: how far apart the arbiters' scores are for the same
 * submission in the same evaluation round.
 *
 * v2 aggregator: a finalized round (phase 6 final or 7 settled) keeps every
 * counted reveal's raw scores on chain, read with getOutcomeScores(aggId, o), in
 * reveal order (r.order). A round has exactly N counted reveals (the N-th
 * finalizes it: 4 / 13 / 27 for the small / medium / large juries). The
 * RevealReceived(aggId, slot, late=false) events give that order as slots, and
 * getSlot(aggId, slot) the arbiter (operator and key; the keeper's jobIdOf(key)
 * names its Chainlink job). Every counted reveal was checked against its commit.
 * A late reveal (after finalization) stores only its quality code, never its
 * scores, so it is counted (lateReveals) but not in the spread.
 *
 * Metric: the FUND score, the one the escrow judges (BountyRules.judge): index
 * len - 1 of a one-number or two-outcome result, divided by 10,000 (0..100).
 * A round's spread is the sample standard deviation of those scores across its
 * counted reveals. The pooled sd across rounds, sqrt(sum (n-1) var / sum (n-1)),
 * is the per-response noise and is the headline number.
 *
 * The cluster (the P nearest reveals, which set the aggregate and earn the bonus)
 * is read from the round's BonusPayment events, never recomputed: with zero fees
 * no bonus is paid and the cluster is unknown.
 *
 * Pass count: the reveals whose FUND score is at or above threshold x 10,000; the
 * bounty's quota Q and forfeit line R turn it into pass / soft fail / hard fail.
 *
 * v2 round ids are sequential per aggregator, so rounds are cached under
 * "<jobId>:<aggId>" (one aggregator serves every bounty). Every re-run round of a
 * submission is kept (submission.aggIds). Finalized and dead rounds never change,
 * so they are cached in data/<network>/scoreSpread.json and fetched once; a
 * background pass picks up new rounds. Readers never wait on RPC.
 */

const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
const { config } = require('../config');
const logger = require('./logger');
const { AGGREGATOR_ABI } = require('./aggregatorAbi');

const NETWORK = config.network || 'base-sepolia';
const STATE_FILE = path.join(__dirname, `../data/${NETWORK}/scoreSpread.json`);
const STATE_VERSION = 3;   // 3: FUND scores, cluster from BonusPayment, late reveals, arbiter keys

const LOOKBACK_DAYS = parseFloat(process.env.SCORE_SPREAD_LOOKBACK_DAYS) || 30; // rounds collected
const MAX_REPORT_DAYS = LOOKBACK_DAYS;
// An id the aggregator has no round for, this long after the submission, is never coming.
const SETTLE_SECONDS = 60 * 60;
// Reveals land before the round's deadline; the log scan runs from the request block to
// the deadline plus this slack, converted with the measured block time.
const EVENT_SLACK_SECONDS = 10 * 60;
const LOG_CHUNK_BLOCKS = 9000;        // keyless/public RPCs reject eth_getLogs over 10,000 blocks
const ROUND_PARALLEL = 3;
// Round sd at or below AGREE_SD: the arbiters agree. Above OUTLIER_SD: one or more
// arbiters disagree. Both sit at the goal, SD 3, so every round either meets it or counts as an outlier.
const AGREE_SD = 3;
const OUTLIER_SD = 3;
// An arbiter's score this far from the other arbiters' mean in the same round counts as far off.
const FAR_GAP = 15;
const SCORE_SCALE = 1_000_000;     // BountyRules.SCORE_SCALE
const SCORE_DIVISOR = 10_000;      // BountyRules.SCORE_DIVISOR: threshold (0..100) x this = raw score

const lc = (s) => String(s || '').toLowerCase();
// Creator-approved submissions never go to the arbiters and carry a zero aggId.
const isRoundId = (id) => /^0x[0-9a-f]{64}$/.test(lc(id)) && !/^0x0{64}$/.test(lc(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// ABIs
// ------------------------------------------------------------

const AGG_IFACE = new ethers.Interface(AGGREGATOR_ABI);
const KEEPER_IFACE = new ethers.Interface(['function jobIdOf(bytes32 key) view returns (bytes32)']);
const FINAL_PHASES = new Set([6, 7]);  // final, settled: scores readable and fixed
const DEAD_PHASES = new Set([8, 9]);   // failed, cancelled: no scores, ever

// ------------------------------------------------------------
// Statistics (pure)
// ------------------------------------------------------------

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const variance = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const quantile = (a, q) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
/** Chainlink jobIds are 32 ASCII hex characters; show them as text when they are. */
function jobIdText(jobId) {
  if (!jobId) return null;
  try {
    const t = ethers.toUtf8String(jobId).replace(/\0+$/, '');
    if (/^[\x20-\x7e]+$/.test(t)) return t;
  } catch { /* not UTF-8 */ }
  return jobId;
}
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** A raw FUND score (0..1,000,000) on the threshold's 0..100 scale. */
const fundScore = (raw) => Number(raw) / SCORE_DIVISOR;

/**
 * Spread of one round's scores (0..100 each). Returns null when fewer than two remain.
 */
function roundSpread(scores) {
  const xs = (scores || []).map(Number).filter(Number.isFinite);
  if (xs.length < 2) return null;
  const v = variance(xs);
  const med = quantile(xs, 0.5);
  return {
    n: xs.length,
    var: v,
    sd: Math.sqrt(v),
    mean: mean(xs),
    median: med,
    range: Math.max(...xs) - Math.min(...xs),
    maxDev: Math.max(...xs.map((s) => Math.abs(s - med)))
  };
}

/**
 * The escrow's Q-of-N rule (BountyRules.judge) over a round's raw FUND scores: count the scores at or
 * above threshold x 10,000; pass at quota Q, soft fail at the forfeit line R, else hard fail.
 * Outcome is null when the quota is unknown.
 */
function judgeRound(rawFund, threshold, quota, forfeitLine) {
  if (threshold == null) return { passCount: null, outcome: null };
  const t = Number(threshold) * SCORE_DIVISOR;
  const passCount = rawFund.filter((s) => Number(s) >= t && Number(s) <= SCORE_SCALE).length;
  if (quota == null) return { passCount, outcome: null };
  const q = Number(quota);
  const r = Number(forfeitLine ?? q);
  const outcome = passCount >= q ? 'pass' : passCount >= r ? 'soft_fail' : 'hard_fail';
  return { passCount, outcome };
}

/** Pooled per-response sd plus distribution of round sds over [{ n, var }]. */
function pooled(rs) {
  let ss = 0;
  let dof = 0;
  for (const r of rs) { ss += (r.n - 1) * r.var; dof += r.n - 1; }
  const sds = rs.map((r) => Math.sqrt(r.var));
  return {
    rounds: rs.length,
    reveals: rs.reduce((a, r) => a + r.n, 0),
    pooledSd: dof ? round2(Math.sqrt(ss / dof)) : null,
    medianRoundSd: round2(quantile(sds, 0.5)),
    p90RoundSd: round2(quantile(sds, 0.9)),
    maxRoundSd: sds.length ? round2(Math.max(...sds)) : null,
    agreeFrac: rs.length ? round2(sds.filter((s) => s <= AGREE_SD).length / rs.length) : null,
    outlierFrac: rs.length ? round2(sds.filter((s) => s > OUTLIER_SD).length / rs.length) : null
  };
}

/** Every round id a submission ran (re-runs included), oldest first. */
function submissionRoundIds(sub) {
  const ids = [];
  for (const id of [...(Array.isArray(sub?.aggIds) ? sub.aggIds : []), sub?.verdiktaAggId]) {
    const v = lc(id);
    if (isRoundId(v) && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** A jury { K, M, N, P, timeout } as numbers, or null (records from before item 15 stored an index). */
function juryOf(j) {
  if (!j || typeof j !== 'object' || !(Number(j.K) > 0)) return null;
  return { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout) };
}

/** The bounty's Q-of-N settings and jury, when the job record has them. */
function decisionOf(job) {
  const d = job?.decisionSettings;
  const jury = juryOf(d?.jury);
  if (!d || d.quota == null) return { quota: null, forfeitLine: null, jury };
  return { quota: Number(d.quota), forfeitLine: Number(d.forfeitLine ?? d.quota), jury };
}

// ------------------------------------------------------------
// Report (pure): join cached rounds with bounty/submission data
// ------------------------------------------------------------

/**
 * @param state  cached { rounds: { "<jobId>:<aggId>": record } }
 * @param jobs   bounty jobs (with submissions[].verdiktaAggId and, for re-runs, submissions[].aggIds)
 * @param opts   { days = 14, now = seconds }
 */
function buildReport(state, jobs, { days = 14, now = Math.floor(Date.now() / 1000) } = {}) {
  const windowDays = Math.max(1, Math.min(MAX_REPORT_DAYS, Math.round(days)));
  const from = now - windowDays * 86400;
  const rounds = state?.rounds || {};

  const samples = [];
  const coverage = { submissions: 0, rounds: 0, pending: 0, notFound: 0, noResult: 0, badShape: 0, tooFewReveals: 0, lateReveals: 0 };
  for (const job of jobs || []) {
    const { quota, forfeitLine, jury } = decisionOf(job);
    for (const sub of job.submissions || []) {
      const ids = submissionRoundIds(sub);
      let counted = false;
      ids.forEach((aggId, k) => {
        const rec = rounds[roundKey(job.jobId, aggId)];
        const ts = rec?.startTs || sub.submittedAt || 0;
        if (ts < from || ts > now) return;
        if (!counted) { coverage.submissions++; counted = true; }
        coverage.rounds++;
        if (!rec) { coverage.pending++; return; }
        if (rec.notFound) { coverage.notFound++; return; }
        coverage.lateReveals += (rec.late || []).length;
        if (!rec.finalized) { if (rec.settled) coverage.noResult++; return; }
        if (rec.badShape) { coverage.badShape++; return; }
        const reveals = rec.reveals || [];
        const sp = roundSpread(reveals.map((r) => fundScore(r.fund)));
        if (!sp) { coverage.tooFewReveals++; return; }
        const cluster = Array.isArray(rec.cluster) && rec.cluster.length ? new Set(rec.cluster) : null;
        const cl = cluster ? roundSpread(reveals.filter((r) => cluster.has(r.slot)).map((r) => fundScore(r.fund))) : null;
        const { passCount, outcome } = judgeRound(reveals.map((r) => r.fund), job.threshold, quota, forfeitLine);
        const latest = k === ids.length - 1;
        samples.push({
          jobId: job.jobId,
          title: job.title || null,
          threshold: job.threshold ?? null,
          quota,
          forfeitLine,
          // the round's own jury (getJury), else the bounty's
          jury: juryOf(rec.jury) || jury,
          submissionId: sub.submissionId,
          round: k + 1,
          rounds: ids.length,
          hunter: sub.hunter || null,
          // the submission's status describes its latest round only
          status: latest ? (sub.onChainStatus || sub.status || null) : null,
          finalScore: rec.finalAccept ?? null,
          passCount,
          outcome,
          aggId,
          ts,
          n: sp.n,
          sd: round2(sp.sd),
          var: sp.var,
          clusterKnown: !!cluster,
          clusterN: cl ? cl.n : (cluster ? cluster.size : 0),
          clusterSd: cl ? round2(cl.sd) : null,
          clusterVar: cl ? cl.var : null,
          lateReveals: (rec.late || []).length,
          median: round2(sp.median),
          range: round2(sp.range),
          maxDev: round2(sp.maxDev),
          reveals: reveals.map((r) => ({
            slot: r.slot,
            operator: r.operator,
            key: r.key || null,
            jobId: jobIdText(r.jobId),
            accept: round2(fundScore(r.fund)),
            inCluster: cluster ? cluster.has(r.slot) : null,
            block: r.block
          }))
        });
      });
    }
  }
  samples.sort((a, b) => b.sd - a.sd || b.ts - a.ts);

  // mode: every counted reveal (default) or 'cluster' (the bonus-paid P, where known).
  const strip = (rs, mode) => rs
    .filter((s) => (mode === 'cluster' ? s.clusterVar != null : true))
    .map((s) => (mode === 'cluster' ? { n: s.clusterN, var: s.clusterVar } : { n: s.n, var: s.var }));

  // Daily buckets measured back from `now` (newest = daysAgo 0), like the arbiters
  // site's Response Timing chart.
  const daily = [];
  for (let d = windowDays - 1; d >= 0; d--) {
    const hi = now - d * 86400;
    const lo = hi - 86400;
    const day = samples.filter((s) => s.ts > lo && s.ts <= hi);
    const p = pooled(strip(day));
    const c = pooled(strip(day, 'cluster'));
    daily.push({ daysAgo: d, rounds: p.rounds, pooledSd: p.pooledSd, medianRoundSd: p.medianRoundSd, p90RoundSd: p.p90RoundSd,
      clusterPooledSd: c.pooledSd });
  }

  // First half vs second half of the window: is the spread coming down?
  const mid = now - (windowDays * 86400) / 2;
  const halves = {
    earlier: pooled(strip(samples.filter((s) => s.ts <= mid))),
    recent: pooled(strip(samples.filter((s) => s.ts > mid))),
    halfDays: windowDays / 2
  };

  const byBounty = new Map();
  for (const s of samples) {
    if (!byBounty.has(s.jobId)) byBounty.set(s.jobId, { jobId: s.jobId, title: s.title, threshold: s.threshold, quota: s.quota, list: [] });
    byBounty.get(s.jobId).list.push(s);
  }
  const bounties = [...byBounty.values()].map((b) => ({
    jobId: b.jobId, title: b.title, threshold: b.threshold, quota: b.quota, ...pooled(strip(b.list)),
    lastTs: Math.max(...b.list.map((s) => s.ts))
  })).sort((a, b) => b.pooledSd - a.pooledSd || b.rounds - a.rounds);

  // Per arbiter (keeper key): how far each of its scores sits from the mean of the
  // OTHER arbiters in the same round. A consistent sign is a lean (the arbiter scores
  // persistently high or low); a large mean |gap| is noise.
  const arb = new Map();
  for (const s of samples) {
    const total = s.reveals.reduce((acc, r) => acc + r.accept, 0);
    for (const r of s.reveals) {
      const gap = r.accept - (total - r.accept) / (s.reveals.length - 1);
      const key = r.key || `${r.operator}:${r.jobId || ''}`;
      if (!arb.has(key)) arb.set(key, { key: r.key, operator: r.operator, jobId: r.jobId, gaps: [], rounds: [], inCluster: 0, clusterKnown: 0 });
      const a = arb.get(key);
      a.gaps.push(gap);
      a.rounds.push({ jobId: s.jobId, submissionId: s.submissionId, round: s.round, gap: round2(gap) });
      if (r.inCluster != null) { a.clusterKnown++; if (r.inCluster) a.inCluster++; }
    }
  }
  const arbiters = [...arb.values()].map((a) => ({
    key: a.key,
    operator: a.operator,
    jobId: a.jobId,
    reveals: a.gaps.length,
    meanGap: round2(mean(a.gaps)),
    meanAbsGap: round2(mean(a.gaps.map(Math.abs))),
    farFrac: round2(a.gaps.filter((g) => Math.abs(g) > FAR_GAP).length / a.gaps.length),
    clusterFrac: a.clusterKnown ? round2(a.inCluster / a.clusterKnown) : null,
    worst: [...a.rounds].sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))[0]
  })).sort((x, y) => y.meanAbsGap - x.meanAbsGap || y.reveals - x.reveals);

  // Rounds by their jury's N (the counted reveals: 4 for Small and Medium, 13 Large, 27 Jumbo).
  const revealCounts = {};
  for (const s of samples) revealCounts[s.n] = (revealCounts[s.n] || 0) + 1;

  const outcomes = { pass: 0, soft_fail: 0, hard_fail: 0, unknown: 0 };
  for (const s of samples) outcomes[s.outcome || 'unknown']++;

  return {
    windowDays,
    from,
    to: now,
    thresholds: { agreeSd: AGREE_SD, outlierSd: OUTLIER_SD, farGap: FAR_GAP },
    summary: pooled(strip(samples)),
    summaryCluster: {
      ...pooled(strip(samples, 'cluster')),
      unknownRounds: samples.filter((s) => !s.clusterKnown).length
    },
    revealCounts,
    outcomes,
    halves,
    daily,
    bounties,
    arbiters,
    samples: samples.map(({ var: _v, clusterVar: _cv, ...s }) => s),
    coverage,
    lastRunAt: state?.lastRunAt || null,
    lastError: state?.lastError || null
  };
}

/**
 * Round-level v2 facts over every cached round (the collector's look-back): how rounds ended,
 * beacon stages, prepay lost to the treasury, and late reveals (scored, not counted).
 */
function summarizeRounds(state) {
  const out = { rounds: 0, finalized: 0, failed: 0, cancelled: 0, beaconRounds: 0, treasuryRounds: 0,
    toTreasuryWei: '0', lateReveals: 0, roundsWithLate: 0, lookbackDays: LOOKBACK_DAYS };
  let wei = 0n;
  for (const r of Object.values(state?.rounds || {})) {
    if (r.notFound || !r.settled) continue;
    out.rounds++;
    if (r.finalized) out.finalized++;
    else if (r.phase === 9) out.cancelled++;
    else if (r.phase === 8) out.failed++;
    if (r.beacons > 0) out.beaconRounds++;
    const t = BigInt(r.toTreasuryWei || '0');
    if (t > 0n) { out.treasuryRounds++; wei += t; }
    const late = (r.late || []).length;
    out.lateReveals += late;
    if (late) out.roundsWithLate++;
  }
  out.toTreasuryWei = wei.toString();
  out.toTreasuryEth = ethers.formatEther(wei);
  return out;
}

// ------------------------------------------------------------
// Chain: fetch one round
// ------------------------------------------------------------

async function withRetry(fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; if (i < tries - 1) await sleep(400 * 2 ** i); }
  }
  throw err;
}

/** getLogs over [fromBlock, toBlock] in chunks under the RPC's range cap, in block order. */
async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    out.push(...await withRetry(() => provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
  }
  return out;
}

const roundKey = (jobId, aggId) => `${jobId}:${lc(aggId)}`;

async function ifaceCall(ctx, iface, to, fn, args) {
  const data = await withRetry(() => ctx.provider.call({ to, data: iface.encodeFunctionData(fn, args) }));
  return iface.decodeFunctionResult(fn, data);
}
const aggCall = (ctx, aggAddr, fn, args) => ifaceCall(ctx, AGG_IFACE, aggAddr, fn, args);

/** The keeper's jobIdOf(key) (static per key; memoized on ctx). Null when unreadable. */
async function jobIdOfKey(ctx, aggAddr, key) {
  ctx.jobIds = ctx.jobIds || {};
  ctx.keepers = ctx.keepers || {};
  if (ctx.jobIds[key] !== undefined) return ctx.jobIds[key];
  try {
    if (!ctx.keepers[aggAddr]) ctx.keepers[aggAddr] = lc((await aggCall(ctx, aggAddr, 'keeper', []))[0]);
    ctx.jobIds[key] = (await ifaceCall(ctx, KEEPER_IFACE, ctx.keepers[aggAddr], 'jobIdOf', [key]))[0];
  } catch {
    ctx.jobIds[key] = null;
  }
  return ctx.jobIds[key];
}

/**
 * Read one round's counted reveals. ctx = { provider, head, headTs, blockTime }.
 * `hintTs` (the submission time) decides when an unknown aggId is final.
 * Returns a record suitable for the cache. RPC failures throw, so a round is
 * never cached half-read; it is retried on the next pass.
 */
async function fetchRound(ctx, aggregator, aggId, hintTs = 0) {
  const { provider, head, headTs } = ctx;
  const aggAddr = lc(aggregator);
  aggId = lc(aggId);
  const fetchedAt = Math.floor(Date.now() / 1000);

  const info = await aggCall(ctx, aggAddr, 'getRoundInfo', [aggId]);
  const phase = Number(info.phase);
  if (phase === 0) {
    return { aggId, aggregator: aggAddr, notFound: true, fetchedAt, settled: hintTs > 0 && headTs - hintTs > SETTLE_SECONDS, reveals: [] };
  }
  const startTs = Number(info.requestTime);
  const reqBlock = Number(info.requestBlock);
  // The round's jury, as requested (one aggregator serves every jury size). Null when unreadable.
  let jury = null;
  try {
    const [K, M, N, P, timeout] = (await aggCall(ctx, aggAddr, 'getJury', [aggId])).map(Number);
    if (K > 0) jury = { K, M, N, P, timeout };
  } catch { /* not cached by it: the scores still are */ }
  const base = { aggId, aggregator: aggAddr, phase, startTs, reqBlock, fetchedAt, jury };
  if (!FINAL_PHASES.has(phase)) {
    // Still running (re-read next pass), or dead with no scores (final).
    if (!DEAD_PHASES.has(phase)) return { ...base, finalized: false, finalAccept: null, settled: false, reveals: [] };
    return { ...base, finalized: false, finalAccept: null, settled: true, reveals: [], ...(await roundMoney(ctx, aggAddr, aggId, info, phase)) };
  }

  // The result's shape decides the FUND index (BountyRules.judge: len - 1, len 1 or 2 only).
  const ev = await aggCall(ctx, aggAddr, 'getEvaluation', [aggId]);
  const len = ev.aggregated.length;
  const badShape = len !== 1 && len !== 2;
  const fundIdx = Math.max(0, len - 1);
  const finalAccept = len ? round2(fundScore(ev.aggregated[fundIdx])) : null;
  const os = await aggCall(ctx, aggAddr, 'getOutcomeScores', [aggId, fundIdx]);
  const fund = os.valid ? os.scores.map((x) => x.toString()) : [];
  const n = fund.length;

  // Reveal order -> slots (counted RevealReceived), late reveals, and the cluster (BonusPayment).
  const deadline = Number(info.deadline) || startTs;
  const span = Math.max(0, deadline - startTs) + EVENT_SLACK_SECONDS;
  const toBlock = Math.min(head, reqBlock + Math.ceil(span / ctx.blockTime));
  const scan = async (name) => {
    const logs = await getLogsChunked(provider, { address: aggAddr, topics: [AGG_IFACE.getEvent(name).topicHash, aggId] }, reqBlock, toBlock);
    return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
      .map((log) => ({ log, e: AGG_IFACE.parseLog(log) })).filter((x) => x.e);
  };
  const [revealLogs, bonusLogs] = [await scan('RevealReceived'), await scan('BonusPayment')];
  const order = [];
  const late = [];
  for (const { log, e } of revealLogs) {
    if (e.args.late) late.push({ slot: Number(e.args.pollIndex), qcode: Number(e.args.qcode), block: log.blockNumber });
    else order.push({ slot: Number(e.args.pollIndex), block: log.blockNumber });
  }
  // No BonusPayment (zero fees, or bonusMultiplier 0): the cluster is unknown, not empty.
  const cluster = bonusLogs.length ? [...new Set(bonusLogs.map(({ e }) => Number(e.args.pollIndex)))] : null;

  // The scores are authoritative; if the scan missed reveals, keep them without an arbiter.
  const known = order.length === n;
  const reveals = [];
  for (let i = 0; i < n; i++) {
    const at = known ? order[i] : { slot: null, block: null };
    let operator = null;
    let key = null;
    let jobId = null;
    if (known) {
      const sl = (await aggCall(ctx, aggAddr, 'getSlot', [aggId, at.slot]))[0];
      operator = lc(sl.oracle);
      key = lc(sl.key);
      jobId = await jobIdOfKey(ctx, aggAddr, sl.key);
    }
    reveals.push({ slot: at.slot, operator, key, jobId, block: at.block, fund: fund[i] });
  }

  return { ...base, finalized: true, finalAccept, outcomes: len, badShape, settled: true, arbitersKnown: known,
    cluster: known ? cluster : null, late, reveals, ...(await roundMoney(ctx, aggAddr, aggId, info, phase)) };
}

/**
 * Where an ended round's unspent prepay went, and whether it ran a beacon stage (analytics' v2
 * section). A finalized round refunds the requester; a cancelled one (phase 9) sends everything
 * received to the treasury (RoundCancelled); a failed one (phase 8) emits RequesterRefunded, whose
 * payee is the treasury for a missed beacon quorum, a commit phase with M commits never closed or
 * promoted, or a failed draw after beacons when the walk does not scan the whole class.
 * Returns { beacons, failPhase, refundedWei, toTreasuryWei } (null: the event was not found).
 */
async function roundMoney(ctx, aggAddr, aggId, info, phase) {
  if (phase === 9) {
    return { beacons: null, failPhase: null, refundedWei: '0', toTreasuryWei: info.received.toString() };
  }
  // A failed round's refund comes when it is settled, possibly well after the deadline (or, for a
  // failed draw, within the draw's 1-day limit): scan a day past either.
  const startTs = Number(info.requestTime);
  const reqBlock = Number(info.requestBlock);
  const end = Math.max(Number(info.deadline) || startTs, startTs) + (phase === 8 ? 86400 : 0) + EVENT_SLACK_SECONDS;
  const toBlock = Math.min(ctx.head, reqBlock + Math.ceil((end - startTs) / ctx.blockTime));
  const scan = async (name) => (await getLogsChunked(ctx.provider,
    { address: aggAddr, topics: [AGG_IFACE.getEvent(name).topicHash, aggId] }, reqBlock, toBlock))
    .map((log) => AGG_IFACE.parseLog(log)).filter(Boolean);
  const beaconLogs = await scan('BeaconStageStarted');
  const beacons = beaconLogs.length ? Number(beaconLogs[0].args.beacons) : 0;
  if (phase !== 8) return { beacons, failPhase: null, refundedWei: null, toTreasuryWei: '0' };
  ctx.treasuries = ctx.treasuries || {};
  if (!ctx.treasuries[aggAddr]) ctx.treasuries[aggAddr] = lc((await aggCall(ctx, aggAddr, 'treasury', []))[0]);
  const [refunds, fails] = [await scan('RequesterRefunded'), await scan('EvaluationFailed')];
  let refunded = 0n;
  let toTreasury = 0n;
  for (const e of refunds) {
    if (lc(e.args.requester) === ctx.treasuries[aggAddr]) toTreasury += e.args.amount;
    else refunded += e.args.amount;
  }
  return {
    beacons,
    failPhase: fails.length ? Number(fails[0].args.phase) : null,
    refundedWei: refunded.toString(),
    toTreasuryWei: toTreasury.toString()
  };
}

// ------------------------------------------------------------
// State
// ------------------------------------------------------------

function emptyState() {
  return { version: STATE_VERSION, network: NETWORK, rounds: {}, lastRunAt: null, lastError: null };
}

async function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return s.version === STATE_VERSION ? s : emptyState();
  } catch {
    return emptyState();
  }
}

async function writeState(state, file = STATE_FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------

const status = { running: false, done: 0, total: 0, startedAt: null };

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * One incremental pass: fetch every round in the look-back that is not cached
 * yet or was not settled when last read. `targets` = [{ aggId, ts }].
 */
async function runCollection(targets, provider, { file = STATE_FILE, now = Math.floor(Date.now() / 1000) } = {}) {
  if (status.running) return { skipped: true };
  Object.assign(status, { running: true, done: 0, total: 0, startedAt: Date.now() });
  const state = await readState(file);
  let failures = 0;
  try {
    const from = now - LOOKBACK_DAYS * 86400;
    const byId = new Map(targets
      .filter((t) => isRoundId(t.aggId) && (t.ts || 0) >= from && t.aggregator)
      .map((t) => [roundKey(t.jobId, t.aggId), t]));
    const final = (r) => r?.settled;
    const todo = [...byId.keys()].filter((id) => !final(state.rounds[id]));
    status.total = todo.length;
    if (todo.length) {
      const head = await withRetry(() => provider.getBlockNumber());
      const [hb, pb] = await Promise.all([head, head - 1000].map((n) => withRetry(() => provider.getBlock(n))));
      const ctx = { provider, head, headTs: hb.timestamp, blockTime: (hb.timestamp - pb.timestamp) / 1000 || 2 };
      await mapLimit(todo, ROUND_PARALLEL, async (key) => {
        const t = byId.get(key);
        try {
          state.rounds[key] = await fetchRound(ctx, t.aggregator, t.aggId, t.ts);
        } catch (err) {
          failures++;
          logger.warn('[scoreSpread] round fetch failed', { key, msg: (err.shortMessage || err.message || '').slice(0, 120) });
        }
        status.done++;
      });
      state.lastError = failures ? `${failures} of ${todo.length} rounds failed to load; retried next pass` : null;
    } else {
      state.lastError = null;
    }
    // Drop rounds that fell out of the look-back.
    for (const [id, r] of Object.entries(state.rounds)) {
      if ((r.startTs || r.fetchedAt || 0) < from) delete state.rounds[id];
    }
    state.lastRunAt = Date.now();
    await writeState(state, file);
    return { fetched: todo.length - failures, failed: failures };
  } catch (err) {
    state.lastError = String(err.shortMessage || err.message).slice(0, 200);
    state.lastRunAt = Date.now();
    await writeState(state, file).catch(() => {});
    throw err;
  } finally {
    status.running = false;
  }
}

// ------------------------------------------------------------
// Background service
// ------------------------------------------------------------

let timer = null;

/**
 * @param getTargets  async () => [{ jobId, aggId, ts, aggregator }] for every round of every evaluated submission
 * @param getService  () => VerdiktaService (its provider) or null
 */
function startScoreSpreadService(getTargets, getService) {
  if (process.env.SCORE_SPREAD_ENABLED === 'false') {
    logger.info('[scoreSpread] disabled via SCORE_SPREAD_ENABLED=false');
    return;
  }
  const minutes = parseFloat(process.env.SCORE_SPREAD_INTERVAL_MINUTES) || 15;
  const tick = async () => {
    const svc = getService();
    if (!svc) return;
    try {
      const t0 = Date.now();
      const res = await runCollection(await getTargets(), svc.provider);
      if (!res.skipped && res.fetched) logger.info('[scoreSpread] collection complete', { fetched: res.fetched, ms: Date.now() - t0 });
    } catch (err) {
      logger.error('[scoreSpread] collection failed', { msg: err.shortMessage || err.message });
    }
  };
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref();
  logger.info('[scoreSpread] service started', { intervalMinutes: minutes, lookbackDays: LOOKBACK_DAYS });
}

function getStatus() {
  return { ...status };
}

module.exports = {
  startScoreSpreadService,
  runCollection,
  fetchRound,
  buildReport,
  summarizeRounds,
  readState,
  getStatus,
  MAX_REPORT_DAYS,
  // exported for tests
  roundSpread,
  judgeRound,
  submissionRoundIds,
  pooled,
  roundKey,
  jobIdText,
  STATE_FILE
};
