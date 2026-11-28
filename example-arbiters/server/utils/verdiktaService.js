/**
 * Verdikta Service
 * Read-only access to the v2 ReputationAggregator and ReputationKeeper contracts
 * for arbiter/oracle analytics. One instance is cached per network so the UI
 * can toggle between Base Sepolia and Base mainnet.
 *
 * v2 notes (see dispatcher/reputationBasedAggregator/MIGRATION.md):
 *  - arbiters are keyed by keyOf(oracle, jobId); the keeper has no index getter,
 *    so the registry is rebuilt from its ArbiterRegistered / ArbiterRemoved logs
 *    (scanned incrementally) and each key is read with getArbiter / arbiterClasses /
 *    isFrozen. Status derivation is in utils/arbiterStatus.js;
 *  - rounds are read with getRoundInfo / getSlot and the v2 events; outcome and
 *    blame are in utils/roundModel.js.
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const { networks, normalizeNetwork, getContractsConfig, getRpcUrl, getArchiveRpcUrl, getLogScanRpc, getReceiptRpcUrl, funding } = require('../config');
const {
  STATUSES, DEFAULT_POINTS, DEFAULT_CALL_DEADLINE, deriveStatus, exitState, flagNames, emptyTally, reduceRegistry,
} = require('./arbiterStatus');
const {
  PHASE, PHASE_NAMES, QCODE_NAMES, SKIP_REASONS, decodeSlotFlags, mPlus, describeRound, slotOutcome,
} = require('./roundModel');
const GasReceiptStore = require('./gasReceiptStore');

/**
 * Public RPC endpoints (sepolia.base.org / mainnet.base.org) rate-limit bursts
 * of parallel eth_calls and respond with an empty result. In ethers v6 that
 * surfaces as a CALL_EXCEPTION with `data == null` ("missing revert data") —
 * distinct from a real contract revert, which carries `data`. We retry those
 * transient drops; a genuine revert (with data) is not retried.
 */
function isTransientRpcError(err) {
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION' && (err.data == null)) return true;
  if (['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'BAD_DATA'].includes(err.code)) return true;
  const msg = String(err.message || '');
  return /missing revert data|rate|429|could not coalesce|timeout/i.test(msg);
}

async function withRetry(fn, { retries = 4, delayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientRpcError(err)) throw err;
      // Exponential-ish backoff to let the public RPC recover.
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Used to throttle
 * the per-tx receipt fetches behind gas tracking so the backfill doesn't burst
 * the RPC. Results are returned in input order; a per-item rejection propagates
 * (callers wrap fn to swallow what they want to tolerate).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Summarize a set of gas-receipt records (all one kind) into the shape the
 * analytics UI renders: min/median/max of gas units (the stable, gas-price-
 * independent measure) plus avg/total ETH cost. Returns null for an empty set.
 *
 * gasUsed fits in a JS Number (< 2^53); wei costs are summed as BigInt to avoid
 * precision loss, then formatted to ETH.
 */
function summarizeGas(records) {
  if (!records || !records.length) return null;
  const gas = records.map((r) => Number(r.gasUsed)).sort((a, b) => a - b);
  const n = gas.length;
  const median = n % 2
    ? gas[(n - 1) / 2]
    : Math.round((gas[n / 2 - 1] + gas[n / 2]) / 2);
  const totalCostWei = records.reduce((s, r) => s + BigInt(r.gasCostWei), 0n);
  const totalCostEth = Number(ethers.formatEther(totalCostWei));
  return {
    count: n,
    gasUsed: { min: gas[0], median, max: gas[n - 1] },
    costEth: { avg: totalCostEth / n, total: totalCostEth },
  };
}


// v2 ReputationAggregator: config views, the round/slot views and the ETH ledger.
const AGGREGATOR_ABI = [
  "function keeper() view returns (address)",
  // ETH pull-payment ledger: arbiter owners' base fees, bonuses, committer shares and
  // arbiter pool payouts, anyone's draw / promote rewards and beacon payments, and
  // requesters' refunds. Claimed via withdrawEth(). ethOwed(address(0)) is the arbiter
  // pool, which nobody can withdraw.
  "function ethOwed(address) view returns (uint256)",
  // No K/M/N/P or timeout getters: the jury goes with each request (item 15),
  // bounded by the owner's limits, and getJury(aggId) returns a round's own.
  "function maxJury() view returns (uint8)",
  "function maxTimeout() view returns (uint40)",
  "function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)",
  "function bonusMultiplier() view returns (uint8)",
  "function tPlus() view returns (uint40)",
  "function revealWindow() view returns (uint40)",
  "function maxOracleFee() view returns (uint256)",
  "function drawRewardFees() view returns (uint8)",
  "function promoteRewardFees() view returns (uint8)",
  "function requesterDrawPriority() view returns (uint40)",
  "function settlePerRequest() view returns (uint8)",
  "function dispatchGas() view returns (uint32)",
  "function spreadFloor() view returns (uint256)",
  "function roundCount() view returns (uint256)",
  "function beacons() view returns (address)",
  "function paused() view returns (bool)",
  "function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)",
  "function getSlot(bytes32 aggId, uint256 i) view returns (tuple(address oracle, uint96 fee, bytes32 key, address payee, uint40 committedAt, uint8 flags, uint8 qcode, bytes32 commitHash))",
];

// v2 ReputationKeeper: arbiters keyed by keyOf(oracle, jobId). There is no index
// getter; the registry is rebuilt from ArbiterRegistered / ArbiterRemoved logs.
const KEEPER_ABI = [
  "event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee)",
  "event ArbiterRemoved(bytes32 indexed key, uint256 refunded)",
  "function keyOf(address oracle, bytes32 jobId) pure returns (bytes32)",
  "function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))",
  "function arbiterClasses(bytes32 key) view returns (uint64[])",
  "function isFrozen(bytes32 key) view returns (bool)",
  "function jobIdOf(bytes32 key) view returns (bytes32)",
  "function verdiktaToken() view returns (address)",
  "function owner() view returns (address)",
  "function stakeRequirement() view returns (uint256)",
  "function lockDuration() view returns (uint40)",
  "function decayPeriod() view returns (uint40)",
  "function callDeadline() view returns (uint40)",
  "function unbondingPeriod() view returns (uint40)",
  "function maxOffenses() view returns (uint8)",
  "function burnPerBlock() view returns (uint96)",
  "function burnOnBan() view returns (bool)",
  "function shortlistSize() view returns (uint16)",
  "function maxScan() view returns (uint16)",
  "function liveRandom() view returns (uint8)",
  "function points() view returns (uint16 gain, uint16 minor, uint16 major, uint16 fail, uint16 nocommit, uint16 start, uint16 cap)",
  "function scansAll(uint64 cls) view returns (bool)",
  "function classStats(uint64 cls) view returns (uint256 slots, uint256 listed, uint256 ghosts)",
  // Emitted by applyOutcomes inside the aggregator's settle transaction, so the
  // RoundSettled transaction's receipt holds each arbiter's new scores.
  "event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness)",
  "event OutcomeSkippedFrozen(bytes32 indexed key)",
  "event ArbiterBlocked(bytes32 indexed key, uint256 until, uint256 offenses, uint256 burned)",
];

// JuryBeacons: the beacon arbiters of a round.
const BEACONS_ABI = [
  "function getBeacons(address aggregator, bytes32 aggId) view returns (bytes32[] keys, uint256 atBlock, uint256 deadline)",
];

// Minimal ERC-20 ABI for token metadata (wVDKA, LINK). Each getter is read
// individually and tolerated as missing — not every token implements name().
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
];

// ArbiterOperator (Chainlink Operator) ABI — owner + legacy LINK balance.
// An operator serves one owner and may back several jobIds. Under the ETH aggregator
// (0-juel dispatch) operators accrue NO new LINK — earnings go to ethOwed on the
// aggregator — so withdrawable() reflects only leftover LINK from the old aggregator.
const OPERATOR_ABI = [
  "function owner() view returns (address)",
  "function withdrawable() view returns (uint256)",
  // Node EOAs that submit commit/reveal txs and pay gas — the ETH-funded keys.
  "function getAuthorizedSenders() view returns (address[])"
];

// Chainlink Operator request/response events. Used to derive the per-jobId
// sending key from on-chain fulfillment history (the assignment lives off-chain
// in the node's job spec; on-chain we read it from the fulfillment tx's sender).
const ORACLE_EVENTS_ABI = [
  "event OracleRequest(bytes32 indexed specId, address requester, bytes32 requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
  "event OracleResponse(bytes32 indexed requestId)"
];

// v2 ReputationAggregator round events. Every one has the round id as its
// first, indexed argument, so one OR'd topic0 filter (optionally with topic1 =
// aggId) fetches a round's whole history. The v1 reveal diagnostics
// (RevealHashMismatch …), OracleSelected, RevealRequestDispatched and
// NewOracleResponseRecorded no longer exist: which arbiter sits in a slot, and
// what it did, is read from getSlot().
const AGG_EVENT_ABI = [
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)",
  "event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue)",
  "event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash)",
  "event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)",
  "event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons)",
  "event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)",
  "event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash)",
  "event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock)",
  "event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted)",
  "event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode)",
  "event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)",
  "event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)",
  "event RoundSettled(bytes32 indexed aggRequestId, bool failed)",
  "event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool)",
  "event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount)",
  "event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount)",
  "event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)",
  // a never-promoted round's unspent prepay, one equal share per slot that committed
  "event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)",
  // an eighth of the arbiter pool, paid at a draw to a random registered arbiter's payee
  "event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)",
  "event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason)",
];
// The arbiter pool is the aggregator's ledger entry ethOwed(address(0)): the
// forfeits are RequesterRefunded with requester = address(0), and RoundCancelled.
// Nobody can withdraw it; each draw pays an eighth of it out (PoolPayment).
// The subset the oracle-health scan needs (RequesterRefunded and RoundCancelled
// for the prepay that went to the arbiter pool, CommitPayment for a
// never-promoted round's committer shares, PoolPayment for the pool's payouts,
// SlotSkipped for skipped slots).
const HEALTH_EVENTS = [
  'RequestAIEvaluation', 'JuryDrawn', 'CommitReceived', 'CommitPhaseComplete', 'RevealReceived',
  'FulfillAIEvaluation', 'EvaluationFailed', 'RoundSettled', 'RoundCancelled', 'RequesterRefunded', 'SlotSkipped',
  'CommitPayment', 'PoolPayment',
];

// One log query may stall this long before it's treated as failed. ethers'
// default is 300s: a gateway that accepts the connection and then never answers
// (how some throttle, rather than rejecting) would otherwise pin an analytics
// request for five minutes. Better to fail the chunk and say so.
const LOG_REQUEST_TIMEOUT_MS = 15_000;
const LOG_CHUNK_RETRIES = 2;   // a stalled chunk costs timeout × attempts

// Agg-history scan bounds (blocks). The request block is exact (getRoundInfo),
// so only the end of a round's history has to be estimated.
const AGGH_MAX_SCAN_BLOCKS = 100_000;   // never scan more than this after the request

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_BLOCK_SECONDS = 2;        // Base; measured from headers when possible

class NotConfiguredError extends Error {
  constructor(network) {
    super(`The v2 Verdikta aggregator is not configured for ${network} yet (see server/config.js)`);
    this.code = 'NOT_CONFIGURED';
  }
}

/** Round id (bytes32) for a decimal round number or a bytes32 string; null if neither. */
function toAggId(id) {
  const v = String(id || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  if (/^[0-9]{1,30}$/.test(v) && BigInt(v) > 0n) return ethers.zeroPadValue(ethers.toBeHex(BigInt(v)), 32);
  return null;
}

/**
 * The juries a set of rounds asked for, most used first:
 * [{ K, M, N, P, timeout, rounds }]. Rounds without a jury are skipped.
 */
function juryTally(rounds) {
  const byKey = new Map();
  for (const r of rounds) {
    const j = r.jury;
    if (!j) continue;
    const k = `${j.K}/${j.M}/${j.N}/${j.P}/${j.timeout}`;
    if (!byKey.has(k)) byKey.set(k, { K: j.K, M: j.M, N: j.N, P: j.P, timeout: j.timeout, rounds: 0 });
    byKey.get(k).rounds++;
  }
  return [...byKey.values()].sort((a, b) => b.rounds - a.rounds || a.K - b.K);
}

/** Round number of a sequential v2 aggId (aggId = bytes32(roundId)). */
const roundNumber = (aggId) => Number(BigInt(aggId));

class VerdiktaService {
  constructor(providerUrl, aggregatorAddress, options = {}) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    // Network identity (used in logging / data paths).
    this.networkKey = options.networkKey || 'base-sepolia';
    // null while the v2 deployment is unknown (config placeholder): every chain
    // read then fails with NotConfiguredError instead of hitting a v1 contract.
    this.aggregatorAddress = aggregatorAddress || null;
    this.aggregator = aggregatorAddress
      ? new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, this.provider)
      : null;
    this.reputationKeeper = null;
    this.keeperAddress = null;
    this.linkTokenAddress = options.linkTokenAddress || null;

    // Event-scan floors: the aggregator's deploy block (round events) and the
    // keeper's (registry events; the keeper predates the aggregator).
    this.aggregatorFromBlock = options.aggregatorFromBlock || 0;
    this.keeperFromBlock = options.keeperFromBlock || this.aggregatorFromBlock || 0;

    // Endpoint for historical eth_getLogs, plus the largest block range it will
    // serve in one query — see config.getLogScanRpc(). The two travel together:
    // scanning in chunks bigger than the provider's cap makes every query fail.
    // Lazy-init: only opened when a log scan is requested.
    this.logRpcUrl = (options.logScan && options.logScan.url) || options.archiveRpcUrl || null;
    this.logMaxChunk = (options.logScan && options.logScan.maxChunk) || 10_000;
    this._logProvider = null;

    // RPC for per-tx receipt fetches (gas tracking). Defaults to the read RPC
    // (Infura), overridable via RECEIPT_RPC_URL. Receipts are point lookups, so
    // this need not be the archive endpoint. Lazy-init.
    this.receiptRpcUrl = options.receiptRpcUrl || null;
    this._receiptProvider = null;

    // In-memory caches that let the by-class, by-owner and My Arbiters paths
    // share work. getAllOracles is the heavy enumeration; owner() is static.
    this._oraclesCache = null;          // { data, ts }
    this._oraclesInflight = null;       // { startedAt, promise } — the running registry walk
    this._oraclesQueued = null;         // promise of the one walk queued behind it
    this._jobSenderInflight = new Map(); // opLower|jobIds → in-flight sender scan
    this._registryScan = null;          // { toBlock, events: [] } — keeper logs scanned so far
    this._registryPromise = null;       // in-flight incremental scan (shared)
    this._statusCtx = null;             // { value, ts } — keeper/aggregator config status derivation needs
    this._juryCache = new Map();        // aggIdLower → the round's jury (fixed at request)
    this._slotCache = new Map();        // aggIdLower → slots (only for settled/cancelled rounds: final)
    this._blockSeconds = null;          // { value, ts }
    this._ownerMap = {};                // { operatorLower: { owner, ts } }
    this._senderMap = {};               // { operatorLower: { senders: [addr], ts } }
    this._gasPrice = null;              // { value: bigint, ts }
    this._jobSenderCache = {};          // { operatorLower: { map, ts } }
  }

  /** The aggregator contract, or throw NotConfiguredError (placeholder address). */
  _agg() {
    if (!this.aggregator) throw new NotConfiguredError(this.networkKey);
    return this.aggregator;
  }

  /** Provider for historical log scans. Falls back to the read RPC. */
  _getLogProvider() {
    if (!this._logProvider) {
      const url = this.logRpcUrl;
      if (url) {
        const req = new ethers.FetchRequest(url);
        req.timeout = LOG_REQUEST_TIMEOUT_MS;
        this._logProvider = new ethers.JsonRpcProvider(req);
      } else {
        this._logProvider = this.provider;
      }
    }
    return this._logProvider;
  }

  /** Provider for receipt fetches (gas tracking). Falls back to the read RPC. */
  _getReceiptProvider() {
    if (!this._receiptProvider) {
      const url = this.receiptRpcUrl;
      this._receiptProvider = url ? new ethers.JsonRpcProvider(url) : this.provider;
    }
    return this._receiptProvider;
  }


  /**
   * Get ReputationKeeper contract instance (lazy-loaded from aggregator.keeper()).
   */
  async getReputationKeeper() {
    if (!this.reputationKeeper) {
      try {
        this.keeperAddress = await withRetry(() => this._agg().keeper());
        this.reputationKeeper = new ethers.Contract(this.keeperAddress, KEEPER_ABI, this.provider);
        logger.info('ReputationKeeper loaded', { network: this.networkKey, address: this.keeperAddress });
      } catch (error) {
        logger.error('Failed to get ReputationKeeper address', { network: this.networkKey, msg: error.message });
        throw error;
      }
    }
    return this.reputationKeeper;
  }

  /**
   * Seconds per block, measured from two headers ~10k blocks apart (cached 1 h).
   * The timing and daily-bucket maths use it instead of assuming Base's 2 s.
   */
  async getBlockSeconds() {
    if (this._blockSeconds && Date.now() - this._blockSeconds.ts < 3600_000) return this._blockSeconds.value;
    let value = DEFAULT_BLOCK_SECONDS;
    try {
      const latest = await withRetry(() => this.provider.getBlockNumber());
      const span = Math.min(10_000, latest);
      if (span > 0) {
        const [a, b] = await Promise.all([
          withRetry(() => this.provider.getBlock(latest - span)),
          withRetry(() => this.provider.getBlock(latest)),
        ]);
        if (a && b && b.timestamp > a.timestamp) value = (Number(b.timestamp) - Number(a.timestamp)) / span;
      }
    } catch (err) {
      logger.warn('block time measurement failed; assuming 2 s', { network: this.networkKey, msg: err.message });
    }
    this._blockSeconds = { value, ts: Date.now() };
    return value;
  }

  /**
   * Aggregator configuration (v2 getters). One aggregator serves every jury
   * size: each request carries its own jury (K drawn, M promoted, N counted, P
   * clustered, and the round timeout from the draw; see getJury), so the config
   * holds only the owner's bounds on it: K <= maxJury (and the keeper's
   * shortlist), T+ < timeout <= maxTimeout.
   */
  async getAggregatorConfig() {
    const agg = this._agg();
    try {
      const [maxJury, maxTimeout, bonusMultiplier, maxOracleFee] = await Promise.all([
        withRetry(() => agg.maxJury()),
        withRetry(() => agg.maxTimeout()),
        withRetry(() => agg.bonusMultiplier()),
        withRetry(() => agg.maxOracleFee()),
      ]);
      // The rest is read tolerantly: a missing getter yields null, not a failed page.
      const num = (fn) => withRetry(fn).then((v) => Number(v)).catch(() => null);
      const str = (fn) => withRetry(fn).then((v) => String(v)).catch(() => null);
      const [
        tPlus, revealWindow, drawRewardFees, promoteRewardFees, requesterDrawPriority,
        settlePerRequest, dispatchGas, spreadFloor, roundCount, poolWei, beacons, paused,
      ] = await Promise.all([
        num(() => agg.tPlus()),
        num(() => agg.revealWindow()),
        num(() => agg.drawRewardFees()),
        num(() => agg.promoteRewardFees()),
        num(() => agg.requesterDrawPriority()),
        num(() => agg.settlePerRequest()),
        num(() => agg.dispatchGas()),
        num(() => agg.spreadFloor()),
        num(() => agg.roundCount()),
        // the arbiter pool's balance: ethOwed(address(0))
        withRetry(() => agg.ethOwed(ZERO_ADDRESS)).catch(() => null),
        str(() => agg.beacons()),
        withRetry(() => agg.paused()).then(Boolean).catch(() => null),
      ]);
      return {
        maxJury: Number(maxJury),
        maxTimeout: Number(maxTimeout),
        bonusMultiplier: Number(bonusMultiplier),
        tPlus,
        revealWindow,
        maxOracleFee: ethers.formatEther(maxOracleFee),
        maxOracleFeeWei: maxOracleFee.toString(),
        drawRewardFees,
        promoteRewardFees,
        requesterDrawPriority,
        settlePerRequest,
        dispatchGas,
        spreadFloor,
        roundCount,
        poolEth: poolWei != null ? ethers.formatEther(poolWei) : null,
        beacons: beacons && beacons !== ZERO_ADDRESS ? beacons : null,
        paused,
      };
    } catch (error) {
      logger.error('Failed to get aggregator config', { network: this.networkKey, msg: error.message });
      throw error;
    }
  }

  /**
   * ReputationKeeper config for the /contracts page: stake, penalties (Table 2),
   * liveness, selection tuning and the score points (Table 1). Each field is
   * read tolerantly (null on failure).
   */
  async getKeeperConfig() {
    const keeper = await this.getReputationKeeper();
    const num = (fn) => withRetry(fn).then((v) => Number(v)).catch(() => null);
    const ether = (fn) => withRetry(fn).then((v) => ethers.formatEther(v)).catch(() => null);
    const [
      stakeRequirement, lockDurationSeconds, decayPeriodSeconds, callDeadlineSeconds, unbondingPeriodSeconds,
      maxOffenses, burnPerBlock, burnOnBan, shortlistSize, maxScan, liveRandom, points, owner,
    ] = await Promise.all([
      ether(() => keeper.stakeRequirement()),
      num(() => keeper.lockDuration()),
      num(() => keeper.decayPeriod()),
      num(() => keeper.callDeadline()),
      num(() => keeper.unbondingPeriod()),
      num(() => keeper.maxOffenses()),
      ether(() => keeper.burnPerBlock()),
      withRetry(() => keeper.burnOnBan()).then(Boolean).catch(() => null),
      num(() => keeper.shortlistSize()),
      num(() => keeper.maxScan()),
      num(() => keeper.liveRandom()),
      withRetry(() => keeper.points()).then((p) => ({
        gain: Number(p.gain), minor: Number(p.minor), major: Number(p.major), fail: Number(p.fail),
        nocommit: Number(p.nocommit), start: Number(p.start), cap: Number(p.cap),
      })).catch(() => null),
      withRetry(() => keeper.owner()).then(String).catch(() => null),
    ]);
    return {
      stakeRequirement, lockDurationSeconds, decayPeriodSeconds, callDeadlineSeconds, unbondingPeriodSeconds,
      maxOffenses, burnPerBlock, burnOnBan, shortlistSize, maxScan, liveRandom, points, owner,
    };
  }

  /**
   * What status derivation needs from the contracts (points, callDeadline, the
   * aggregator's fee ceiling), plus the stake requirement and unbonding period
   * for the My Arbiters UI. Cached 5 min; falls back to the keeper defaults.
   */
  async _getStatusCtx() {
    if (this._statusCtx && Date.now() - this._statusCtx.ts < 300_000) return this._statusCtx.value;
    const keeper = await this.getReputationKeeper();
    const [points, callDeadline, stakeRequirement, unbondingPeriod, maxOracleFee] = await Promise.all([
      withRetry(() => keeper.points()).then((p) => ({
        gain: Number(p.gain), minor: Number(p.minor), major: Number(p.major), fail: Number(p.fail),
        nocommit: Number(p.nocommit), start: Number(p.start), cap: Number(p.cap),
      })).catch(() => DEFAULT_POINTS),
      withRetry(() => keeper.callDeadline()).then(Number).catch(() => DEFAULT_CALL_DEADLINE),
      withRetry(() => keeper.stakeRequirement()).catch(() => null),
      withRetry(() => keeper.unbondingPeriod()).then(Number).catch(() => null),
      withRetry(() => this._agg().maxOracleFee()).catch(() => null),
    ]);
    const value = { points, callDeadline, stakeRequirementWei: stakeRequirement, unbondingPeriod, maxOracleFeeWei: maxOracleFee };
    this._statusCtx = { value, ts: Date.now() };
    return value;
  }

  /**
   * The keeper's ArbiterRegistered / ArbiterRemoved logs, scanned incrementally
   * from keeperFromBlock (only new blocks after the first call). A failed chunk
   * fails the whole call without advancing, so the registry is never built from
   * a partial history.
   * @returns {Promise<Array>} decoded events (see arbiterStatus.reduceRegistry)
   */
  async _getRegistryEvents() {
    if (this._registryPromise) return this._registryPromise;
    this._registryPromise = (async () => {
      const keeper = await this.getReputationKeeper();
      const provider = this._getLogProvider();
      const iface = keeper.interface;
      const regTopic = iface.getEvent('ArbiterRegistered').topicHash;
      const remTopic = iface.getEvent('ArbiterRemoved').topicHash;
      const latest = await withRetry(() => provider.getBlockNumber());
      const prev = this._registryScan;
      const from = prev ? prev.toBlock + 1 : this.keeperFromBlock;
      const events = prev ? [...prev.events] : [];
      if (from <= latest) {
        const ranges = [];
        for (let start = from; start <= latest; start += this.logMaxChunk) {
          ranges.push({ start, end: Math.min(start + this.logMaxChunk - 1, latest) });
        }
        const found = [];
        await mapWithConcurrency(ranges, 4, async ({ start, end }) => {
          const logs = await withRetry(() => provider.getLogs({
            address: this.keeperAddress, topics: [[regTopic, remTopic]], fromBlock: start, toBlock: end,
          }), { retries: LOG_CHUNK_RETRIES });
          for (const log of logs) {
            let p;
            try { p = iface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
            found.push({
              name: p.name,
              key: String(p.args.key),
              oracle: p.name === 'ArbiterRegistered' ? ethers.getAddress(p.args.oracle) : undefined,
              jobId: p.name === 'ArbiterRegistered' ? String(p.args.jobId) : undefined,
              fee: p.name === 'ArbiterRegistered' ? p.args.fee : undefined,
              blockNumber: log.blockNumber,
              logIndex: log.index,
            });
          }
        });
        events.push(...found);
        if (!prev) logger.info('keeper registry scanned', { network: this.networkKey, fromBlock: from, toBlock: latest, events: found.length, chunks: ranges.length });
      }
      this._registryScan = { toBlock: latest, events };
      return events;
    })();
    try {
      return await this._registryPromise;
    } finally {
      this._registryPromise = null;
    }
  }

  /** Live (registered, not removed) arbiters from the keeper logs: Map keyLower → entry. */
  async getRegistry() {
    return reduceRegistry(await this._getRegistryEvents());
  }

  /**
   * Total registered arbiters (live keys in the keeper's logs).
   */
  async getOracleCount() {
    try {
      return (await this.getRegistry()).size;
    } catch (error) {
      logger.error('Failed to get arbiter count', { network: this.networkKey, msg: error.message });
      throw error;
    }
  }

  /**
   * Read one arbiter's live state: getArbiter + arbiterClasses + isFrozen, and
   * derive its display status (utils/arbiterStatus.deriveStatus).
   */
  async _readArbiter(entry, ctx, now) {
    const keeper = await this.getReputationKeeper();
    const [a, classes, frozen] = await Promise.all([
      withRetry(() => keeper.getArbiter(entry.key)),
      withRetry(() => keeper.arbiterClasses(entry.key)),
      withRetry(() => keeper.isFrozen(entry.key)).catch(() => null),
    ]);
    const rec = {
      key: entry.key,
      oracle: ethers.getAddress(a.oracle),
      jobId: entry.jobId,
      classes: classes.map((c) => Number(c)),
      qualityScore: Number(a.quality),
      timelinessScore: Number(a.timeliness),
      offenses: Number(a.offenses),
      flags: Number(a.flags),
      flagNames: flagNames(a.flags),
      blockedUntil: Number(a.blockedUntil),
      fee: ethers.formatEther(a.fee),
      feeWei: a.fee.toString(),
      callSentAt: Number(a.callSentAt),
      callAnsweredAt: Number(a.callAnsweredAt),
      stake: ethers.formatEther(a.stake),
      stakeWei: a.stake.toString(),
      exitAt: Number(a.exitAt),
      frozen: frozen == null ? null : Boolean(frozen),
      registeredBlock: entry.registeredBlock,
    };
    const st = deriveStatus(
      { flags: rec.flags, quality: rec.qualityScore, timeliness: rec.timelinessScore, offenses: rec.offenses,
        blockedUntil: rec.blockedUntil, callSentAt: rec.callSentAt, feeWei: a.fee, frozen: rec.frozen },
      { now, points: ctx.points, callDeadline: ctx.callDeadline, maxOracleFeeWei: ctx.maxOracleFeeWei },
    );
    rec.status = st.status;
    rec.statusReasons = st.reasons;
    rec.selectable = st.selectable;
    rec.exit = exitState(rec, now);
    rec.understakedBy = ctx.stakeRequirementWei != null && a.stake < ctx.stakeRequirementWei
      ? ethers.formatEther(ctx.stakeRequirementWei - a.stake)
      : null;
    // F_UNDERSTAKED is only re-evaluated on a stake change (topUpStake, a burn),
    // so a stake short of a raised requirement keeps being selected until then.
    rec.understakedUnflagged = rec.understakedBy != null && !(rec.flags & 32);
    return rec;
  }

  /**
   * Every registered arbiter with its live state and status (batched).
   *
   * Memoized per service instance so the by-class, by-owner and My Arbiters
   * paths can share one registry walk. Pass { maxAgeMs: 0 } to force a fresh
   * read (e.g. right after an exit or registration tx).
   *
   * A key that can't be read (after retries) yields { key, oracle, error } rather
   * than failing the whole dataset, so partial data still renders.
   */
  async getAllOracles({ maxAgeMs = 60000 } = {}) {
    const askedAt = Date.now();
    if (this._oraclesCache && askedAt - this._oraclesCache.ts < maxAgeMs) {
      return this._oraclesCache.data;
    }
    // Coalesce: at most one walk runs at a time. A caller joins the running walk
    // when it started recently enough for its maxAgeMs; otherwise it waits for one
    // queued walk that starts after the running one ends (so a "fresh" read never
    // gets data from before it asked). Without this, every anonymous
    // /api/arbiters/owned request (maxAgeMs 0) paid 3 RPC calls per arbiter.
    const running = this._oraclesInflight;
    if (running && running.startedAt >= askedAt - maxAgeMs) return running.promise;
    if (running) {
      if (!this._oraclesQueued) {
        this._oraclesQueued = running.promise.catch(() => {}).then(() => {
          this._oraclesQueued = null;
          return this._startOraclesWalk();
        });
      }
      return this._oraclesQueued;
    }
    return this._startOraclesWalk();
  }

  /** One registry walk, registered as the in-flight walk until it settles. */
  _startOraclesWalk() {
    const entry = { startedAt: Date.now(), promise: null };
    entry.promise = this._walkOracles().finally(() => {
      if (this._oraclesInflight === entry) this._oraclesInflight = null;
    });
    this._oraclesInflight = entry;
    return entry.promise;
  }

  async _walkOracles() {
    try {
      const [registry, ctx] = await Promise.all([this.getRegistry(), this._getStatusCtx()]);
      const entries = [...registry.values()];
      logger.info('Fetching all arbiters', { network: this.networkKey, count: entries.length });
      const now = Math.floor(Date.now() / 1000);
      // Small concurrency keeps us under the public RPC's burst limits.
      const oracles = await mapWithConcurrency(entries, 4, (e) =>
        this._readArbiter(e, ctx, now).catch((err) => {
          logger.warn('Failed to read arbiter, skipping', { key: e.key, msg: err.message });
          return { key: e.key, oracle: e.oracle, jobId: e.jobId, error: err.message };
        }));
      this._oraclesCache = { data: oracles, ts: Date.now() };
      return oracles;
    } catch (error) {
      logger.error('Failed to get all arbiters', { network: this.networkKey, msg: error.message });
      throw error;
    }
  }

  /**
   * Arbiter availability per class (model ClassID, e.g. 128): status tallies
   * (see arbiterStatus.STATUSES), average scores, distinct operators and the
   * per-arbiter list, plus the selectable count. The jury size is per request
   * (K <= the aggregator's maxJury), so there is no single K to compare with: a
   * draw with fewer than K selectable arbiters fills the jury with repeats (slot
   * k holds pick k mod m), and only a class with none selectable fails every
   * draw (`short`). `maxJury` is returned for reference.
   * `scansAll` is the keeper's scansAll(cls): false means a draw walks only part
   * of the class list, so a beacon round whose draw then fails pays the
   * arbiter pool, not the requester.
   * `slots` / `listed` / `ghosts` are the keeper's classStats(cls) (review
   * 2026-11-27, item 1): the list's slots (a draw visits at most maxScan of
   * them), the arbiters listed in it, and moved arbiters' old slots still
   * waiting out their day. `maxScan` is returned beside maxJury. null when the
   * keeper has no classStats (an older deployment).
   */
  async getArbiterAvailabilityByClass() {
    try {
      const [oracles, keeper, maxJury] = await Promise.all([
        this.getAllOracles(),
        this.getReputationKeeper(),
        withRetry(() => this._agg().maxJury()).then(Number).catch(() => null),
      ]);
      const byClass = {};

      for (const oracle of oracles) {
        if (oracle.error) continue;
        for (const classId of oracle.classes) {
          if (!byClass[classId]) {
            byClass[classId] = {
              classId,
              ...emptyTally(),
              total: 0,
              selectable: 0,
              avgQualityScore: 0,
              avgTimelinessScore: 0,
              qualityScores: [],
              timelinessScores: [],
              operatorAddresses: new Set(),
              arbiterList: []
            };
          }
          const cls = byClass[classId];
          cls.total++;
          cls[oracle.status]++;
          if (oracle.selectable) cls.selectable++;
          cls.operatorAddresses.add(oracle.oracle.toLowerCase());
          cls.arbiterList.push({
            address: oracle.oracle,
            jobId: oracle.jobId,
            key: oracle.key,
            classes: oracle.classes,
            qualityScore: oracle.qualityScore,
            timelinessScore: oracle.timelinessScore,
            offenses: oracle.offenses,
            fee: oracle.fee,
            status: oracle.status,
            statusReasons: oracle.statusReasons
          });
          cls.qualityScores.push(oracle.qualityScore);
          cls.timelinessScores.push(oracle.timelinessScore);
        }
      }

      // Calculate averages and finalize data
      for (const classId of Object.keys(byClass)) {
        const cls = byClass[classId];
        if (cls.qualityScores.length > 0) {
          cls.avgQualityScore = Math.round(cls.qualityScores.reduce((a, b) => a + b, 0) / cls.qualityScores.length);
          cls.avgTimelinessScore = Math.round(cls.timelinessScores.reduce((a, b) => a + b, 0) / cls.timelinessScores.length);
        }
        cls.operators = cls.operatorAddresses.size;
        cls.operatorList = Array.from(cls.operatorAddresses);
        cls.short = cls.selectable === 0;
        delete cls.qualityScores;
        delete cls.timelinessScores;
        delete cls.operatorAddresses;
      }

      await mapWithConcurrency(Object.keys(byClass), 4, async (classId) => {
        byClass[classId].scansAll = await withRetry(() => keeper.scansAll(BigInt(classId))).then(Boolean).catch(() => null);
        const st = await withRetry(() => keeper.classStats(BigInt(classId))).catch(() => null);
        byClass[classId].slots = st ? Number(st.slots) : null;
        byClass[classId].listed = st ? Number(st.listed) : null;
        byClass[classId].ghosts = st ? Number(st.ghosts) : null;
      });
      const maxScan = await withRetry(() => keeper.maxScan()).then(Number).catch(() => null);

      return {
        byClass,
        maxJury,
        maxScan,
        totalOracles: oracles.filter(o => !o.error).length,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to get arbiter availability', { network: this.networkKey, msg: error.message });
      throw error;
    }
  }

  /**
   * Arbiters owned by a given wallet, grouped by operator contract.
   *
   * Ownership is the operator contract's own `owner()` (Chainlink ConfirmedOwner)
   * — the address the keeper lets pause, re-fee, top up and exit the arbiter, and
   * the one that earns ETH (ethOwed on the aggregator). Claimable ETH is per owner
   * (returned once at the top level as claimableEth); the per-operator
   * withdrawableLink is LEGACY (leftover old-aggregator LINK).
   *
   * The keeper + aggregator addresses, the stake requirement and the unbonding
   * period are returned so the client can build and explain the write txs.
   */
  async getOwnedArbiters(ownerAddress) {
    const target = String(ownerAddress).toLowerCase();
    // Ensure keeperAddress is resolved for the client write path.
    await this.getReputationKeeper();

    const [oracles, ctx] = await Promise.all([
      // Force-fresh so the page reflects state right after a tx.
      this.getAllOracles({ maxAgeMs: 0 }),
      this._getStatusCtx(),
    ]);

    // Distinct operator contracts (skip keys that failed to read).
    const operatorAddrs = [...new Set(oracles.filter(o => !o.error && o.oracle).map(o => o.oracle))];

    // owner() per operator from the shared cache (re-read after 60 s, so an
    // ownership transfer shows within a minute), then withdrawable() only for
    // the operators this wallet owns. Reading both for every operator on every
    // anonymous request let any caller make the server spend 2 RPC calls per
    // operator. Failures are tolerated so one bad operator doesn't sink the list.
    const ownerMap = await this.getOwnerMap(operatorAddrs, { maxAgeMs: 60_000 });
    const mine = operatorAddrs.filter((a) => String(ownerMap[a.toLowerCase()] || '').toLowerCase() === target);
    const withdrawableMap = mine.length ? await this.getWithdrawableMap(mine) : {};
    const ownerInfo = {};
    for (const addr of operatorAddrs) {
      const k = addr.toLowerCase();
      ownerInfo[k] = { owner: ownerMap[k] || null, withdrawable: withdrawableMap[k] ?? null };
    }

    const byOperator = {};
    for (const oracle of oracles) {
      if (oracle.error || !oracle.oracle) continue;
      const info = ownerInfo[oracle.oracle.toLowerCase()];
      if (!info || !info.owner || info.owner.toLowerCase() !== target) continue;

      if (!byOperator[oracle.oracle]) {
        byOperator[oracle.oracle] = {
          operator: oracle.oracle,
          owner: info.owner,
          withdrawableLink: info.withdrawable != null ? ethers.formatEther(info.withdrawable) : null,
          jobs: []
        };
      }

      byOperator[oracle.oracle].jobs.push({
        key: oracle.key,
        jobId: oracle.jobId,
        classes: oracle.classes,
        status: oracle.status,
        statusReasons: oracle.statusReasons,
        selectable: oracle.selectable,
        flags: oracle.flags,
        flagNames: oracle.flagNames,
        frozen: oracle.frozen,
        blockedUntil: oracle.blockedUntil,
        callSentAt: oracle.callSentAt,
        callAnsweredAt: oracle.callAnsweredAt,
        exitAt: oracle.exitAt,
        exit: oracle.exit,
        stake: oracle.stake,           // formatted ether string ("100.0")
        stakeWei: oracle.stakeWei,
        understakedBy: oracle.understakedBy,
        understakedUnflagged: oracle.understakedUnflagged,
        fee: oracle.fee,
        feeWei: oracle.feeWei,
        offenses: oracle.offenses,
        qualityScore: oracle.qualityScore,
        timelinessScore: oracle.timelinessScore
      });
    }

    // Attach per-operator ETH funding (node sending-key balances + estimate).
    const ownedOps = Object.keys(byOperator);
    if (ownedOps.length) {
      const { perOp, gasPrice } = await this._computeFunding(ownedOps);
      for (const opAddr of ownedOps) {
        byOperator[opAddr].funding = this._fundingForClient(
          perOp[opAddr.toLowerCase()] || { senders: [], totalWei: 0n },
          gasPrice
        );
      }
    }

    // Attach per-jobId sender (derived from fulfillment-history log scan via
    // the archive RPC; null for never-used arbiters). Operators are scanned in
    // parallel; failures are logged and leave job.sender = null without
    // breaking the listing.
    if (ownedOps.length) {
      await Promise.all(ownedOps.map(async (opAddr) => {
        const opData = byOperator[opAddr];
        try {
          const senderMap = await this.getJobSenderMap(opAddr, opData.jobs.map((j) => j.jobId));
          for (const job of opData.jobs) {
            job.sender = senderMap[String(job.jobId).toLowerCase()] || null;
          }
        } catch (err) {
          logger.warn('per-jobId sender scan failed', { operator: opAddr, msg: err.message });
          for (const job of opData.jobs) job.sender = null;
        }
      }));
    }

    // Live claimable ETH is per-OWNER (ethOwed on the aggregator): base fees,
    // bonuses, committer shares and arbiter pool payouts across all the owner's
    // operators, plus any draw / promote rewards and
    // requester refunds this wallet earned.
    const ethOwedWei = await this.getEthOwed(ownerAddress);

    return {
      owner: ownerAddress,
      keeperAddress: this.keeperAddress,
      aggregatorAddress: this.aggregatorAddress,
      stakeRequirement: ctx.stakeRequirementWei != null ? ethers.formatEther(ctx.stakeRequirementWei) : null,
      unbondingPeriodSeconds: ctx.unbondingPeriod,
      callDeadlineSeconds: ctx.callDeadline,
      maxOracleFee: ctx.maxOracleFeeWei != null ? ethers.formatEther(ctx.maxOracleFeeWei) : null,
      claimableEth: ethOwedWei != null ? ethers.formatEther(ethOwedWei) : null,
      operators: Object.values(byOperator),
      timestamp: Date.now()
    };
  }

  /**
   * Read a contract method for many operator addresses in small batches, with
   * retry, tolerating per-operator failures (returns null for those).
   */
  async _batchOperatorRead(operatorAddrs, method) {
    const out = {};
    const batchSize = 6;
    for (let i = 0; i < operatorAddrs.length; i += batchSize) {
      const slice = operatorAddrs.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        out[addr.toLowerCase()] = await withRetry(() => op[method]()).catch(() => null);
      }));
    }
    return out;
  }

  /**
   * operator (lowercased) -> owner address. owner() is effectively static, so
   * results are cached per instance and only re-read when missing or stale.
   */
  async getOwnerMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const stale = operatorAddrs.filter((a) => {
      const e = this._ownerMap[a.toLowerCase()];
      return !e || now - e.ts >= maxAgeMs;
    });
    if (stale.length) {
      const fresh = await this._batchOperatorRead(stale, 'owner');
      for (const [addr, owner] of Object.entries(fresh)) {
        this._ownerMap[addr] = { owner: owner ? String(owner) : null, ts: now };
      }
    }
    const map = {};
    for (const a of operatorAddrs) map[a.toLowerCase()] = this._ownerMap[a.toLowerCase()]?.owner ?? null;
    return map;
  }

  /**
   * operator (lowercased) -> legacy withdrawable LINK (bigint) or null. Read fresh.
   * Under the ETH aggregator operators no longer accrue LINK (0-juel dispatch), so this
   * is normally 0; it survives only to let owners drain LINK left over from the old
   * aggregator (the secondary "legacy LINK" claim path in My Arbiters).
   */
  async getWithdrawableMap(operatorAddrs) {
    return this._batchOperatorRead(operatorAddrs, 'withdrawable');
  }

  /**
   * ETH (wei) owed to `owner` on the aggregator's pull-payment ledger, or null on read
   * error. This is the live "claimable" figure under the ETH aggregator — earnings are
   * credited per OWNER (aggregated across all their operators), not per operator.
   */
  async getEthOwed(ownerAddress) {
    if (!ownerAddress) return null;
    return withRetry(() => this.aggregator.ethOwed(ownerAddress)).catch(() => null);
  }

  /** owner (lowercased) -> ethOwed (bigint) or null. Batched with bounded concurrency. */
  async getEthOwedMap(ownerAddrs) {
    const out = {};
    await mapWithConcurrency(ownerAddrs, 6, async (addr) => {
      out[addr.toLowerCase()] = await this.getEthOwed(addr);
    });
    return out;
  }

  // --- ETH funding of arbiter nodes ---------------------------------------
  //
  // Each operator's authorized senders are the node EOAs that submit
  // commit/reveal txs and pay gas. Funding = the ETH balance of those keys.
  // Senders are static-ish (cached); balances + gas price are read fresh.

  /** operator (lowercased) -> [sender addresses]. Cached (senders rarely change). */
  async getSenderMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const stale = operatorAddrs.filter((a) => {
      const e = this._senderMap[a.toLowerCase()];
      return !e || now - e.ts >= maxAgeMs;
    });
    const batchSize = 6;
    for (let i = 0; i < stale.length; i += batchSize) {
      const slice = stale.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        const senders = await withRetry(() => op.getAuthorizedSenders()).catch(() => []);
        this._senderMap[addr.toLowerCase()] = { senders: senders.map(String), ts: now };
      }));
    }
    const map = {};
    for (const a of operatorAddrs) map[a.toLowerCase()] = this._senderMap[a.toLowerCase()]?.senders || [];
    return map;
  }

  /** address (lowercased) -> ETH balance (bigint) or null. Read fresh, batched. */
  async getBalances(addrs) {
    const out = {};
    const batchSize = 8;
    for (let i = 0; i < addrs.length; i += batchSize) {
      const slice = addrs.slice(i, i + batchSize);
      await Promise.all(slice.map(async (a) => {
        out[a.toLowerCase()] = await withRetry(() => this.provider.getBalance(a)).catch(() => null);
      }));
    }
    return out;
  }

  /** Current gas price in wei (bigint), short-cached. */
  async getGasPrice() {
    const now = Date.now();
    if (this._gasPrice && now - this._gasPrice.ts < 30000) return this._gasPrice.value;
    const fee = await withRetry(() => this.provider.getFeeData());
    const value = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    this._gasPrice = { value, ts: now };
    return value;
  }

  /**
   * Internal: per-operator funding in wei + the live gas price.
   * Returns { perOp: { opLower: { senders:[{address, balanceWei}], totalWei } }, gasPrice }.
   */
  async _computeFunding(operatorAddrs) {
    const senderMap = await this.getSenderMap(operatorAddrs);
    const allSenders = [...new Set(Object.values(senderMap).flat().map((a) => a.toLowerCase()))];
    const [balances, gasPrice] = await Promise.all([
      this.getBalances(allSenders),
      this.getGasPrice()
    ]);
    const perOp = {};
    for (const op of operatorAddrs) {
      const lower = op.toLowerCase();
      const senders = (senderMap[lower] || []).map((a) => ({
        address: a,
        balanceWei: balances[a.toLowerCase()] ?? 0n
      }));
      const totalWei = senders.reduce((acc, s) => acc + (s.balanceWei ?? 0n), 0n);
      perOp[lower] = { senders, totalWei };
    }
    return { perOp, gasPrice };
  }

  /** Estimated remaining queries for a wei balance at the given gas price. */
  _estQueries(totalWei, gasPrice) {
    const costPerQuery = BigInt(funding.gasPerQuery) * (gasPrice ?? 0n);
    return costPerQuery > 0n ? Number(totalWei / costPerQuery) : null;
  }

  /** Is a wei balance "low" (below the query OR the absolute-ETH threshold)? */
  _fundingLow(totalWei, estQueries) {
    const lowEthWei = ethers.parseEther(String(funding.lowEthThreshold));
    return (estQueries != null && estQueries < funding.lowQueriesThreshold) || totalWei < lowEthWei;
  }

  /** Client-safe funding object for one operator (no bigints). */
  _fundingForClient({ senders, totalWei }, gasPrice) {
    const estQueries = this._estQueries(totalWei, gasPrice);
    return {
      totalEth: ethers.formatEther(totalWei),
      estQueries,
      low: this._fundingLow(totalWei, estQueries),
      senders: senders.map((s) => ({ address: s.address, balanceEth: ethers.formatEther(s.balanceWei ?? 0n) })),
      gasPriceGwei: gasPrice != null ? ethers.formatUnits(gasPrice, 'gwei') : null,
      gasPerQuery: funding.gasPerQuery,
      lowQueriesThreshold: funding.lowQueriesThreshold,
      lowEthThreshold: funding.lowEthThreshold
    };
  }

  // --- Per-jobId sender derivation -----------------------------------------
  //
  // On-chain there's no `(jobId → sending key)` mapping — the operator
  // contract just has one global `authorizedSenders` list. The 1:1 a node
  // operator configures (job spec `fromAddress`) is off-chain. We recover it
  // by scanning fulfillment history: each `OracleResponse(requestId)` event's
  // transaction was sent by the key that fulfilled it; the matching
  // `OracleRequest(specId, ..., requestId, ...)` ties that requestId to a
  // jobId. We walk back chunked through the archive RPC with an early-exit
  // when all requested jobIds have a hit. Unused arbiters → null (no history).

  /**
   * Operator (lowercased) → { jobIdLower: senderAddress }. Cached per operator
   * (30 min). On any failure returns the best-effort partial map; never throws.
   */
  async getJobSenderMap(operatorAddress, jobIds) {
    const opLower = operatorAddress.toLowerCase();
    const wantLower = (jobIds || []).map((j) => String(j).toLowerCase());
    const cached = this._jobSenderCache[opLower];
    // Cache hit only if it's fresh AND has already attempted every requested
    // jobId (otherwise a newly-registered arbiter would stay "—" until TTL).
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000 &&
        wantLower.every((j) => cached.attempted.has(j))) {
      return cached.map;
    }
    // Concurrent requests for the same operator share one scan (up to 25 s of
    // getLogs) instead of each starting its own.
    const flightKey = `${opLower}|${[...wantLower].sort().join(',')}`;
    const running = this._jobSenderInflight.get(flightKey);
    if (running) return running;
    const p = this._scanJobSenders(operatorAddress, jobIds, opLower, wantLower)
      .finally(() => this._jobSenderInflight.delete(flightKey));
    this._jobSenderInflight.set(flightKey, p);
    return p;
  }

  async _scanJobSenders(operatorAddress, jobIds, opLower, wantLower) {
    const provider = this._getLogProvider();
    const iface = new ethers.Interface(ORACLE_EVENTS_ABI);
    const reqTopic = iface.getEvent('OracleRequest').topicHash;
    const respTopic = iface.getEvent('OracleResponse').topicHash;

    const needed = new Set((jobIds || []).map((j) => String(j).toLowerCase()));
    const reqIdToSpec = {};        // requestId(lower) → specId(lower), accumulated
    let pendingResp = [];          // responses whose matching request isn't seen yet
    const senderByJob = {};

    let latest;
    try {
      latest = await withRetry(() => provider.getBlockNumber());
    } catch (err) {
      logger.warn('archive getBlockNumber failed', { operator: operatorAddress, msg: err.message });
      // Don't poison the cache with a failure — let the next request retry.
      return senderByJob;
    }

    // Look-back is expressed in BLOCKS, not chunks: the chunk size is the
    // provider's per-query cap and varies by endpoint (10k on Infura, 90k on a
    // keyed archive gateway), so a chunk count would silently change how far
    // back we look. The walk stops early as soon as every requested jobId is
    // resolved, and a wall-clock budget bounds the worst case — a never-used
    // arbiter, which resolves nothing and would otherwise walk the whole range
    // while /my-arbiters waits on it. Cached 30 min, so this is paid rarely.
    const CHUNK = this.logMaxChunk;
    const LOOKBACK_BLOCKS = 2_250_000;  // ~52 days on Base
    const DEADLINE = Date.now() + 25_000;
    const scanFloor = Math.max(0, latest - LOOKBACK_BLOCKS);

    let toBlock = latest;
    while (toBlock >= scanFloor && needed.size > 0) {
      if (Date.now() > DEADLINE) {
        logger.warn('sender scan hit time budget', { operator: operatorAddress, unresolved: needed.size, reachedBlock: toBlock });
        break;
      }
      const fromBlock = Math.max(scanFloor, toBlock - CHUNK + 1);
      let logs = [];
      try {
        // Both event types in ONE query via an OR'd topic0 filter — at 10k
        // blocks a chunk there are many more chunks than before, so halving the
        // calls per chunk matters.
        logs = await withRetry(() => provider.getLogs({
          address: operatorAddress, topics: [[reqTopic, respTopic]], fromBlock, toBlock
        }));
      } catch (err) {
        logger.warn('sender scan getLogs failed', { operator: operatorAddress, fromBlock, toBlock, msg: err.message });
        break;
      }

      for (const log of logs) {
        if (log.topics[0] !== reqTopic) continue;
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          reqIdToSpec[String(parsed.args.requestId).toLowerCase()] = String(parsed.args.specId).toLowerCase();
        } catch { /* skip malformed */ }
      }

      // Add new responses to the pending pool (newer first).
      for (const log of logs) {
        if (log.topics[0] !== respTopic) continue;
        pendingResp.push({
          requestId: log.topics[1].toLowerCase(),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index,
        });
      }
      pendingResp.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));

      // Try to resolve any pending response whose request we now know about,
      // for jobs we care about that aren't yet resolved. Keep the rest pending.
      const stillPending = [];
      for (const r of pendingResp) {
        if (needed.size === 0) break;
        const specId = reqIdToSpec[r.requestId];
        if (!specId) { stillPending.push(r); continue; }
        if (!needed.has(specId)) continue; // request we don't care about — drop
        if (senderByJob[specId]) continue; // already have it
        try {
          const tx = await withRetry(() => provider.getTransaction(r.txHash));
          if (tx?.from) {
            senderByJob[specId] = ethers.getAddress(tx.from);
            needed.delete(specId);
          }
        } catch (err) {
          // transient; keep it pending so we can retry next chunk
          stillPending.push(r);
        }
      }
      pendingResp = stillPending;

      if (fromBlock === scanFloor) break;
      toBlock = fromBlock - 1;
    }

    this._jobSenderCache[opLower] = {
      map: senderByJob,
      attempted: new Set(wantLower),
      ts: Date.now(),
    };
    return senderByJob;
  }

  // --- Round jury and slots ------------------------------------------------

  /**
   * The jury a round was requested with: getJury(aggId) → { K, M, N, P,
   * timeout, mPlus }, or null for an unknown round (K = 0). It is fixed at
   * request, so it is cached.
   */
  async _getJury(aggId) {
    const ck = String(aggId).toLowerCase();
    if (this._juryCache.has(ck)) return this._juryCache.get(ck);
    const j = await withRetry(() => this._agg().getJury(aggId));
    const K = Number(j.K);
    const jury = K === 0 ? null : {
      K, M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout), mPlus: mPlus(K, Number(j.M)),
    };
    if (jury) this._juryCache.set(ck, jury);
    return jury;
  }

  /**
   * getSlot(aggId, i) for i < K, stopping at the first empty slot (an undrawn
   * round has none). Slots of a settled or cancelled round no longer change, so
   * those are cached; pass `final` to allow caching.
   * @returns {Promise<Array<{index, oracle, fee, key, payee, committedAt, flags, qcode, commitHash}>>}
   */
  async _readSlots(aggId, K, { final = false } = {}) {
    const ck = String(aggId).toLowerCase();
    if (this._slotCache.has(ck)) return this._slotCache.get(ck);
    const agg = this._agg();
    const slots = [];
    for (let i = 0; i < K; i++) {
      const s = await withRetry(() => agg.getSlot(aggId, i));
      if (!s.oracle || s.oracle === ZERO_ADDRESS) break;
      slots.push({
        index: i,
        oracle: ethers.getAddress(s.oracle),
        fee: ethers.formatEther(s.fee),
        key: String(s.key),
        payee: s.payee && s.payee !== ZERO_ADDRESS ? ethers.getAddress(s.payee) : null,
        committedAt: Number(s.committedAt),
        flags: Number(s.flags),
        qcode: Number(s.qcode),
        commitHash: String(s.commitHash),
      });
    }
    if (final) this._slotCache.set(ck, slots);
    return slots;
  }

  // --- Oracle health (commit/reveal reliability + eval success rate) -------
  //
  // Derived from the aggregator's round events over a recent block window via
  // the archive RPC, plus getSlot() for who sat in each slot and what it did
  // (v2 events carry the slot index, not the operator). Per round the protocol
  // draws K arbiters (JuryDrawn), closes the commit phase at M+ commits or after
  // T+ with at least M, promotes M commits (CommitPhaseComplete), and finalizes
  // at the N-th reveal (FulfillAIEvaluation). A failed round is settled with
  // EvaluationFailed(phase) and charged to the arbiters that fell short (see
  // utils/roundModel.describeRound). Rounds that never got going (≥ M commits
  // but never closed or promoted, or never drawn) are counted apart; the prepay
  // sent to the arbiter pool, the never-promoted rounds' committer shares
  // (CommitPayment) and the pool's payouts (PoolPayment) are totalled.

  /**
   * @param {{ days?: number }} [opts] look-back window in days (default 14).
   * @returns {Promise<object>} success rate, reliability per arbiter key
   *   (`arbiters`) and its per-operator roll-up (`operators`, with gas), plus a
   *   `partial` flag if a chunk error cut the scan short.
   */
  async getOracleHealth({ days = 14 } = {}) {
    const agg = this._agg();
    const provider = this._getLogProvider();
    const iface = new ethers.Interface(AGG_EVENT_ABI);
    const topic0Or = [HEALTH_EVENTS.map((n) => iface.getEvent(n).topicHash)];

    const [latest, blockSec] = await Promise.all([
      withRetry(() => provider.getBlockNumber()),
      this.getBlockSeconds(),
    ]);
    const BLOCKS_PER_DAY = Math.round(86400 / blockSec);
    const windowBlocks = Math.max(1, Math.round(days * BLOCKS_PER_DAY));
    const floor = Math.max(this.aggregatorFromBlock || 0, latest - windowBlocks);
    const CHUNK = this.logMaxChunk; // provider's per-query range cap (config.getLogScanRpc)
    const dayOff = (blk) => Math.floor((latest - blk) / BLOCKS_PER_DAY);
    const inDays = (o) => o >= 0 && o < days;

    // Build the chunk list up-front, then fetch a few at a time. A failed chunk
    // is skipped, not fatal — one bad range shouldn't blank the whole window.
    // `chunkErrors` and `scanError` are reported so the client can distinguish
    // "the chain was quiet" from "we couldn't read the chain". Fail fast when
    // nothing at all is getting through (a misconfigured range cap or a dead
    // endpoint fails every chunk identically).
    const ranges = [];
    for (let to = latest; to >= floor; ) {
      const from = Math.max(floor, to - CHUNK + 1);
      ranges.push({ from, to });
      if (from === floor) break;
      to = from - 1;
    }
    const CONCURRENCY = 5;
    const FAIL_FAST_AFTER = 5;
    let scannedChunks = 0, chunkErrors = 0, scanError = null, aborted = false;
    const allLogs = [];
    await mapWithConcurrency(ranges, CONCURRENCY, async ({ from, to }) => {
      if (aborted) return;
      try {
        const logs = await withRetry(() => provider.getLogs({
          address: this.aggregatorAddress, topics: topic0Or, fromBlock: from, toBlock: to
        }), { retries: LOG_CHUNK_RETRIES });
        allLogs.push(...logs);
        scannedChunks++;
      } catch (err) {
        chunkErrors++;
        if (!scanError) scanError = err.message;
        logger.warn('oracle-health getLogs failed', { network: this.networkKey, fromBlock: from, toBlock: to, msg: err.message });
        if (scannedChunks === 0 && chunkErrors >= FAIL_FAST_AFTER) {
          aborted = true;
          logger.error('oracle-health scan aborted — no chunk succeeded', {
            network: this.networkKey, attempted: chunkErrors, totalChunks: ranges.length, msg: err.message,
          });
        }
      }
    });
    const partial = chunkErrors > 0;
    allLogs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));

    // Per-round event record.
    const rounds = {}; // aggIdLower → { aggId, round, requestBlock, drawBlock, promoteBlock, fulfilled, failedPhase, cancelled, settled, commits, reveals, refunds, skips }
    const roundFor = (aggId) => {
      const k = String(aggId).toLowerCase();
      if (!rounds[k]) {
        rounds[k] = { aggId: String(aggId), round: roundNumber(aggId), requestBlock: null, drawBlock: null, promoteBlock: null,
          fulfilled: false, fulfillBlock: null, failedPhase: null, cancelled: false, cancelledWei: 0n, settled: false,
          commits: {}, reveals: {}, refunds: [], committerWei: 0n, skips: {} };
      }
      return rounds[k];
    };
    const fulfillTxHashes = new Set();
    // The arbiter pool's payouts in the window, per payee (an arbiter's operator owner)
    const poolPaid = { count: 0, wei: 0n, byPayee: {} };
    for (const log of allLogs) {
      let p;
      try { p = iface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      const r = roundFor(p.args.aggRequestId);
      switch (p.name) {
        case 'RequestAIEvaluation': r.requestBlock = log.blockNumber; break;
        case 'JuryDrawn': r.drawBlock = log.blockNumber; break;
        case 'CommitPhaseComplete': r.promoteBlock = log.blockNumber; break;
        case 'CommitReceived':
          r.commits[Number(p.args.pollIndex)] = { block: log.blockNumber, tx: log.transactionHash };
          break;
        case 'RevealReceived':
          r.reveals[Number(p.args.pollIndex)] = { block: log.blockNumber, tx: log.transactionHash, late: Boolean(p.args.late) };
          break;
        case 'FulfillAIEvaluation':
          r.fulfilled = true; r.fulfillBlock = log.blockNumber;
          fulfillTxHashes.add(log.transactionHash.toLowerCase());
          break;
        case 'EvaluationFailed': r.failedPhase = Number(p.args.phase); break;
        case 'RoundSettled': r.settled = true; break;
        // RoundCancelled's amount (toPool) goes to the arbiter pool
        case 'RoundCancelled': r.cancelled = true; r.cancelledWei = p.args[1]; break;
        // requester = address(0) is the arbiter pool: prepay forfeited, not a refund
        case 'RequesterRefunded': r.refunds.push({ to: String(p.args.requester).toLowerCase(), wei: p.args.amount }); break;
        case 'CommitPayment': r.committerWei += p.args.amount; break;
        case 'PoolPayment': {
          const payee = String(p.args.payee);
          const b = poolPaid.byPayee[payee.toLowerCase()] || (poolPaid.byPayee[payee.toLowerCase()] = { payee, count: 0, wei: 0n });
          b.count++; b.wei += p.args.amount;
          poolPaid.count++; poolPaid.wei += p.args.amount;
          break;
        }
        case 'SlotSkipped':
          if (p.args.pollIndex !== ethers.MaxUint256) {
            r.skips[Number(p.args.pollIndex)] = SKIP_REASONS[Number(p.args.reason)] || `reason ${p.args.reason}`;
          }
          break;
      }
    }

    // Only rounds requested inside the window are judged (the success basis).
    // Each round has its own jury (getJury, fixed at request); the slots come
    // from getSlot (cached once final).
    const judged = Object.values(rounds).filter((r) => r.requestBlock != null);
    let slotReadErrors = 0;
    await mapWithConcurrency(judged, 4, async (r) => {
      try {
        r.jury = await this._getJury(r.aggId);
        if (r.drawBlock != null && r.jury) {
          r.slots = await this._readSlots(r.aggId, r.jury.K, { final: r.settled || r.cancelled });
        }
      } catch (err) {
        slotReadErrors++;
        r.slots = null;
        logger.warn('oracle-health getSlot failed', { network: this.networkKey, aggId: r.aggId, msg: err.message });
      }
    });

    // Phase as far as the events tell (the exact phase only matters for blame,
    // which needs the settlement events: EvaluationFailed / RoundSettled).
    const phaseOf = (r) => {
      if (r.cancelled) return PHASE.CANCELLED;
      if (r.failedPhase != null) return PHASE.FAILED;
      if (r.fulfilled) return r.settled ? PHASE.SETTLED : PHASE.FINAL;
      return r.drawBlock != null ? PHASE.COMMIT : PHASE.DRAW;
    };

    // Registry entries (removed keys included) give each slot key its jobId.
    const jobIdOfKey = {};
    let arbiterCountByOp = {};
    try {
      for (const e of await this._getRegistryEvents()) {
        if (e.name === 'ArbiterRegistered') jobIdOfKey[e.key.toLowerCase()] = e.jobId;
      }
      for (const e of (await this.getRegistry()).values()) {
        const k = String(e.oracle).toLowerCase();
        arbiterCountByOp[k] = (arbiterCountByOp[k] || 0) + 1;
      }
    } catch (err) {
      logger.warn('oracle-health: registry read failed (jobIds and arbiter counts omitted)', { network: this.networkKey, msg: err.message });
      arbiterCountByOp = null;
    }

    const emptyBucketTally = () => ({
      requests: 0, fulfilled: 0, failed: 0, malformed: 0, notProgressed: 0, notDrawn: 0, running: 0,
      notDrawnBy: { poolShortage: 0, drawPool: 0, beaconQuorum: 0, cancelled: 0 },
      toPool: 0, toPoolWei: 0n, toCommitters: 0, toCommittersWei: 0n,
    });
    const daily = Array.from({ length: days }, () => ({ requests: 0, fulfilled: 0, failed: 0, malformed: 0, notProgressed: 0, notDrawn: 0 }));
    const tally = emptyBucketTally();
    const likelyMalformed = [];   // { aggId, round }
    const arbs = {};     // keyLower → per-arbiter (operator, jobId) reliability
    const ops = {};      // operatorLower → roll-up over its arbiters
    const blameByKey = {}; // keyLower → { count, evals: { aggIdLower → { aggId, round, stage, slots } } }
    const blameByOp = {};
    const timingByOp = {};
    const timingDaily = Array.from({ length: days }, () => ({ cSum: 0, cN: 0, rSum: 0, rN: 0 }));
    const commitRevealLogs = []; // { kind, txHash, operator, blockNumber } for gas tracking
    const counter = () => ({ selected: 0, skipped: 0, commits: 0, promoted: 0, reveals: 0, lateReveals: 0 });
    const arbFor = (s) => {
      const k = s.key.toLowerCase();
      if (!arbs[k]) arbs[k] = { key: s.key, operator: s.oracle, jobId: jobIdOfKey[k] || null, ...counter() };
      return arbs[k];
    };
    const opFor = (addr) => {
      const k = addr.toLowerCase();
      if (!ops[k]) ops[k] = { operator: addr, keys: new Set(), ...counter() };
      return ops[k];
    };
    const timingFor = (addr) => {
      const k = addr.toLowerCase();
      if (!timingByOp[k]) timingByOp[k] = { operator: addr, commit: [], reveal: [] };
      return timingByOp[k];
    };
    const addBlame = (map, k, r, stage) => {
      if (!map[k]) map[k] = { count: 0, evals: {} };
      map[k].count++;
      const rk = r.aggId.toLowerCase();
      const e = map[k].evals[rk] || (map[k].evals[rk] = { aggId: r.aggId, round: r.round, stage, slots: 0 });
      e.slots++;
    };

    for (const r of judged) {
      // A round whose jury could not be read is left out (counted in slotReadErrors,
      // so the result is flagged partial): without M and N it cannot be judged.
      if (!r.jury) continue;
      const o = dayOff(r.requestBlock);
      tally.requests++;
      if (inDays(o)) daily[o].requests++;
      const slots = r.slots || [];
      const toPool = r.refunds.filter((x) => x.to === ZERO_ADDRESS);
      const refundTo = toPool.length ? 'pool' : r.refunds.length ? 'requester' : null;
      const d = describeRound({
        phase: phaseOf(r), failedPhase: r.failedPhase, M: r.jury?.M, N: r.jury?.N, fulfilled: r.fulfilled, refundTo,
        slots: slots.map((s) => ({ flags: s.flags, qcode: s.qcode, late: r.reveals[s.index]?.late, skipReason: r.skips[s.index] })),
      });
      const bucket = {
        completed: 'fulfilled', failed: 'failed', malformed: 'malformed', notProgressed: 'notProgressed',
        notDrawn: 'notDrawn', cancelled: 'notDrawn',
      }[d.kind] || 'running';
      tally[bucket]++;
      if (bucket !== 'running' && inDays(o)) daily[o][bucket]++;
      if (d.notDrawnReason) tally.notDrawnBy[d.notDrawnReason]++;
      if (d.forfeit === 'pool') {
        tally.toPool++;
        tally.toPoolWei += toPool.reduce((acc, x) => acc + x.wei, 0n) + (r.cancelledWei || 0n);
      } else if (d.forfeit === 'committers') {
        // the committers' shares; the indivisible rest (< 1 wei per committer) went to the pool
        tally.toCommitters++;
        tally.toCommittersWei += r.committerWei;
        tally.toPoolWei += toPool.reduce((acc, x) => acc + x.wei, 0n);
      }
      if (d.kind === 'malformed') likelyMalformed.push({ aggId: r.aggId, round: r.round });

      for (const s of slots) {
        const f = decodeSlotFlags(s.flags);
        const op = opFor(s.oracle);
        const ar = arbFor(s);
        op.keys.add(s.key.toLowerCase());
        for (const c of [op, ar]) {
          if (f.dispatched) c.selected++; else c.skipped++;
          if (f.committed) c.commits++;
          if (f.promoted) c.promoted++;
          if (f.revealed) c.reveals++;
        }
        const rv = r.reveals[s.index];
        if (rv && rv.late) { op.lateReveals++; ar.lateReveals++; }
        // Response timing: commit = jury draw (JuryDrawn) → CommitReceived;
        // reveal = promotion (the reveal requests go out in that tx) →
        // RevealReceived. Block deltas at the measured block time, so no
        // per-event getBlock is needed.
        const cm = r.commits[s.index];
        if (cm) {
          commitRevealLogs.push({ kind: 'commit', txHash: cm.tx, operator: s.oracle, blockNumber: cm.block });
          if (r.drawBlock != null && cm.block >= r.drawBlock) {
            const sec = Math.round((cm.block - r.drawBlock) * blockSec * 10) / 10;
            timingFor(s.oracle).commit.push(sec);
            const od = dayOff(cm.block);
            if (inDays(od)) { timingDaily[od].cSum += sec; timingDaily[od].cN++; }
          }
        }
        if (rv) {
          commitRevealLogs.push({ kind: 'reveal', txHash: rv.tx, operator: s.oracle, blockNumber: rv.block });
          if (r.promoteBlock != null && rv.block >= r.promoteBlock) {
            const sec = Math.round((rv.block - r.promoteBlock) * blockSec * 10) / 10;
            timingFor(s.oracle).reveal.push(sec);
            const od = dayOff(rv.block);
            if (inDays(od)) { timingDaily[od].rSum += sec; timingDaily[od].rN++; }
          }
        }
      }

      // Blame: a slot is one (operator, jobId) arbiter key, charged once per
      // blameworthy slot; the operator roll-up sums its keys.
      for (const b of d.blame) {
        const s = slots.find((x) => x.index === b.slot);
        if (!s) continue;
        addBlame(blameByKey, s.key.toLowerCase(), r, b.stage);
        addBlame(blameByOp, s.oracle.toLowerCase(), r, b.stage);
      }
    }

    // Oldest → newest (today last), matching dailyTrend / gasDaily.
    const timingDailySeries = timingDaily
      .map((b, i) => ({
        daysAgo: i,
        commits: b.cN,
        reveals: b.rN,
        avgCommitSec: b.cN ? Math.round((b.cSum / b.cN) * 10) / 10 : null,
        avgRevealSec: b.rN ? Math.round((b.rSum / b.rN) * 10) / 10 : null,
      }))
      .reverse();
    const summarizeSecs = (arr) => {
      if (!arr.length) return { count: 0, avgSec: null, minSec: null, maxSec: null, stdDevSec: null };
      let sum = 0, min = Infinity, max = -Infinity;
      for (const v of arr) { sum += v; if (v < min) min = v; if (v > max) max = v; }
      const mean = sum / arr.length;
      let sq = 0;
      for (const v of arr) sq += (v - mean) * (v - mean);
      return {
        count: arr.length,
        avgSec: Math.round(mean * 10) / 10,
        minSec: min,
        maxSec: max,
        stdDevSec: Math.round(Math.sqrt(sq / arr.length) * 10) / 10, // population std dev
      };
    };
    const timingOperators = Object.values(timingByOp)
      .map((t) => ({ operator: t.operator, commit: summarizeSecs(t.commit), reveal: summarizeSecs(t.reveal) }))
      .sort((a, b) => (b.commit.count + b.reveal.count) - (a.commit.count + a.reveal.count));
    // Every observation, compact, for the cluster chart: [operatorIndex, kind, seconds]
    // where kind is 'c' (commit) or 'r' (reveal) and operatorIndex indexes timingOperators.
    const timingPoints = [];
    timingOperators.forEach((t, i) => {
      const raw = timingByOp[t.operator.toLowerCase()];
      for (const v of raw.commit) timingPoints.push([i, 'c', v]);
      for (const v of raw.reveal) timingPoints.push([i, 'r', v]);
    });

    // ---- Gas tracking (step 2): fetch & persist receipts for new commit/reveal
    // txs. Receipts are immutable, so we only fetch tx hashes not already cached
    // (write-once store) — the first run backfills, later runs touch only new
    // txs. Throttled and capped so the backfill can't hang the request. Best
    // effort: any failure here leaves the success/reliability stats intact.
    const RECEIPT_CONCURRENCY = 5;  // simultaneous getTransactionReceipt calls
    const MAX_NEW_PER_SCAN = 750;   // bound the per-request backfill; rest spill to next scan
    let gasSummary = null;          // scan/backfill meta
    let gasByOp = {};               // operatorLower → { commit, reveal } stat summaries
    let gasDaily = [];              // network daily avg gas series (for the trend chart)
    let gasFinalization = null;     // round-completing reveal cost (the aggregation outlier)
    try {
      const store = GasReceiptStore.forNetwork(this.networkKey).load();
      const receiptProvider = this._getReceiptProvider();
      // Anchor block timestamp once; approximate per-tx timestamps from block
      // offset (~2s/block on Base) so we store an absolute time without a
      // getBlock per receipt. Good enough for daily bucketing in step 3.
      const head = await withRetry(() => provider.getBlock(latest));
      const anchorTs = head ? Number(head.timestamp) : Math.floor(Date.now() / 1000);

      // Unique, not-yet-cached tx hashes (a tx carries one commit OR one reveal).
      const seen = new Set();
      const toFetch = [];
      for (const e of commitRevealLogs) {
        const h = e.txHash.toLowerCase();
        if (seen.has(h)) continue;
        seen.add(h);
        if (store.has(h)) {
          // Already cached — but the round-completing flag may only be knowable
          // now (the fulfill log might land in a later-scanned chunk).
          if (e.kind === 'reveal' && fulfillTxHashes.has(h)) store.markCompletedRound(h);
          continue;
        }
        toFetch.push(e);
      }

      const batch = toFetch.slice(0, MAX_NEW_PER_SCAN);
      let gasFetched = 0, gasFailed = 0;
      await mapWithConcurrency(batch, RECEIPT_CONCURRENCY, async (e) => {
        try {
          const rcpt = await withRetry(() => receiptProvider.getTransactionReceipt(e.txHash));
          if (!rcpt || rcpt.gasUsed == null) { gasFailed++; return; }
          // ethers v6: the effective gas price paid is exposed as receipt.gasPrice.
          const effectiveGasPrice = rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n;
          const ts = Math.round(anchorTs - (latest - e.blockNumber) * blockSec);
          store.set(e.txHash, {
            kind: e.kind,
            operator: e.operator,
            gasUsed: rcpt.gasUsed,
            effectiveGasPrice,
            blockNumber: e.blockNumber,
            timestamp: ts,
            completedRound: e.kind === 'reveal' && fulfillTxHashes.has(e.txHash.toLowerCase()),
          });
          gasFetched++;
        } catch (err) {
          gasFailed++;
        }
      });
      store.flush();

      const gasCapped = toFetch.length > batch.length;
      gasSummary = {
        storeSize: store.size,        // total receipts cached for this network
        candidates: toFetch.length,   // new (uncached) txs found this scan
        fetched: gasFetched,
        failed: gasFailed,
        capped: gasCapped,            // true if backfill spilled to a later scan
        partial: gasCapped || gasFailed > 0,
      };
      if (gasCapped || gasFailed > 0) {
        logger.info('oracle-health: gas backfill incomplete this scan', {
          network: this.networkKey, ...gasSummary,
        });
      }

      // ---- Aggregate the cached receipts within the display window. The store
      // accumulates across scans, so filter to the current window by timestamp.
      // The Reveal min/median/max EXCLUDES round-completing txs (their gas is
      // inflated by aggregation and would skew the distribution); finalizing
      // reveals get their own summary. AVERAGES (`revealAll` + the daily chart)
      // BLEND both, since finalizing reveals are a real recurring cost (~1/4 of
      // reveals) and the true per-reveal average must include them.
      const windowStartTs = anchorTs - days * 86400;
      const inWindow = store.all().filter((r) => r.timestamp >= windowStartTs);

      const byOp = {};
      for (const r of inWindow) {
        if (!r.operator) continue;
        if (!byOp[r.operator]) byOp[r.operator] = { commit: [], reveal: [], finalizing: [] };
        if (r.kind === 'commit') byOp[r.operator].commit.push(r);
        else if (r.kind === 'reveal' && r.completedRound) byOp[r.operator].finalizing.push(r);
        else if (r.kind === 'reveal') byOp[r.operator].reveal.push(r);
      }
      gasByOp = {};
      for (const [op, g] of Object.entries(byOp)) {
        gasByOp[op] = {
          commit: summarizeGas(g.commit),         // commit txs
          reveal: summarizeGas(g.reveal),         // normal reveals only (for the distribution column)
          finalizing: summarizeGas(g.finalizing), // reveals that also ran aggregation (one per completed round)
          revealAll: summarizeGas([...g.reveal, ...g.finalizing]), // all reveals — blended true per-reveal cost
        };
      }

      gasFinalization = summarizeGas(inWindow.filter((r) => r.kind === 'reveal' && r.completedRound));

      // Network-wide daily average gas. Commit = all commits; reveal = ALL
      // reveals incl. finalizing (true blended avg). Bucketed by day offset from
      // the anchor timestamp, oldest → newest to match `dailyTrend`.
      const buckets = Array.from({ length: days }, () => ({ cSum: 0, cN: 0, rSum: 0, rN: 0 }));
      for (const r of inWindow) {
        const idx = Math.floor((anchorTs - r.timestamp) / 86400);
        if (idx < 0 || idx >= days) continue;
        if (r.kind === 'commit') { buckets[idx].cSum += Number(r.gasUsed); buckets[idx].cN++; }
        else if (r.kind === 'reveal') { buckets[idx].rSum += Number(r.gasUsed); buckets[idx].rN++; }
      }
      gasDaily = buckets
        .map((b, i) => ({
          daysAgo: i,
          avgGasCommit: b.cN ? Math.round(b.cSum / b.cN) : null,
          avgGasReveal: b.rN ? Math.round(b.rSum / b.rN) : null,
          commits: b.cN,
          reveals: b.rN,
        }))
        .reverse();
    } catch (err) {
      logger.warn('oracle-health: gas receipt collection failed', { network: this.networkKey, msg: err.message });
      gasSummary = { error: err.message };
    }

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    const blameList = (b) => (b ? Object.values(b.evals) : []);
    const rates = (c) => ({
      timesSelected: c.selected,
      skipped: c.skipped,             // slots skipped at the draw (owner() failed / dispatch reverted)
      commits: c.commits,
      commitRatePct: pct(c.commits, c.selected),
      promoted: c.promoted,
      reveals: c.reveals,
      lateReveals: c.lateReveals,
      revealRatePct: pct(c.reveals, c.promoted), // reveals per promotion — only promoted commits are asked to reveal
    });
    // Reliability per arbiter key (one (operator, jobId) registration).
    const arbiters = Object.values(arbs)
      .map((a) => {
        const b = blameByKey[a.key.toLowerCase()];
        return {
          key: a.key,
          operator: a.operator,
          jobId: a.jobId,
          ...rates(a),
          blameworthy: b ? b.count : 0,  // failed-round slots charged to this arbiter
          blameAggIds: blameList(b),     // { aggId, round, stage, slots } drill-down list
        };
      })
      .sort((a, b) => b.timesSelected - a.timesSelected || b.commits - a.commits);
    // Roll-up per operator contract (sums of its keys), with the per-op gas stats.
    const operators = Object.values(ops)
      .map((o) => {
        const b = blameByOp[o.operator.toLowerCase()];
        return {
          operator: o.operator,
          arbiters: arbiterCountByOp ? (arbiterCountByOp[o.operator.toLowerCase()] || 0) : null,
          keysSeen: o.keys.size,          // distinct arbiter keys of this operator drawn in the window
          ...rates(o),
          blameworthy: b ? b.count : 0,
          blameAggIds: blameList(b),
          gas: gasByOp[o.operator.toLowerCase()] || null, // per-op gas stats (null until receipts cached)
        };
      })
      .sort((a, b) => b.timesSelected - a.timesSelected || b.commits - a.commits);

    const dailyTrend = daily
      .map((d, i) => ({
        daysAgo: i, fulfilled: d.fulfilled, failed: d.failed, malformed: d.malformed,
        notProgressed: d.notProgressed, notDrawn: d.notDrawn,
      }))
      .reverse();

    return {
      network: this.networkKey,
      windowDays: days,
      fromBlock: Math.max(floor, 0),
      toBlock: latest,
      blockSeconds: Math.round(blockSec * 1000) / 1000,
      // The juries the judged rounds asked for (per request), most used first.
      requirements: { juries: juryTally(judged) },
      points: await this._getStatusCtx().then((c) => c.points).catch(() => DEFAULT_POINTS),
      scannedChunks,
      totalChunks: ranges.length,
      chunkErrors,
      aborted,
      slotReadErrors,
      // Not one chunk came back: the numbers below are all zero because nothing
      // could be read, NOT because the network was idle. The client renders this
      // as an error rather than as an empty window.
      scanFailed: scannedChunks === 0 && chunkErrors > 0,
      scanError,
      partial: partial || slotReadErrors > 0,
      success: {
        requests: tally.requests,
        fulfilled: tally.fulfilled,
        // Failed after the draw for an arbiter-side reason: too few commits or reveals.
        unfulfilled: tally.failed,
        // No arbiter committed: probably a bad request. Not an arbiter failure here,
        // although the keeper still docks each drawn arbiter points.nocommit.
        likelyMalformed: tally.malformed,
        likelyMalformedAggIds: likelyMalformed,
        // ≥ M commits, but the window was never closed or the commits never
        // promoted: nobody is charged, and the unspent prepay is shared by the
        // slots that committed (CommitPayment).
        notProgressed: tally.notProgressed,
        // Never drawn: pool shortage (refunded), a draw failure after the beacon
        // stage when the walk does not cover the class (arbiter pool), a missed
        // beacon quorum (arbiter pool) or cancelled undrawn (arbiter pool).
        notDrawn: tally.notDrawn,
        notDrawnBy: tally.notDrawnBy,
        // Rounds whose unspent prepay went to the arbiter pool, and the ETH (this
        // includes the dust of the never-promoted rounds below).
        toPool: { count: tally.toPool, eth: ethers.formatEther(tally.toPoolWei) },
        // Never-promoted rounds whose unspent prepay was shared by the committers.
        toCommitters: { count: tally.toCommitters, eth: ethers.formatEther(tally.toCommittersWei) },
        // The arbiter pool's payouts at draws in the window (PoolPayment), per payee.
        poolPaid: {
          count: poolPaid.count,
          eth: ethers.formatEther(poolPaid.wei),
          byPayee: Object.values(poolPaid.byPayee)
            .sort((a, b) => (b.wei > a.wei ? 1 : b.wei < a.wei ? -1 : 0))
            .map((b) => ({ payee: b.payee, count: b.count, eth: ethers.formatEther(b.wei) })),
        },
        inProgress: tally.running,
        // Rate over the drawn rounds the arbiters decided: fulfilled vs failed for
        // too few commits or reveals.
        successRatePct: pct(tally.fulfilled, tally.fulfilled + tally.failed),
      },
      dailyTrend,
      arbiters,
      operators,
      // Response timing (seconds; from block deltas at the measured block time).
      // `operators` carries avg/min/max per operator, `points` every observation
      // for the cluster chart as [operatorIndex, 'c'|'r', seconds].
      timing: {
        blockSeconds: Math.round(blockSec * 1000) / 1000,
        operators: timingOperators,
        points: timingPoints,
        daily: timingDailySeries, // per-day avg commit / reveal seconds, oldest → newest
      },
      gas: {
        scan: gasSummary,            // receipt-collection/backfill meta
        daily: gasDaily,             // network daily avg gas (commit + reveal) for the trend chart
        finalization: gasFinalization, // round-completing reveal cost (aggregation outlier), network-wide
      },
      generatedAt: Date.now(),
    };
  }

  /**
   * Full blow-by-blow of a single round (aggId), for the agg-history drill-down:
   * the round's own jury (K/M/N/P and timeout, from getJury), its on-chain
   * state (getRoundInfo), every slot (getSlot: who, fee, what it did, and the
   * keeper outcome settlement reports for it), the request CIDs, the event
   * timeline, the money (base fees, bonuses, and the rewards split into draw,
   * promote and beacon payments), the final result and a derived outcome
   * (utils/roundModel.describeRound / slotOutcome).
   *
   * Once the round is settled, the RoundSettled transaction's receipt is read
   * for the keeper's ScoresUpdated / OutcomeSkippedFrozen / ArbiterBlocked
   * events: applyOutcomes runs inside the settle call, so these are each
   * arbiter's actual new scores.
   *
   * The request block is exact (getRoundInfo), so the event scan runs from it to
   * a bounded estimate of the round's end — never a full-history scan.
   * @param {string} aggId  bytes32 round id, or a decimal round number
   */
  async getAggHistory(aggIdIn) {
    const agg = this._agg();
    const logProvider = this._getLogProvider();
    const iface = new ethers.Interface(AGG_EVENT_ABI);
    const aggId = toAggId(aggIdIn);
    if (!aggId) throw new Error(`Not a round id: ${aggIdIn}`);
    const round = roundNumber(aggId);

    // 1. Requirements: the jury this round was requested with (getJury; zero
    //    for an unknown round, which step 2 reports as not found).
    const jury = await this._getJury(aggId);
    const { K = 0, M = 0, N = 0 } = jury || {};
    const contractParams = jury;
    const beaconsAddr = await withRetry(() => agg.beacons()).then(String).catch(() => null);
    // RequesterRefunded to address(0) is the arbiter pool (ethOwed(address(0))), not a refund
    const isPool = (a) => String(a).toLowerCase() === ZERO_ADDRESS;

    // 2. Round state. Phase 0 = the aggregator has no such round.
    const ri = await withRetry(() => agg.getRoundInfo(aggId));
    const phase = Number(ri.phase);
    if (phase === PHASE.NONE) {
      return { found: false, aggId, round, network: this.networkKey, message: `No round #${round} on the aggregator` };
    }
    const fmt = (v) => ethers.formatEther(v);
    const roundInfo = {
      phase,
      phaseName: PHASE_NAMES[phase] || String(phase),
      requestBlock: Number(ri.requestBlock),
      requestTime: Number(ri.requestTime),
      sealed: ri.sealedHash !== ethers.ZeroHash,
      closeBlock: Number(ri.closeBlock) || null,
      deadline: Number(ri.deadline) || null,
      windowEnd: Number(ri.windowEnd) || null,
      commits: Number(ri.commits),
      received: fmt(ri.received),
      baseFees: fmt(ri.baseFees),
      bonuses: fmt(ri.bonuses),
      rewards: fmt(ri.rewards),
    };

    // 3. Slots, with each arbiter's jobId (keeper.jobIdOf).
    const final = phase >= PHASE.SETTLED;
    const rawSlots = await this._readSlots(aggId, K, { final });
    const keeper = await this.getReputationKeeper();
    const jobIds = await Promise.all(rawSlots.map((s) => withRetry(() => keeper.jobIdOf(s.key)).then(String).catch(() => null)));

    // 4. Event timeline: every round event with topic1 = aggId, from the request
    //    block forward. A round that has ended stops the walk at the chunk holding
    //    its last event (RoundSettled / RoundCancelled, or a draw-time failure);
    //    an open round is scanned to the head. Capped at AGGH_MAX_SCAN_BLOCKS.
    const currentBlock = await withRetry(() => logProvider.getBlockNumber());
    const fromBlock = roundInfo.requestBlock;
    let toBlock = Math.min(currentBlock, fromBlock + AGGH_MAX_SCAN_BLOCKS);
    const truncated = currentBlock - fromBlock > AGGH_MAX_SCAN_BLOCKS;
    const ended = phase >= PHASE.SETTLED;
    const endTopics = new Set(['RoundSettled', 'RoundCancelled'].map((n) => iface.getEvent(n).topicHash));
    const failTopic = iface.getEvent('EvaluationFailed').topicHash;
    const isEnd = (log) => endTopics.has(log.topics[0])
      || (log.topics[0] === failTopic && [PHASE.DRAW, PHASE.BEACON].includes(Number(iface.parseLog(log).args.phase)));
    const topics = [iface.fragments.filter((f) => f.type === 'event').map((f) => f.topicHash), aggId];
    const logs = [];
    // Sequential, NOT Promise.all: concurrent getLogs get batched into one
    // JSON-RPC call by ethers, and the Tenderly archive gateway hangs on batched
    // eth_getLogs. Also what lets the walk stop at the round's end.
    for (let start = fromBlock; start <= toBlock; start += this.logMaxChunk) {
      const end = Math.min(start + this.logMaxChunk - 1, toBlock);
      const chunk = await withRetry(() => logProvider.getLogs({ address: this.aggregatorAddress, topics, fromBlock: start, toBlock: end }));
      logs.push(...chunk);
      if (ended && chunk.some(isEnd)) { toBlock = end; break; }
    }
    logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));

    const timeline = [];
    let requestEvent = null, fulfillment = null, failedPhase = null;
    let draw = null, promoteTx = null, settleTx = null, beaconStage = false, scoringReverted = false;
    const beaconPayments = [], refunds = [], commitPayments = [], poolPayments = [];
    let cancelledWei = null;
    const lateBySlot = {}, skipBySlot = {}, bonusBySlot = {};
    for (const log of logs) {
      let p;
      try { p = iface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      const a = p.args;
      const entry = { event: p.name, block: log.blockNumber, txHash: log.transactionHash, detail: null };
      switch (p.name) {
        case 'RequestAIEvaluation':
          requestEvent = { block: log.blockNumber, txHash: log.transactionHash, cids: [...a.cids] };
          entry.detail = `${a.cids.length} CID${a.cids.length === 1 ? '' : 's'}`;
          break;
        case 'RequestFunded': entry.detail = `requester ${a.requester}, ${fmt(a.fromValue)} ETH sent, ${fmt(a.fromCredit)} ETH from credit`; break;
        case 'SeedSealed': entry.detail = 'draw seed sealed'; break;
        case 'JuryDrawn':
          draw = { drawer: String(a.drawer), wei: a.reward, txHash: log.transactionHash };
          entry.detail = `drawn by ${a.drawer}, reward ${fmt(a.reward)} ETH`;
          break;
        case 'BeaconStageStarted': beaconStage = true; entry.detail = `${a.beacons} beacons called`; break;
        case 'BeaconPayment':
          beaconPayments.push({ payee: String(a.payee), wei: a.amount });
          entry.detail = `${fmt(a.amount)} ETH to ${a.payee}`;
          break;
        case 'CommitReceived': entry.detail = `slot ${a.pollIndex}`; break;
        case 'CommitWindowClosed': entry.detail = `close block ${a.closeBlock}`; break;
        case 'CommitPhaseComplete':
          promoteTx = log.transactionHash;
          entry.detail = `${a.promoted} commits promoted`;
          break;
        case 'RevealReceived': {
          const i = Number(a.pollIndex);
          lateBySlot[i] = Boolean(a.late);
          entry.detail = `slot ${i}${a.late ? ` (late, ${QCODE_NAMES[Number(a.qcode)] || 'unclassified'})` : ''}`;
          break;
        }
        case 'FulfillAIEvaluation':
          fulfillment = {
            aggregated: a.aggregated.map((s) => s.toString()),
            justificationCIDs: String(a.justifications).split(',').filter(Boolean),
            block: log.blockNumber,
            txHash: log.transactionHash,
          };
          entry.detail = `[${fulfillment.aggregated.join(', ')}]`;
          break;
        case 'EvaluationFailed':
          failedPhase = Number(a.phase);
          entry.detail = `failed in the ${PHASE_NAMES[failedPhase] || failedPhase} phase`;
          break;
        case 'RoundSettled':
          settleTx = log.transactionHash;
          entry.detail = a.failed ? 'settled as failed' : 'settled';
          break;
        case 'RoundCancelled':
          cancelledWei = a[1];   // toPool: the arbiter pool's
          entry.detail = `${fmt(a[1])} ETH to the arbiter pool`;
          break;
        case 'CommitPayment':
          commitPayments.push({ payee: String(a.payee), wei: a.amount });
          entry.detail = `committer share: ${fmt(a.amount)} ETH to ${a.payee}`;
          break;
        case 'PoolPayment':
          poolPayments.push({ payee: String(a.payee), wei: a.amount });
          entry.detail = `arbiter pool payout at this draw: ${fmt(a.amount)} ETH to ${a.payee}`;
          break;
        case 'BasePayment': entry.detail = `slot ${a.pollIndex}: ${fmt(a.amount)} ETH to ${a.payee}`; break;
        case 'BonusPayment':
          bonusBySlot[Number(a.pollIndex)] = fmt(a.amount);
          entry.detail = `slot ${a.pollIndex}: ${fmt(a.amount)} ETH to ${a.payee}`;
          break;
        case 'RequesterRefunded': {
          // _refund pays the arbiter pool (address(0)) instead of the requester when a
          // refund would be a free re-roll (missed beacon quorum, a seed-dependent draw
          // failure, the dust of a never-promoted round)
          const toPool = isPool(a.requester);
          refunds.push({ to: String(a.requester), wei: a.amount, toPool });
          entry.detail = toPool
            ? `${fmt(a.amount)} ETH to the arbiter pool (no refund)`
            : `${fmt(a.amount)} ETH refunded to ${a.requester}`;
          break;
        }
        case 'SlotSkipped': {
          const i = a.pollIndex === ethers.MaxUint256 ? null : Number(a.pollIndex);
          const reason = SKIP_REASONS[Number(a.reason)] || `reason ${a.reason}`;
          if (i != null) skipBySlot[i] = reason;
          else if (Number(a.reason) === 4) scoringReverted = true;
          entry.detail = i != null ? `slot ${i}: ${reason}` : reason;
          break;
        }
        default: break;
      }
      timeline.push(entry);
    }

    // 5. Money. getRoundInfo's `rewards` lumps the draw reward (JuryDrawn), the
    //    promote reward (no event), the beacon payments (BeaconPayment) and a
    //    never-promoted round's committer shares (CommitPayment), so the promote
    //    reward is derived as rewards − draw − beacons − committers. It went to
    //    whoever called promote(): the sender of the CommitPhaseComplete
    //    transaction. A PoolPayment at this round's draw comes out of the arbiter
    //    pool, not this round's prepay, so it is not in `rewards`.
    const drawWei = draw ? draw.wei : 0n;
    const beaconWei = beaconPayments.reduce((acc, b) => acc + b.wei, 0n);
    const committerWei = commitPayments.reduce((acc, b) => acc + b.wei, 0n);
    const promoteWei = BigInt(ri.rewards) - drawWei - beaconWei - committerWei;
    let promoter = null;
    if (promoteTx) {
      promoter = await withRetry(() => this.provider.getTransaction(promoteTx))
        .then((tx) => (tx && tx.from ? ethers.getAddress(tx.from) : null)).catch(() => null);
    }
    const refundWei = refunds.filter((r) => !r.toPool).reduce((acc, r) => acc + r.wei, 0n);
    const poolWei = refunds.filter((r) => r.toPool).reduce((acc, r) => acc + r.wei, 0n) + (cancelledWei || 0n);
    const money = {
      received: fmt(ri.received),
      baseFees: fmt(ri.baseFees),
      bonuses: fmt(ri.bonuses),
      rewards: fmt(ri.rewards),
      draw: draw ? { eth: fmt(drawWei), to: draw.drawer } : null,
      promote: promoteTx ? { eth: fmt(promoteWei), to: promoter, derived: 'rewards − draw − beacons − committers' } : null,
      beacons: beaconPayments.length
        ? { eth: fmt(beaconWei), payments: beaconPayments.map((b) => ({ payee: b.payee, eth: fmt(b.wei) })) }
        : null,
      committers: commitPayments.length
        ? { eth: fmt(committerWei), payments: commitPayments.map((b) => ({ payee: b.payee, eth: fmt(b.wei) })) }
        : null,
      refunded: refunds.some((r) => !r.toPool) ? fmt(refundWei) : null,
      toPool: poolWei > 0n ? fmt(poolWei) : null,
      // paid out of the arbiter pool at this round's draw (not from this round's prepay)
      poolPayout: poolPayments.length
        ? { eth: fmt(poolPayments.reduce((acc, b) => acc + b.wei, 0n)), payments: poolPayments.map((b) => ({ payee: b.payee, eth: fmt(b.wei) })) }
        : null,
    };

    // 6. Beacon arbiters (JuryBeacons.getBeacons), when the round had a beacon stage.
    let beaconArbiters = null;
    if (beaconStage && beaconsAddr && beaconsAddr !== ZERO_ADDRESS) {
      try {
        const jb = new ethers.Contract(beaconsAddr, BEACONS_ABI, this.provider);
        const res = await withRetry(() => jb.getBeacons(this.aggregatorAddress, aggId));
        beaconArbiters = await Promise.all([...res.keys].map(async (key) => {
          const [jobId, a] = await Promise.all([
            withRetry(() => keeper.jobIdOf(key)).then(String).catch(() => null),
            withRetry(() => keeper.getArbiter(key)).catch(() => null),
          ]);
          return { key: String(key), jobId, oracle: a && a.oracle !== ZERO_ADDRESS ? ethers.getAddress(a.oracle) : null };
        }));
      } catch (err) {
        logger.warn('agg-history: getBeacons failed', { network: this.networkKey, aggId, msg: err.message });
      }
    }

    // 7. Settlement outcome per slot: what _settle reports (expected), and once
    //    settled what the keeper actually did (from the settle tx's receipt).
    //    settlePhase is the phase the round was in at settlement: EvaluationFailed
    //    at settlement carries it (3, 4, 5); a finished round settles from 6.
    let settlePhase = null;
    if (phase === PHASE.SETTLED || phase === PHASE.FINAL) settlePhase = PHASE.FINAL;
    else if (phase === PHASE.FAILED && [PHASE.COMMIT, PHASE.CLOSING, PHASE.REVEAL].includes(failedPhase)) settlePhase = failedPhase;
    const { points } = await this._getStatusCtx().catch(() => ({ points: DEFAULT_POINTS }));
    let actualByKey = null, settleNote = null;
    if (settleTx) {
      if (scoringReverted) {
        settleNote = 'The keeper scoring call reverted at settlement: no scores were applied for this round.';
      } else {
        try {
          actualByKey = await this._settleKeeperEvents(settleTx, aggId);
        } catch (err) {
          settleNote = `Could not read the settlement receipt: ${err.message}`;
          logger.warn('agg-history: settle receipt failed', { network: this.networkKey, aggId, msg: err.message });
        }
      }
    }

    const slots = rawSlots.map((s, n) => {
      const flags = decodeSlotFlags(s.flags);
      const expected = settlePhase != null
        ? slotOutcome({ settlePhase, commits: roundInfo.commits, M, K: rawSlots.length, flags: s.flags, qcode: s.qcode, points })
        : null;
      return {
        slot: s.index,
        oracle: s.oracle,
        jobId: jobIds[n],
        key: s.key,
        payee: s.payee,
        fee: s.fee,
        paid: flags.dispatched,        // a slot skipped at the draw was never paid its fee
        bonus: bonusBySlot[s.index] || null,
        ...flags,
        late: !!lateBySlot[s.index],
        quality: QCODE_NAMES[s.qcode] || null,
        committedAt: s.committedAt || null,
        skipped: skipBySlot[s.index] || null,
        expected,
        // null until settled; then { scored, quality, timeliness, blockedUntil?, offenses? } or { skippedFrozen: true }
        actual: actualByKey ? (actualByKey[s.key.toLowerCase()] || { scored: false }) : null,
      };
    });
    const refundTo = refunds.length ? (refunds.some((r) => r.toPool) ? 'pool' : 'requester') : null;
    const d = describeRound({
      phase, failedPhase, M, N, fulfilled: !!fulfillment, refundTo,
      slots: rawSlots.map((s) => ({ flags: s.flags, qcode: s.qcode, late: lateBySlot[s.index], skipReason: skipBySlot[s.index] })),
    });

    return {
      found: true,
      aggId,
      round,
      network: this.networkKey,
      contractParams,
      roundInfo,
      requestEvent,
      slots,
      beaconArbiters,
      money,
      points,
      settlement: { settled: !!settleTx, txHash: settleTx, settlePhase, note: settleNote },
      fulfillment,
      outcome: d.label,
      outcomeKind: d.kind,
      failStage: d.failStage,
      notDrawnReason: d.notDrawnReason,
      forfeit: d.forfeit,
      blame: d.blame,
      analysis: d.analysis,
      timeline,
      scan: { fromBlock, toBlock, truncated },
    };
  }

  /**
   * The keeper's per-key events from a round's settle transaction. One
   * transaction may settle several rounds (a request settles due rounds too),
   * and the aggregator emits RoundSettled after each round's applyOutcomes, so
   * this round's keeper events are those after the previous RoundSettled of this
   * aggregator and up to its own. Decoded with the keeper's interface, from logs
   * whose address is the keeper.
   * @returns {Promise<Object<string, object>>} keyLower → { scored, quality, timeliness } |
   *   { skippedFrozen: true }, plus blockedUntil / offenses when the arbiter was blocked
   */
  async _settleKeeperEvents(txHash, aggId) {
    const keeper = await this.getReputationKeeper();
    const rcpt = await withRetry(() => this._getReceiptProvider().getTransactionReceipt(txHash));
    if (!rcpt) throw new Error('receipt not available');
    const aggIface = new ethers.Interface(AGG_EVENT_ABI);
    const settledTopic = aggIface.getEvent('RoundSettled').topicHash;
    const aggLower = this.aggregatorAddress.toLowerCase();
    const keeperLower = this.keeperAddress.toLowerCase();
    let segment = [];
    for (const log of [...rcpt.logs].sort((a, b) => a.index - b.index)) {
      const addr = String(log.address).toLowerCase();
      if (addr === keeperLower) {
        segment.push(log);
      } else if (addr === aggLower && log.topics[0] === settledTopic) {
        if (String(log.topics[1]).toLowerCase() === aggId.toLowerCase()) break;
        segment = [];
      }
    }
    const out = {};
    for (const log of segment) {
      let p;
      try { p = keeper.interface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      if (!p) continue;
      const k = String(p.args.key).toLowerCase();
      if (p.name === 'ScoresUpdated') {
        out[k] = { ...(out[k] || {}), scored: true, quality: Number(p.args.quality), timeliness: Number(p.args.timeliness) };
      } else if (p.name === 'OutcomeSkippedFrozen') {
        out[k] = { ...(out[k] || {}), scored: false, skippedFrozen: true };
      } else if (p.name === 'ArbiterBlocked') {
        out[k] = { ...(out[k] || {}), blockedUntil: Number(p.args.until), offenses: Number(p.args.offenses) };
      }
    }
    return out;
  }

  /**
   * Arbiters grouped by owner address (the ArbiterOperator owner), with totals
   * for the analytics "Arbiters by Owner" table: arbiter/operator counts, status
   * tallies, average reputation, claimable ETH (ethOwed on the aggregator, per
   * owner) and node funding.
   * Sorted by owner address, numerically ascending.
   */
  async getOwnersAnalytics() {
    const oracles = await this.getAllOracles();
    const valid = oracles.filter((o) => !o.error && o.oracle);
    const operatorAddrs = [...new Set(valid.map((o) => o.oracle))];

    const [ownerMap, fundingData] = await Promise.all([
      this.getOwnerMap(operatorAddrs),
      this._computeFunding(operatorAddrs)
    ]);
    const { perOp: fundingPerOp, gasPrice } = fundingData;

    const byOwner = {};
    for (const o of valid) {
      const opLower = o.oracle.toLowerCase();
      const owner = ownerMap[opLower] || null;
      const key = owner ? owner.toLowerCase() : 'unknown';
      if (!byOwner[key]) {
        byOwner[key] = { owner, operators: new Set(), arbiters: 0, qSum: 0, tSum: 0, offenses: 0, ...emptyTally() };
      }
      const b = byOwner[key];
      b.operators.add(opLower);
      b.arbiters += 1;
      b.qSum += o.qualityScore;
      b.tSum += o.timelinessScore;
      b.offenses += o.offenses || 0;
      b[o.status] += 1;
    }

    // Per-owner claimable ETH (ethOwed on the aggregator), read once per distinct owner.
    // The unknown-owner bucket has no address and gets null.
    const ownerAddrs = Object.values(byOwner).map((b) => b.owner).filter(Boolean);
    const ethOwedMap = await this.getEthOwedMap(ownerAddrs);

    const owners = Object.values(byOwner).map((b) => {
      let nodeWei = 0n;
      for (const op of b.operators) {
        nodeWei += fundingPerOp[op]?.totalWei ?? 0n;
      }
      const owedWei = b.owner ? ethOwedMap[b.owner.toLowerCase()] : null;
      const estQueries = this._estQueries(nodeWei, gasPrice);
      return {
        owner: b.owner,
        operators: b.operators.size,
        arbiters: b.arbiters,
        ...Object.fromEntries(STATUSES.map((s) => [s, b[s]])),
        offenses: b.offenses,
        avgQualityScore: Math.round(b.qSum / b.arbiters),
        avgTimelinessScore: Math.round(b.tSum / b.arbiters),
        claimableEth: owedWei != null ? ethers.formatEther(owedWei) : null,
        nodeEth: ethers.formatEther(nodeWei),
        estQueries,
        fundingLow: this._fundingLow(nodeWei, estQueries)
      };
    });

    // Numeric ascending by address (lowercase fixed-width hex == numeric order);
    // unknown-owner bucket sorts last.
    owners.sort((a, b) => {
      if (!a.owner) return 1;
      if (!b.owner) return -1;
      const x = a.owner.toLowerCase();
      const y = b.owner.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });

    return {
      owners,
      funding: {
        gasPriceGwei: gasPrice != null ? ethers.formatUnits(gasPrice, 'gwei') : null,
        gasPerQuery: funding.gasPerQuery,
        lowQueriesThreshold: funding.lowQueriesThreshold,
        lowEthThreshold: funding.lowEthThreshold
      },
      timestamp: Date.now()
    };
  }

  /**
   * Check if the service is properly configured: the aggregator answers, its
   * keeper and the wVDKA token resolve, and the config reads.
   */
  async healthCheck() {
    try {
      const keeper = await this.getReputationKeeper();
      const config = await this.getAggregatorConfig();
      let wvdkaAddress = null;
      try {
        wvdkaAddress = String(await withRetry(() => keeper.verdiktaToken()));
      } catch (err) {
        logger.debug('Could not get wVDKA token address', { msg: err.message });
      }
      return {
        healthy: true,
        aggregatorAddress: this.aggregatorAddress,
        keeperAddress: this.keeperAddress,
        // Chainlink transport token for the 0-juel request rail (config; v2 has no
        // getContractConfig). Not a payment token — arbiters are paid in ETH.
        linkTokenAddress: this.linkTokenAddress,
        wvdkaAddress,
        config
      };
    } catch (error) {
      return {
        healthy: false,
        configured: !!this.aggregator,
        aggregatorAddress: this.aggregatorAddress,
        error: error.message
      };
    }
  }

  /**
   * ERC-20 metadata for a token (e.g. wVDKA). Each field is fetched
   * independently so a token missing one optional getter still returns the
   * rest. totalSupply is formatted using the token's own decimals.
   */
  async getTokenInfo(tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      withRetry(() => token.name()).catch(() => null),
      withRetry(() => token.symbol()).catch(() => null),
      withRetry(() => token.decimals()).catch(() => null),
      withRetry(() => token.totalSupply()).catch(() => null)
    ]);
    const dec = decimals != null ? Number(decimals) : 18;
    return {
      address: tokenAddress,
      name,
      symbol,
      decimals: decimals != null ? dec : null,
      totalSupply: totalSupply != null ? ethers.formatUnits(totalSupply, dec) : null
    };
  }
}

// One cached service instance per canonical network key.
const instances = new Map();

/**
 * Get (or lazily create) the VerdiktaService for a network. Accepts any caller
 * form (e.g. 'base_sepolia'); unknown values fall back to the default network.
 * @param {string} [networkKey]
 * @returns {VerdiktaService}
 */
function getVerdiktaService(networkKey) {
  const key = normalizeNetwork(networkKey);
  if (!instances.has(key)) {
    const net = networks[key];
    const cc = getContractsConfig(key);
    const service = new VerdiktaService(getRpcUrl(key), cc.aggregatorAddress, {
      networkKey: key,
      linkTokenAddress: net.linkTokenAddress || null,
      aggregatorFromBlock: cc.aggregatorFromBlock,
      keeperFromBlock: cc.keeperFromBlock,
      archiveRpcUrl: getArchiveRpcUrl(key),
      logScan: getLogScanRpc(key),
      receiptRpcUrl: getReceiptRpcUrl(key)
    });
    instances.set(key, service);
    if (!cc.aggregatorAddress) {
      logger.warn('Verdikta v2 aggregator not configured for this network (placeholder in config.js)', { network: key });
    } else {
      logger.info('Verdikta service initialized', { network: key, aggregatorAddress: cc.aggregatorAddress });
    }
  }
  return instances.get(key);
}

module.exports = {
  getVerdiktaService,
  VerdiktaService,
  NotConfiguredError,
  toAggId,
  juryTally,
};
