/**
 * Arbiter score spread: how far apart the arbiters' scores are for the same
 * submission in the same evaluation round.
 *
 * For every bounty submission evaluated by the ReputationAggregator, the round
 * sends reveal requests to the first M=4 arbiters that committed. The
 * aggregator finalizes on the N=3rd valid reveal, and a 4th reveal that lands
 * later is rejected by the aggregator. The operator transaction still
 * succeeds, though, so its scores are on chain in the operator's calldata.
 * This module recovers all 3 or 4 reveals per round:
 *
 *   1. Aggregator logs for the round (topic-filtered by aggId) give the polled
 *      slots, their commit hashes and the reveal-request transaction.
 *   2. That transaction's receipt pairs each ChainlinkRequested(id) with the
 *      RevealRequestDispatched(aggId, slot) emitted right after it, giving the
 *      reveal requestId for each slot.
 *   3. The operator's OracleResponse(requestId) log points at the fulfill tx;
 *      its calldata holds (requestId, scores, "justificationCid:salt").
 *   4. Each reveal is checked against its commit exactly as the aggregator
 *      does: bytes16(sha256(abi.encode(operator, scores, salt))) must equal the
 *      slot's commit hash. Reveals that fail the check are excluded.
 *
 * Metric: scores become shares of 100 (s = 100 * v / sum(v)). A round's spread
 * is the sample standard deviation of those shares across its reveals (for
 * two-outcome bounties, the sd of the "accept" share). The pooled sd across
 * rounds, sqrt(sum (n-1) var / sum (n-1)), is the per-response noise and is
 * the headline number. Same method as verdikta-dispatcher
 * reputationBasedAggregator/scripts/arbiter-noise.js.
 *
 * Settled rounds never change, so they are cached in
 * data/<network>/scoreSpread.json and fetched once; a background pass picks
 * up new rounds. Readers never wait on RPC.
 */

const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
const { config } = require('../config');
const logger = require('./logger');

const NETWORK = config.network || 'base-sepolia';
const STATE_FILE = path.join(__dirname, `../data/${NETWORK}/scoreSpread.json`);
const STATE_VERSION = 1;

const LOOKBACK_DAYS = parseFloat(process.env.SCORE_SPREAD_LOOKBACK_DAYS) || 30; // rounds collected
const MAX_REPORT_DAYS = LOOKBACK_DAYS;
// A round's reveals (including a late 4th) land within minutes of the request.
// Rounds younger than this are re-read on the next pass; older ones are final.
const SETTLE_SECONDS = 60 * 60;
const EVENT_WINDOW_BLOCKS = 2400;  // blocks after the request to look for reveals (~80 min on Base)
const PRE_REQUEST_BLOCKS = 60;     // slack before the estimated request block
const ROUND_PARALLEL = 3;
// Round sd at or below this: the arbiters agree. Above OUTLIER_SD: one or more
// arbiters disagree strongly (usually one outlier, which the closest-pair rule drops).
const AGREE_SD = 2;
const OUTLIER_SD = 10;
// An arbiter's score this far from the other arbiters' mean in the same round counts as far off.
const FAR_GAP = 15;
const ACCEPT_INDEX = 1;            // BountyEscrow: scores[0] = reject, scores[1] = accept

const lc = (s) => String(s || '').toLowerCase();
// Creator-approved submissions never go to the arbiters and carry a zero aggId.
const isRoundId = (id) => /^0x[0-9a-f]{64}$/.test(lc(id)) && !/^0x0{64}$/.test(lc(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// ABIs
// ------------------------------------------------------------

const AGG_IFACE = new ethers.Interface([
  'function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event OracleSelected(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address oracle, bytes32 jobId)',
  'event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)',
  'event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)',
  'event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] likelihoods, string justificationCID)',
  'event ChainlinkRequested(bytes32 indexed id)'
]);
const ROUND_EVENTS = ['RequestAIEvaluation', 'OracleSelected', 'CommitReceived', 'RevealRequestDispatched',
  'NewOracleResponseRecorded', 'FulfillAIEvaluation'];

// ArbiterOperator.fulfillOracleRequestV, or the stock Chainlink Operator's
// fulfillOracleRequest2 (same arguments). data = abi(bytes32, uint256[], string)
// for ReputationAggregator.fulfill.
const OPERATOR_IFACE = new ethers.Interface([
  'function fulfillOracleRequestV(bytes32 requestId,uint256 payment,address callbackAddress,bytes4 callbackFunctionId,uint256 expiration,bytes data)',
  'function fulfillOracleRequest2(bytes32 requestId,uint256 payment,address callbackAddress,bytes4 callbackFunctionId,uint256 expiration,bytes data)',
  'event OracleResponse(bytes32 indexed requestId)'
]);
const CODER = ethers.AbiCoder.defaultAbiCoder();

// ------------------------------------------------------------
// Reveal decoding and commit check (pure)
// ------------------------------------------------------------

function decodeOperatorFulfill(txData) {
  let dec = null;
  for (const fn of ['fulfillOracleRequestV', 'fulfillOracleRequest2']) {
    try { dec = OPERATOR_IFACE.decodeFunctionData(fn, txData); break; } catch { /* try the next one */ }
  }
  if (!dec) throw new Error('not an operator fulfill call');
  const [rid, scores, cid] = CODER.decode(['bytes32', 'uint256[]', 'string'], dec.data);
  return { requestId: lc(rid), callback: lc(dec.callbackAddress), scores: scores.map((x) => x.toString()), cid };
}

/** Split an arbiter reveal "cid:20hexsalt" into { cid, salt }, or null if malformed. */
function parseCidSalt(packed) {
  const i = packed.lastIndexOf(':');
  if (i <= 0 || packed.length - i - 1 !== 20 || !/^[0-9a-fA-F]{20}$/.test(packed.slice(i + 1))) return null;
  return { cid: packed.slice(0, i), salt: BigInt('0x' + packed.slice(i + 1)) };
}

/** The aggregator's commit check: bytes16(sha256(abi.encode(operator, scores, salt))). */
function revealCommitHash(operator, scores, salt) {
  const enc = CODER.encode(['address', 'uint256[]', 'uint256'], [operator, scores.map(BigInt), salt]);
  return lc(ethers.sha256(enc).slice(0, 34));
}

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

/**
 * Spread of one round's verified reveals. Each reveal is { scores: string[] }.
 * Reveals whose vector length differs from the round's most common length are
 * dropped (the aggregator normalizes to the modal length the same way).
 * Returns null when fewer than two usable reveals remain.
 */
function roundSpread(reveals) {
  let vs = reveals
    .map((r) => ({ ...r, vec: (r.scores || []).map(Number) }))
    .filter((r) => r.vec.length >= 2 && r.vec.every(Number.isFinite) && r.vec.reduce((a, b) => a + b, 0) > 0);
  if (vs.length < 2) return null;
  const lens = {};
  for (const v of vs) lens[v.vec.length] = (lens[v.vec.length] || 0) + 1;
  const L = Number(Object.entries(lens).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
  vs = vs.filter((v) => v.vec.length === L);
  if (vs.length < 2) return null;
  const shares = vs.map((v) => { const s = v.vec.reduce((a, b) => a + b, 0); return v.vec.map((x) => (100 * x) / s); });
  const byOutcome = [...Array(L).keys()].map((c) => shares.map((s) => s[c]));
  const varAll = mean(byOutcome.map(variance)); // equals the accept-share variance for 2 outcomes
  const idx = Math.min(ACCEPT_INDEX, L - 1);
  const accept = byOutcome[idx];
  const med = quantile(accept, 0.5);
  return {
    n: vs.length,
    var: varAll,
    sd: Math.sqrt(varAll),
    accept,                      // per reveal, same order as the usable reveals
    used: vs.map((v) => v.slot),
    mean: mean(accept),
    median: med,
    range: Math.max(...accept) - Math.min(...accept),
    maxDev: Math.max(...accept.map((s) => Math.abs(s - med)))
  };
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

// ------------------------------------------------------------
// Report (pure): join cached rounds with bounty/submission data
// ------------------------------------------------------------

/**
 * @param state  cached { rounds: { aggId: record } }
 * @param jobs   bounty jobs (with submissions[].verdiktaAggId)
 * @param opts   { days = 14, now = seconds }
 */
function buildReport(state, jobs, { days = 14, now = Math.floor(Date.now() / 1000) } = {}) {
  const windowDays = Math.max(1, Math.min(MAX_REPORT_DAYS, Math.round(days)));
  const from = now - windowDays * 86400;
  const rounds = state?.rounds || {};

  const samples = [];
  const coverage = { submissions: 0, pending: 0, notFound: 0, tooFewReveals: 0, failedCommitCheck: 0, undecodable: 0 };
  for (const job of jobs || []) {
    for (const sub of job.submissions || []) {
      const aggId = lc(sub.verdiktaAggId);
      if (!isRoundId(aggId)) continue;
      const rec = rounds[aggId];
      const ts = rec?.startTs || sub.submittedAt || 0;
      if (ts < from || ts > now) continue;
      coverage.submissions++;
      if (!rec) { coverage.pending++; continue; }
      if (rec.notFound) { coverage.notFound++; continue; }
      coverage.failedCommitCheck += rec.reveals.filter((r) => r.hashOk === false).length;
      coverage.undecodable += rec.reveals.filter((r) => r.decodeError).length;
      const verified = rec.reveals.filter((r) => r.hashOk === true && r.scores);
      const sp = roundSpread(verified);
      if (!sp) { coverage.tooFewReveals++; continue; }
      const counted = roundSpread(verified.filter((r) => r.counted));
      const acceptBySlot = Object.fromEntries(sp.used.map((slot, i) => [slot, sp.accept[i]]));
      samples.push({
        jobId: job.jobId,
        title: job.title || null,
        threshold: job.threshold ?? null,
        submissionId: sub.submissionId,
        hunter: sub.hunter || null,
        status: sub.onChainStatus || sub.status || null,
        finalScore: rec.finalAccept ?? sub.acceptance ?? null,
        aggId,
        ts,
        n: sp.n,
        sd: round2(sp.sd),
        var: sp.var,
        countedN: counted ? counted.n : 0,
        countedSd: counted ? round2(counted.sd) : null,
        countedVar: counted ? counted.var : null,
        median: round2(sp.median),
        range: round2(sp.range),
        maxDev: round2(sp.maxDev),
        reveals: verified
          .filter((r) => acceptBySlot[r.slot] != null)
          .sort((a, b) => a.block - b.block || a.slot - b.slot)
          .map((r) => ({
            slot: r.slot,
            operator: r.operator,
            jobId: jobIdText(r.jobId),
            accept: round2(acceptBySlot[r.slot]),
            counted: !!r.counted,
            justificationCid: r.cid || null,
            block: r.block
          }))
      });
    }
  }
  samples.sort((a, b) => b.sd - a.sd || b.ts - a.ts);

  const strip = (rs, counted) => rs
    .filter((s) => (counted ? s.countedVar != null : true))
    .map((s) => (counted ? { n: s.countedN, var: s.countedVar } : { n: s.n, var: s.var }));

  // Daily buckets measured back from `now` (newest = daysAgo 0), like the arbiters
  // site's Response Timing chart.
  const daily = [];
  for (let d = windowDays - 1; d >= 0; d--) {
    const hi = now - d * 86400;
    const lo = hi - 86400;
    const p = pooled(strip(samples.filter((s) => s.ts > lo && s.ts <= hi)));
    daily.push({ daysAgo: d, rounds: p.rounds, pooledSd: p.pooledSd, medianRoundSd: p.medianRoundSd, p90RoundSd: p.p90RoundSd });
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
    if (!byBounty.has(s.jobId)) byBounty.set(s.jobId, { jobId: s.jobId, title: s.title, threshold: s.threshold, list: [] });
    byBounty.get(s.jobId).list.push(s);
  }
  const bounties = [...byBounty.values()].map((b) => ({
    jobId: b.jobId, title: b.title, threshold: b.threshold, ...pooled(strip(b.list)),
    lastTs: Math.max(...b.list.map((s) => s.ts))
  })).sort((a, b) => b.pooledSd - a.pooledSd || b.rounds - a.rounds);

  // Per arbiter (operator + jobId): how far each of its scores sits from the mean
  // of the OTHER arbiters in the same round. A consistent sign is a lean (the
  // arbiter scores persistently high or low); a large mean |gap| is noise.
  const arb = new Map();
  for (const s of samples) {
    const total = s.reveals.reduce((acc, r) => acc + r.accept, 0);
    for (const r of s.reveals) {
      const gap = r.accept - (total - r.accept) / (s.reveals.length - 1);
      const key = `${r.operator}:${r.jobId || ''}`;
      if (!arb.has(key)) arb.set(key, { operator: r.operator, jobId: r.jobId, gaps: [], rounds: [] });
      const a = arb.get(key);
      a.gaps.push(gap);
      a.rounds.push({ jobId: s.jobId, submissionId: s.submissionId, gap: round2(gap) });
    }
  }
  const arbiters = [...arb.values()].map((a) => ({
    operator: a.operator,
    jobId: a.jobId,
    reveals: a.gaps.length,
    meanGap: round2(mean(a.gaps)),
    meanAbsGap: round2(mean(a.gaps.map(Math.abs))),
    farFrac: round2(a.gaps.filter((g) => Math.abs(g) > FAR_GAP).length / a.gaps.length),
    worst: [...a.rounds].sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))[0]
  })).sort((x, y) => y.meanAbsGap - x.meanAbsGap || y.reveals - x.reveals);

  return {
    windowDays,
    from,
    to: now,
    thresholds: { agreeSd: AGREE_SD, outlierSd: OUTLIER_SD, farGap: FAR_GAP },
    summary: pooled(strip(samples)),
    summaryCounted: pooled(strip(samples, true)),
    revealCounts: {
      three: samples.filter((s) => s.n === 3).length,
      four: samples.filter((s) => s.n === 4).length,
      other: samples.filter((s) => s.n !== 3 && s.n !== 4).length
    },
    halves,
    daily,
    bounties,
    arbiters,
    samples: samples.map(({ var: _v, countedVar: _cv, ...s }) => s),
    coverage,
    lastRunAt: state?.lastRunAt || null,
    lastError: state?.lastError || null
  };
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

/**
 * Read one round's reveals. ctx = { provider, aggregator (address), head, headTs, blockTime }.
 * `hintTs` (the submission time) decides when an unknown aggId is final.
 * Returns a record suitable for the cache. RPC failures throw, so a round is
 * never cached half-read; it is retried on the next pass.
 */
async function fetchRound(ctx, aggId, hintTs = 0) {
  const { provider, head, headTs, blockTime } = ctx;
  const aggAddr = lc(ctx.aggregator);
  aggId = lc(aggId);

  const statusData = await withRetry(() => provider.call({
    to: aggAddr, data: AGG_IFACE.encodeFunctionData('getAggregationStatus', [aggId])
  }));
  const status = AGG_IFACE.decodeFunctionResult('getAggregationStatus', statusData);
  const startTs = Number(status.startTimestamp);
  const fetchedAt = Math.floor(Date.now() / 1000);
  if (!(startTs > 0)) {
    return { aggId, notFound: true, fetchedAt, settled: hintTs > 0 && headTs - hintTs > SETTLE_SECONDS, reveals: [] };
  }

  // Base has a fixed block time, so the request block is known to within a few blocks.
  const est = head - Math.round((headTs - startTs) / blockTime);
  const fromBlock = Math.max(0, est - PRE_REQUEST_BLOCKS);
  const toBlock = Math.min(head, est + EVENT_WINDOW_BLOCKS);
  const topics = [ROUND_EVENTS.map((n) => AGG_IFACE.getEvent(n).topicHash), aggId];
  const logs = await withRetry(() => provider.getLogs({ address: aggAddr, topics, fromBlock, toBlock }));
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

  const selected = {};
  const commits = {};
  const revealTxs = new Set();
  const countedIds = new Set();
  let reqBlock = null;
  let finalAccept = null;
  let finalized = false;
  for (const log of logs) {
    const ev = AGG_IFACE.parseLog(log);
    if (!ev) continue;
    const a = ev.args;
    switch (ev.name) {
      case 'RequestAIEvaluation': reqBlock = log.blockNumber; break;
      case 'OracleSelected': selected[Number(a.pollIndex)] = { oracle: lc(a.oracle), jobId: lc(a.jobId) }; break;
      case 'CommitReceived': commits[Number(a.pollIndex)] = lc(a.commitHash); break;
      case 'RevealRequestDispatched': revealTxs.add(log.transactionHash); break;
      case 'NewOracleResponseRecorded': countedIds.add(lc(a.requestId)); break;
      case 'FulfillAIEvaluation': {
        finalized = true;
        const lk = a.likelihoods.map(Number);
        const sum = lk.reduce((x, y) => x + y, 0);
        if (lk.length > ACCEPT_INDEX && sum > 0) finalAccept = round2((100 * lk[ACCEPT_INDEX]) / sum);
        break;
      }
      default: break;
    }
  }

  // Pair each reveal dispatch with its operator requestId: dispatchOracleRequest emits
  // ChainlinkRequested(id), then the aggregator emits RevealRequestDispatched(aggId, slot).
  const slotByRequest = new Map();
  let revealReqBlock = null;
  for (const txHash of revealTxs) {
    const rc = await withRetry(() => provider.getTransactionReceipt(txHash));
    if (!rc) continue;
    revealReqBlock = revealReqBlock == null ? rc.blockNumber : Math.min(revealReqBlock, rc.blockNumber);
    const pending = [];
    for (const log of [...rc.logs].sort((x, y) => x.index - y.index)) {
      if (lc(log.address) !== aggAddr) continue;
      let ev;
      try { ev = AGG_IFACE.parseLog(log); } catch { ev = null; }
      if (!ev) continue;
      if (ev.name === 'ChainlinkRequested') pending.push(lc(ev.args.id));
      else if (ev.name === 'RevealRequestDispatched' && lc(ev.args.aggRequestId) === aggId) {
        const rid = pending.pop();
        if (rid) slotByRequest.set(rid, Number(ev.args.pollIndex));
      }
    }
  }

  const reveals = [];
  if (slotByRequest.size) {
    const operators = [...new Set([...slotByRequest.values()].map((s) => selected[s]?.oracle).filter(Boolean))];
    const respTopic = OPERATOR_IFACE.getEvent('OracleResponse').topicHash;
    const respLogs = operators.length ? await withRetry(() => provider.getLogs({
      address: operators,
      topics: [respTopic, [...slotByRequest.keys()]],
      fromBlock: revealReqBlock,
      toBlock: Math.min(head, revealReqBlock + EVENT_WINDOW_BLOCKS)
    })) : [];
    for (const l of respLogs) {
      const rid = lc(l.topics[1]);
      const slot = slotByRequest.get(rid);
      if (slot == null) continue;
      const rec = {
        slot, requestId: rid, operator: lc(l.address), jobId: selected[slot]?.jobId || null,
        block: l.blockNumber, counted: countedIds.has(rid)
      };
      const tx = await withRetry(() => provider.getTransaction(l.transactionHash));
      if (!tx) throw new Error(`fulfill tx ${l.transactionHash} not returned by the RPC`);
      try {
        const dec = decodeOperatorFulfill(tx.data);
        if (dec.requestId !== rid) throw new Error('requestId mismatch');
        if (dec.callback !== aggAddr) throw new Error('callback is not this aggregator');
        rec.scores = dec.scores;
        const cs = parseCidSalt(dec.cid);
        rec.cid = cs ? cs.cid : null;
        const commit = commits[slot];
        rec.hashOk = !cs ? false : (commit ? revealCommitHash(rec.operator, dec.scores, cs.salt) === commit : null);
      } catch (e) {
        rec.decodeError = String(e.shortMessage || e.message).slice(0, 120);
      }
      reveals.push(rec);
    }
  }

  return {
    aggId, startTs, reqBlock, finalized, finalAccept, fetchedAt,
    revealRequests: slotByRequest.size,
    settled: headTs - startTs > SETTLE_SECONDS,
    reveals
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
async function runCollection(targets, provider, aggregator, { file = STATE_FILE, now = Math.floor(Date.now() / 1000) } = {}) {
  if (status.running) return { skipped: true };
  Object.assign(status, { running: true, done: 0, total: 0, startedAt: Date.now() });
  const state = await readState(file);
  let failures = 0;
  try {
    const from = now - LOOKBACK_DAYS * 86400;
    const byId = new Map(targets
      .filter((t) => isRoundId(t.aggId) && (t.ts || 0) >= from)
      .map((t) => [lc(t.aggId), t]));
    const todo = [...byId.keys()].filter((id) => !state.rounds[id]?.settled);
    status.total = todo.length;
    if (todo.length) {
      const head = await withRetry(() => provider.getBlockNumber());
      const [hb, pb] = await Promise.all([head, head - 1000].map((n) => withRetry(() => provider.getBlock(n))));
      const ctx = { provider, aggregator, head, headTs: hb.timestamp, blockTime: (hb.timestamp - pb.timestamp) / 1000 || 2 };
      await mapLimit(todo, ROUND_PARALLEL, async (aggId) => {
        try {
          state.rounds[aggId] = await fetchRound(ctx, aggId, byId.get(aggId).ts);
        } catch (err) {
          failures++;
          logger.warn('[scoreSpread] round fetch failed', { aggId, msg: (err.shortMessage || err.message || '').slice(0, 120) });
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
 * @param getTargets  async () => [{ aggId, ts }] for every evaluated submission
 * @param getService  () => VerdiktaService (provider + aggregator address) or null
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
      const res = await runCollection(await getTargets(), svc.provider, svc.aggregatorAddress);
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
  readState,
  getStatus,
  MAX_REPORT_DAYS,
  // exported for tests
  roundSpread,
  pooled,
  decodeOperatorFulfill,
  parseCidSalt,
  revealCommitHash,
  jobIdText,
  OPERATOR_IFACE,
  STATE_FILE
};
