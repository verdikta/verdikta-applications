// The bridge between the poll-only mock aggregator and the real External Adapter. It stands where
// the real network stands: the keeper's selection, K ArbiterOperators, each one's Chainlink job.
// It watches the mock for requests and does for each what those do, with the real EA behind it:
//
//   - the same request to the EA as chainlink-node/basicJobSpec: { id: <job's UUID>, data: { cid, aggId } },
//     with cid = "1:<cids, comma-separated>[:<addendum>]" and aggId = the 0x-hex AggregatorLib writes;
//   - only what the job reads of the answer: data.aggregatedScore and data.justificationCid. A status
//     of 400 or more, or an answer the job could not parse or encode, ends that job with no transaction;
//   - AggregatorRound's rules on every answer (src/aggregatorRound.js), in the order they arrive.
//
// The mock takes the finished result (scriptResult) and the arithmetic of who was paid
// (setRefundAmount), the moment the N-th reveal arrives, whatever other jobs are still out, as the real
// contract finalizes inside that reveal's fulfill. A round that fails stays open at the mock, and only
// finalizeEvaluationTimeout ends it, after responseTimeoutSeconds on the chain's clock, as on the real contract.
//
// The differences from the real thing are listed in stake-attestation/README.md ("The mock bridge").
import crypto from 'node:crypto';
import http from 'node:http';

import { AggregatorRound, REAL_CONFIG } from './aggregatorRound.js';

/** The job's bridge task and maxTaskDuration (chainlink-node/basicJobSpec). */
export const JOB_TIMEOUT_MS = 840_000;

/**
 * POST <ea>/evaluate over node:http: fetch has a five-minute limit on response headers, and the job waits 840 s.
 * Its cancelAll() ends every request still out: a stopping round does not wait for them.
 */
export function evaluateOver(eaUrl, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
  const target = new URL('/evaluate', eaUrl);
  const live = new Set();
  const evaluate = (body) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(target, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch { /* the job's jsonparse task would fail */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    req.on('close', () => live.delete(req));
    live.add(req);
    req.end(payload);
  });
  evaluate.cancelAll = () => {
    const out = live.size;
    for (const req of live) req.destroy(new Error('the round is stopping'));
    return out;
  };
  return evaluate;
}

/** The job's parse_scores, parse_cid and encode_data tasks: null when one of them would fail. */
export function readJobAnswer(answer) {
  if (!answer || answer.status >= 400) return null;
  const scores = answer.json?.data?.aggregatedScore;
  const cid = answer.json?.data?.justificationCid;
  if (!Array.isArray(scores) || scores.length === 0 || typeof cid !== 'string') return null;
  const response = [];
  for (const v of scores) {
    if (!/^(0|[1-9][0-9]*)$/.test(String(v))) return null;
    const big = BigInt(String(v));
    if (big >= 1n << 256n) return null;
    response.push(big);
  }
  return { response, cid };
}

const hexOf = (id) => String(id).toLowerCase();

/**
 * @param {object} o
 * @param {object} o.mock - the MockVerdiktaAggregator as an ethers Contract, or a double of it
 * @param {(body: object) => Promise<{status: number, json: object|null}>} o.evaluate - one call to the EA
 * @param {string} o.operator - the EA's OPERATOR_ADDR: every slot here is one operator's job
 * @param {bigint} o.requestedClass - the class these jobs are registered on (code-standard)
 * @param {(line: string) => void} [o.log]
 * @param {object} [o.config] - REAL_CONFIG by default
 * @param {number} [o.pollMs]
 */
export function createBridge({ mock, evaluate, operator, requestedClass, log = () => {}, config = REAL_CONFIG, pollMs = 250 }) {
  const rounds = new Map(); // aggId -> the round's record
  const waiters = new Map(); // aggId -> those waiting for its verdict, or for it to have none
  const quietWaiters = new Map(); // aggId -> those waiting for its every job to have answered
  let fromBlock = 0;
  let timer = null;
  let stopped = false;
  let fatal = null;
  const inflight = new Set();

  const multiplier = BigInt(config.k + config.bonus * config.p);

  const wake = (map, aggId, record) => {
    (map.get(aggId) ?? []).forEach((w) => w.resolve(record));
    map.delete(aggId);
  };
  const failAll = (err) => {
    fatal = err;
    for (const map of [waiters, quietWaiters]) {
      for (const list of map.values()) list.forEach((w) => w.reject(err));
      map.clear();
    }
  };
  const waitOn = (map, aggId) => new Promise((resolve, reject) => {
    if (!map.has(aggId)) map.set(aggId, []);
    map.get(aggId).push({ resolve, reject });
  });

  /** The mock's settings the real contract has: maxTotalFee = fee * (K + B * P). */
  async function configure() {
    await (await mock.setFeeMultiplier(multiplier)).wait();
  }

  async function serve(aggId) {
    const record = {
      aggId,
      status: 'serving',
      cids: [],
      addendum: null,
      requestedClass: null,
      polled: config.k,
      jobs: [],
      commits: 0,
      reveals: 0,
      abstained: 0,
      ignored: [],
      reverted: [],
      likelihoods: null,
      justifications: null,
      clustered: 0,
      fee: null,
      required: null,
      spent: null,
      quiet: false,
    };
    rounds.set(aggId, record);
    const cids = [...await mock.getRequestCids(aggId)];
    const params = await mock.requestParams(aggId);
    record.cids = cids;
    record.addendum = params.addendum;
    record.requestedClass = BigInt(params.requestedClass);
    // The real keeper's selection would have reverted the request: no job is registered there.
    if (record.requestedClass !== BigInt(requestedClass)) throw new Error(`a request on class ${record.requestedClass}: no job here serves it, and the real keeper would have refused it`);
    const ceiling = await mock.maxOracleFee();
    const effMaxFee = params.maxFee < ceiling ? params.maxFee : ceiling;
    const required = AggregatorRound.required(effMaxFee, config);
    record.fee = effMaxFee;
    record.required = required;
    const round = new AggregatorRound({ operatorOf: () => operator, fee: effMaxFee, config });
    // What this round spends if it never finishes: the base fees, credited to all K at request.
    await (await mock.setRefundAmount(required - round.baseCredited)).wait();

    // What the real contract does inside the N-th reveal's fulfill: nothing waits for the other jobs.
    const publish = async () => {
      const { likelihoods, justifications, clustered } = round.result;
      record.likelihoods = likelihoods;
      record.justifications = justifications;
      record.clustered = clustered;
      record.spent = round.baseCredited + round.bonusCredited;
      await (await mock.setRefundAmount(required - record.spent)).wait();
      await (await mock.scriptResult(aggId, likelihoods, justifications)).wait();
      record.status = 'fulfilled';
      wake(waiters, aggId, record);
    };

    const jobs = [];
    const job = (slot, cid, phase) => {
      if (stopped) return Promise.resolve(); // a stopping round starts nothing it would have to wait for
      const started = Date.now();
      const entry = { slot, phase, status: null, ms: null, outcome: null, error: null };
      record.jobs.push(entry);
      const running = evaluate({ id: crypto.randomUUID(), data: { cid, aggId: hexOf(aggId) } }).then(
        (answer) => answer,
        (err) => ({ status: 599, json: null, error: err.message }),
      ).then((answer) => {
        entry.status = answer.status;
        entry.ms = Date.now() - started;
        const parsed = readJobAnswer(answer);
        if (!parsed) {
          entry.outcome = 'abstained';
          // Only the round's checks read this: a real job ends here with no transaction, whatever it says.
          entry.error = String(answer.json?.error ?? answer.error ?? '').slice(0, 300);
          record.abstained += 1;
          log(`[bridge] ${phase} slot ${slot}: no transaction (HTTP ${answer.status})`);
          return undefined;
        }
        const effect = round.fulfill(slot, parsed.response, parsed.cid);
        entry.outcome = effect.kind;
        if (effect.kind === 'ignored') record.ignored.push({ slot, phase, reason: effect.reason });
        if (effect.kind === 'reverted') record.reverted.push({ slot, phase, reason: effect.reason });
        if (effect.kind === 'commit' || effect.kind === 'reveal-phase') record.commits += 1;
        if (effect.kind === 'reveal' || effect.kind === 'finalized') record.reveals += 1;
        if (effect.kind === 'reveal-phase') for (const r of effect.reveals) jobs.push(job(r.slot, r.cid, 'reveal'));
        return effect.kind === 'finalized' && !stopped ? publish() : undefined;
      // Handled here and at once: a job further down the list may be out for minutes, and nothing awaits this one until then.
      }).catch(failAll);
      return running;
    };

    if (stopped) return;
    const composed = params.addendum.length > 0 ? `${cids.join(',')}:${params.addendum}` : cids.join(',');
    for (let slot = 0; slot < config.k; slot += 1) jobs.push(job(slot, `1:${composed}`, 'commit'));
    for (let i = 0; i < jobs.length; i += 1) await jobs[i]; // the list grows as reveals go out
    if (fatal) return; // failAll has told whoever waits

    if (!round.isComplete) {
      record.spent = round.baseCredited;
      record.status = 'no-verdict';
    }
    record.quiet = true;
    log(`[bridge] ${aggId.slice(0, 12)}: ${record.status}, ${record.commits} commits, ${record.reveals} reveals, ${record.abstained} jobs with no transaction`);
    wake(waiters, aggId, record);
    wake(quietWaiters, aggId, record);
  }

  let polling = null;
  async function poll() {
    if (stopped) return;
    try {
      const events = await mock.queryFilter(mock.filters.RequestAIEvaluation(), fromBlock);
      if (stopped) return;
      for (const event of events) {
        const aggId = event.args[0];
        fromBlock = Math.max(fromBlock, event.blockNumber + 1);
        if (rounds.has(aggId)) continue;
        const running = serve(aggId).catch(failAll);
        inflight.add(running);
        running.finally(() => inflight.delete(running));
      }
    } catch (err) {
      failAll(err);
    }
    if (!stopped) timer = setTimeout(() => { polling = poll(); }, pollMs);
  }

  return {
    rounds,
    /** Sets the mock up and starts watching from this block. */
    async start(startBlock = 0) {
      fromBlock = startBlock;
      await configure();
      timer = setTimeout(() => { polling = poll(); }, 0);
    },
    /** Resolves with the round's record at its verdict, or once every job has answered with none; rejects if the bridge failed. */
    done(aggId) {
      if (fatal) return Promise.reject(fatal);
      const known = rounds.get(aggId);
      if (known && known.status !== 'serving') return Promise.resolve(known);
      return waitOn(waiters, aggId);
    },
    /** Resolves once every job of the round has answered, the losers of the race too. */
    quiet(aggId) {
      if (fatal) return Promise.reject(fatal);
      const known = rounds.get(aggId);
      if (known?.quiet) return Promise.resolve(known);
      return waitOn(quietWaiters, aggId);
    },
    /** Any failure of the bridge itself, for the round to fail on. */
    failure: () => fatal,
    /** Stops watching and ends every job still out. @returns {Promise<number>} the jobs it cut off */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const cut = evaluate.cancelAll?.() ?? 0;
      await polling; // what it found starts nothing now
      await Promise.allSettled([...inflight]);
      return cut;
    },
  };
}
