// The bridge between the poll-only v2 mock aggregator and the real External Adapter. It stands where
// the real network stands: the block producer, the keeper's selection, K ArbiterOperators, each one's
// Chainlink job. It watches the mock for requests and does for each what those do, with the real EA
// behind it:
//
//   - blocks keep coming: it mines to block B+2 after a request, so drawJury can run, and to C+2 after the
//     commit window closes, so promote can (on the real chain these come by themselves);
//   - the draw is the requester's or anyone's (StakeAttestation.drawJury, the site's keeper): the bridge
//     waits for it, and draws itself only if nobody has after `drawAfterMs`, as any third party may;
//   - the same commit request to the EA as chainlink-node/basicJobSpec: { id: <job's UUID>, data: { cid, aggId } },
//     with cid = "1:<cids, comma-separated>[:<addendum>]" and aggId = the 0x-hex AggregatorLib writes;
//     and, for the M commits promote() draws, the reveal request "2:<the commitment, 64 lowercase hex>";
//   - only what the job reads of the answer: data.aggregatedScore and data.justificationCid. A status
//     of 400 or more, or an answer the job could not parse or encode, ends that job with no transaction;
//   - AggregatorRound's rules on every answer (src/aggregatorRound.js), in the order they arrive. Each
//     commit it records goes to the mock (scriptCommits: the M+-th closes the window there too);
//     closeCommits after T+ with at least M, and promote from C+2, are anyone's: it waits `actAfterMs`
//     for the keeper and then calls them itself. The promotion draw is the real one (the seed from
//     blockhash(C+1)), so the reveal requests go to the slots the real contract would ask.
//
// The mock takes the finished result (scriptResult) the moment the N-th counted reveal arrives, whatever
// other jobs are still out, as the real contract finalizes inside that reveal's fulfill; the mock's own
// arithmetic (the real formula: base fees at the draw, bonuses to P at finalization, the rewards) gives
// the refund. A round that fails stays open at the mock, and only settle ends it after its deadline (from
// the draw), on the chain's clock, as on the real contract (StakeAttestation.finalize tries it).
//
// The differences from the real thing are listed in stake-attestation/README.md ("The mock bridge").
import crypto from 'node:crypto';
import http from 'node:http';

import { AggregatorRound, REAL_CONFIG, promoteSeedOf } from './aggregatorRound.js';

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
const PHASE = Object.freeze({ draw: 1, beacons: 2, commit: 3, closing: 4, reveal: 5, final: 6, settled: 7, failed: 8, cancelled: 9 });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * @param {object} o
 * @param {object} o.mock - the MockVerdiktaAggregator as an ethers Contract (signed by the bridge's account), or a double of it
 * @param {(body: object) => Promise<{status: number, json: object|null}>} o.evaluate - one call to the EA
 * @param {string} o.operator - the EA's OPERATOR_ADDR: every slot here is one operator's job
 * @param {bigint} o.requestedClass - the class these jobs are registered on (code-standard)
 * @param {(line: string) => void} [o.log]
 * @param {object} [o.config] - REAL_CONFIG by default (its timeouts too: a run may lengthen them)
 * @param {number} [o.pollMs]
 * @param {number} [o.drawAfterMs] - how long the bridge leaves the draw to the requester or the keeper
 * @param {number} [o.actAfterMs] - the same for closeCommits after T+ and promote
 * @param {object} [o.chain] - { mine(), now(), blockNumber(), blockHash(n) }: the chain the mock is on (its provider by default)
 */
export function createBridge({ mock, evaluate, operator, requestedClass, log = () => {}, config = REAL_CONFIG, pollMs = 250, drawAfterMs = 30_000, actAfterMs = 10_000, chain = null }) {
  const rounds = new Map(); // aggId -> the round's record
  const waiters = new Map(); // aggId -> those waiting for its verdict, or for it to have none
  const quietWaiters = new Map(); // aggId -> those waiting for its every job to have answered
  let fromBlock = 0;
  let timer = null;
  let stopped = false;
  let fatal = null;
  const inflight = new Set();
  const provider = () => mock.runner?.provider;
  const ch = chain ?? {
    mine: () => provider().send('evm_mine', []),
    now: async () => BigInt((await provider().getBlock('latest')).timestamp),
    blockNumber: async () => BigInt(await provider().getBlockNumber()),
    blockHash: async (n) => (await provider().getBlock(Number(n))).hash,
  };

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
  const mined = async (p) => (await p).wait();

  /** The mock's settings, the real contract's: K, M, N, P, the bonus multiplier, the rewards and the timeouts. */
  async function configure() {
    await mined(mock.setConfig(config.k, config.m, config.n, config.p));
    await mined(mock.setBonusMultiplier(config.bonus));
    await mined(mock.setRewards(config.drawFees, config.promoteFees));
    await mined(mock.setTimeouts(config.responseTimeoutSeconds, config.tPlus, config.revealWindow));
  }

  const info = async (aggId) => {
    const r = await mock.getRoundInfo(aggId);
    return { phase: Number(r.phase ?? r[0]), requestBlock: BigInt(r.requestBlock ?? r[1]), sealedHash: r.sealedHash ?? r[2], closeBlock: BigInt(r.closeBlock ?? r[3]), received: BigInt(r.received ?? r[4]), baseFees: BigInt(r.baseFees ?? r[5]), bonuses: BigInt(r.bonuses ?? r[6]), rewards: BigInt(r.rewards ?? r[7]), deadline: BigInt(r.deadline ?? r[8]), windowEnd: BigInt(r.windowEnd ?? r[9]), commits: Number(r.commits ?? r[10]) };
  };
  /** Mines until block `n` exists: the real chain makes blocks by itself. */
  const mineTo = async (n) => {
    while (!stopped && (await ch.blockNumber()) < n) await ch.mine();
  };
  /** Waits until `ready()` or `ms` have passed; true if it became ready. */
  const until = async (ready, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (stopped) return false;
      if (await ready()) return true;
      if (Date.now() >= end) return false;
      await sleep(pollMs);
    }
  };

  /** What the requester does not get back: the base fees, the bonuses and every reward but its own draw reward. */
  async function spentOf(aggId, record) {
    const r = await info(aggId);
    record.rewards = r.rewards;
    return r.baseFees + r.bonuses + r.rewards - record.requesterDrawReward;
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
      late: 0,
      abstained: 0,
      ignored: [],
      reverted: [],
      likelihoods: null,
      justifications: null,
      clustered: 0,
      fee: null,
      juror: null,
      required: null,
      spent: null,
      rewards: 0n,
      requesterDrawReward: 0n,
      drawnBy: null,
      promotedBy: null,
      closedBy: null,
      quiet: false,
      oracle: null,
    };
    rounds.set(aggId, record);
    const cids = [...await mock.getRequestCids(aggId)];
    const params = await mock.requestParams(aggId);
    record.cids = cids;
    record.addendum = params.addendum;
    record.requestedClass = BigInt(params.requestedClass);
    record.oracle = { alpha: params.alpha, maxFee: params.maxFee, minFee: params.minFee, estimatedBaseCost: params.estimatedBaseCost, maxFeeBasedScaling: params.maxFeeBasedScaling, withBeacons: params.withBeacons };
    // The real keeper's selection would find no juror: no job is registered there.
    if (record.requestedClass !== BigInt(requestedClass)) throw new Error(`a request on class ${record.requestedClass}: no job here serves it, and the real keeper would find no juror`);
    if (params.withBeacons) throw new Error('a request with beacons: the bridge does not stand in for the beacon stage');
    const ceiling = await mock.maxOracleFee();
    const effMaxFee = params.maxFee < ceiling ? params.maxFee : ceiling;
    const minFee = BigInt(params.minFee ?? 0n);
    record.fee = effMaxFee;
    record.juror = minFee > effMaxFee ? minFee : effMaxFee;
    const first = await info(aggId);
    record.required = first.received;

    // ---- the draw: blocks to B+2, then the requester's or the keeper's call, or the bridge's after drawAfterMs
    await mineTo(first.requestBlock + 2n);
    const drawn = await until(async () => (await info(aggId)).phase !== PHASE.draw, drawAfterMs);
    if (stopped) return;
    if (!drawn) {
      log(`[bridge] ${aggId.slice(0, 12)}: nobody drew it in ${drawAfterMs} ms; the bridge draws`);
      try {
        await mined(mock.drawJury(aggId));
      } catch { /* drawn by someone else meanwhile: the phase says so */ }
    }
    let r = await info(aggId);
    const drawEvents = await mock.queryFilter(mock.filters.JuryDrawn(aggId), Number(first.requestBlock)).catch(() => []);
    const drawEvent = drawEvents.at(-1);
    if (drawEvent) {
      record.drawnBy = drawEvent.args[1];
      const requester = await mock.requesterOf(aggId);
      if (hexOf(drawEvent.args[1]) === hexOf(requester)) record.requesterDrawReward = BigInt(drawEvent.args[2]);
    }
    if (r.phase !== PHASE.commit) {
      // failed or cancelled at the draw: no job goes out
      record.status = 'no-verdict';
      record.spent = await spentOf(aggId, record);
      record.quiet = true;
      wake(waiters, aggId, record);
      wake(quietWaiters, aggId, record);
      return;
    }
    const round = new AggregatorRound({ aggId, operatorOf: () => operator, fee: record.juror, sealedHash: r.sealedHash, config });
    const deadline = r.deadline;
    const windowEnd = r.windowEnd;

    // What the real contract does inside the N-th reveal's fulfill: nothing waits for the other jobs.
    const publish = async () => {
      const { likelihoods, justifications, clustered } = round.result;
      record.likelihoods = likelihoods;
      record.justifications = justifications;
      record.clustered = clustered;
      await mined(mock.scriptResult(aggId, likelihoods, justifications));
      record.spent = await spentOf(aggId, record);
      record.status = 'fulfilled';
      wake(waiters, aggId, record);
    };

    let promoting = null;
    /** From C+2: the keeper's promote, or the bridge's after actAfterMs; then the reveal requests the real draw names. */
    const promote = () => {
      promoting ??= (async () => {
        const closed = await info(aggId);
        await mineTo(closed.closeBlock + 2n);
        const done = await until(async () => (await info(aggId)).phase !== PHASE.closing, actAfterMs);
        if (stopped) return;
        if (!done) {
          try {
            await mined(mock.promote(aggId));
            record.promotedBy = 'bridge';
          } catch { /* promoted by someone else, or past the deadline: the phase says which */ }
        }
        if ((await info(aggId)).phase !== PHASE.reveal) return; // past the deadline: no reveal requests
        const seed = promoteSeedOf(aggId, await ch.blockHash(closed.closeBlock + 1n));
        for (const x of round.promote(seed)) jobs.push(job(x.slot, x.cid, 'reveal'));
      })().catch(failAll);
      return promoting;
    };

    const jobs = [];
    const job = (slot, cid, phase) => {
      if (stopped) return Promise.resolve(); // a stopping round starts nothing it would have to wait for
      const started = Date.now();
      const entry = { slot, phase, status: null, ms: null, outcome: null, error: null, scores: null };
      record.jobs.push(entry);
      const running = evaluate({ id: crypto.randomUUID(), data: { cid, aggId: hexOf(aggId) } }).then(
        (answer) => answer,
        (err) => ({ status: 599, json: null, error: err.message }),
      ).then(async (answer) => {
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
        if (phase === 'reveal') entry.scores = parsed.response;
        const now = await ch.now();
        const effect = round.fulfill(slot, parsed.response, parsed.cid, { late: now > deadline, pastWindow: now > windowEnd });
        entry.outcome = effect.kind;
        if (effect.kind === 'ignored') record.ignored.push({ slot, phase, reason: effect.reason });
        if (effect.kind === 'commit' || effect.kind === 'closed') {
          record.commits += 1;
          await mined(mock.scriptCommits(aggId, 1));
        }
        if (effect.kind === 'closed') return promote();
        if (effect.kind === 'reveal' || effect.kind === 'finalized') record.reveals += 1;
        if (effect.kind === 'late') record.late += 1;
        return effect.kind === 'finalized' && !stopped ? publish() : undefined;
      // Handled here and at once: a job further down the list may be out for minutes, and nothing awaits this one until then.
      }).catch(failAll);
      return running;
    };

    if (stopped) return;
    const composed = params.addendum.length > 0 ? `${cids.join(',')}:${params.addendum}` : cids.join(',');
    for (let slot = 0; slot < config.k; slot += 1) jobs.push(job(slot, `1:${composed}`, 'commit'));
    for (let i = 0; i < config.k; i += 1) await jobs[i];
    if (fatal) return;

    // T+: every commit job has answered and the window is still open with at least M: closeCommits, the
    // keeper's or the bridge's once the chain's clock is past T+ (blocks keep coming meanwhile).
    if (round.phase === 'commit' && round.commitHash.size >= config.m) {
      for (;;) {
        if (stopped) return;
        if ((await info(aggId)).phase !== PHASE.commit) break;
        const now = await ch.now();
        if (now > deadline) break;
        if (now > windowEnd) {
          if (!(await until(async () => (await info(aggId)).phase !== PHASE.commit, actAfterMs))) {
            try {
              await mined(mock.closeCommits(aggId));
              record.closedBy = 'bridge';
            } catch { /* closed by someone else, or past the deadline: the phase says which */ }
          }
          break;
        }
        await ch.mine();
        await sleep(Math.max(pollMs, 1000));
      }
      if ((await info(aggId)).phase === PHASE.closing) {
        round.close();
        await promote();
      }
    }
    if (promoting) await promoting;
    for (let i = 0; i < jobs.length; i += 1) await jobs[i]; // the reveal jobs
    if (fatal) return; // failAll has told whoever waits

    if (!round.isComplete) {
      record.spent = await spentOf(aggId, record);
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
    /** Stops watching, ends every job still out, and tells whoever waits. @returns {Promise<number>} the jobs it cut off */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const cut = evaluate.cancelAll?.() ?? 0;
      if (!fatal) failAll(new Error('the bridge was stopped'));
      await polling; // what it found starts nothing now
      await Promise.allSettled([...inflight]);
      return cut;
    },
  };
}
