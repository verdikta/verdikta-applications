/**
 * Verdikta Service
 * Reads the v2 ReputationAggregator and its ReputationKeeper (verdikta-dispatcher `beacon` branch)
 * for analytics: the arbiter registry, class eligibility for a bounty's settings and jury, the
 * aggregator's configuration, and one round's history. One aggregator serves every jury size: the
 * jury (K, M, N, P, timeout) is each request's, read back per round with getJury(aggId).
 *
 * v2 differences that shape this file:
 *  - The keeper has no index-able registry: arbiters are found from ArbiterRegistered logs and read
 *    by key (getArbiter, arbiterClasses, jobIdOf). Status comes from the arbiter's flags, its block
 *    and its health-call freeze (callCount, recent scores and the mild/severe thresholds are gone).
 *  - Round ids are sequential PER AGGREGATOR, so a round is named by (aggregator, aggId); this
 *    service reads the escrow's one aggregator.
 *  - A round's state is getRoundInfo's phase; each juror is a slot (getSlot). The v1 reveal
 *    diagnostics are replaced by each counted reveal's quality code.
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const { AGGREGATOR_ABI, PHASES } = require('./aggregatorAbi');
const { presetByKey } = require('../../shared/classPresets');

/** A bounty jury's draw size K ({K, ...}); the Small preset's when the jury is unknown. */
function juryK(jury) {
  const k = Number(jury && typeof jury === 'object' ? jury.K : NaN);
  return Number.isInteger(k) && k > 0 ? k : presetByKey('small').jury.K;
}

// Event-scan tuning. Public RPCs (e.g. mainnet.base.org) reject eth_getLogs over a >10,000-block
// range, so every scan is chunked and bounded to a window after the round's request block.
const MAX_LOG_RANGE = 9000;          // < 10k RPC cap, per getLogs chunk
// A round's events land within a day of its request (DRAW_GRACE), the commit/reveal part within its
// deadline; at Base's 2 s blocks a day is 43,200 blocks. Scanned in chunks.
const EVENT_WINDOW = 45000;

// Outcome label for a drawn round that failed with zero commits from any juror: a request that no
// arbiter ever committed to is most likely a malformed evaluation package, not a node failure.
// Mirrors example-arbiters' rule. Exported so callers (e.g. the /diagnose route) can detect it.
const LIKELY_MALFORMED_OUTCOME = 'LIKELY MALFORMED EVALUATION PACKAGE (no arbiter committed)';

// ReputationKeeper (v2) ABI: the parts analytics reads.
const KEEPER_ABI = [
  'event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee)',
  'event ArbiterRemoved(bytes32 indexed key, uint256 refunded)',
  'function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))',
  'function arbiterClasses(bytes32 key) view returns (uint64[])',
  'function jobIdOf(bytes32 key) view returns (bytes32)',
  'function isFrozen(bytes32 key) view returns (bool)',
  'function classSize(uint64 cls) view returns (uint256)',
  'function scansAll(uint64 cls) view returns (bool)',
  'function points() view returns (uint16 gain, uint16 minor, uint16 major, uint16 fail, uint16 nocommit, uint16 start, uint16 cap)',
  'function stakeRequirement() view returns (uint256)',
  'function callDeadline() view returns (uint40)',
  'function verdiktaToken() view returns (address)'
];

// The keeper's arbiter flags.
const F_REGISTERED = 1, F_PAUSED = 2, F_BANNED = 4, F_EXITING = 8, F_UNDERSTAKED = 32, F_RESYNC = 64;
// getSlot flags.
const S_DISPATCHED = 1, S_COMMITTED = 2, S_PROMOTED = 4, S_REVEALED = 8, S_COUNTED = 16;
const QCODES = { 0: null, 1: 'close', 2: 'off', 3: 'far' };
// SlotSkipped reasons (ReputationAggregator._pollSlot / _promote / _settle).
const SKIP_REASONS = Object.freeze({
  1: 'operator owner() failed (no payee): not dispatched, not paid',
  2: 'commit request dispatch reverted: not paid',
  3: 'reveal request dispatch reverted (promoted, but never asked to reveal)',
  4: 'keeper outcome call reverted at settlement (scores not applied)'
});
// The draw may not run later than this after the request (ReputationAggregator.DRAW_GRACE).
const DRAW_GRACE_SECONDS = 86400;
// What happens to the unspent prepay of a round that failed in each phase (EvaluationFailed.phase).
const FAIL_MONEY = Object.freeze({
  1: 'draw failed: refunded (a pool shortage or too few eligible), but to the arbiter pool after a beacon stage when the selection walk does not cover the whole class',
  2: 'beacon quorum missed: the beacons that answered are paid, the rest goes to the arbiter pool',
  3: 'commit phase: shared equally by the committers if M commits arrived (never closed; the indivisible rest to the arbiter pool), otherwise refunded',
  4: 'closed but never promoted: shared equally by the committers (the indivisible rest to the arbiter pool)',
  5: 'reveal phase: refunded'
});

// JuryBeacons: a beacon stage needs `quorum` values; it polls max(polled, quorum) beacons.
const BEACONS_ABI = [
  'function quorum() view returns (uint8)',
  'function polled() view returns (uint8)'
];

// ArbiterOperator (Chainlink Operator) ABI — ownership is the operator's own `owner()`.
const OPERATOR_ABI = [
  'function owner() view returns (address)'
];

/**
 * An arbiter's status for analytics, from its keeper state (v2). The client shows the same names
 * (Analytics.jsx ARBITER_STATUS):
 *   inactive  not registered, paused, exiting or under-staked: never selected
 *   blocked   banned, or locked until blockedUntil (the keeper's Table 2 lock after a score reached 0)
 *   frozen    a health call went unanswered (or its chain is re-syncing): not selected until it answers
 *   new       both scores still at points().start
 *   active    selectable
 */
function arbiterStatus(a, { now = Math.floor(Date.now() / 1000), start = 500 } = {}) {
  const f = Number(a.flags);
  if (!(f & F_REGISTERED) || (f & (F_PAUSED | F_EXITING | F_UNDERSTAKED))) return 'inactive';
  if ((f & F_BANNED) || Number(a.blockedUntil) > now) return 'blocked';
  if (a.frozen || (f & F_RESYNC)) return 'frozen';
  if (Number(a.qualityScore) === start && Number(a.timelinessScore) === start) return 'new';
  return 'active';
}

class VerdiktaService {
  /**
   * @param {string} providerUrl
   * @param {string} aggregator  the escrow's aggregator (BountyEscrow.aggregator(); serves every jury)
   * @param {number} deployBlock  lower bound for event scans (the aggregator's deploy block)
   */
  constructor(providerUrl, aggregator, deployBlock = 0) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.aggregatorAddress = aggregator;
    this.aggregatorDeployBlock = Number(deployBlock) || 0;
    this.aggregator = new ethers.Contract(aggregator, AGGREGATOR_ABI, this.provider);
    this.keeper = null;
    this.keeperAddress = null;
    this._oraclesCache = null;          // { data, ts }
    this._ownerMap = {};                // { operatorLower: { owner, ts } }
    this._jobIds = {};                  // key -> jobId (static)
  }

  /**
   * A round's jury as the aggregator stores it (getJury): { K, M, N, P, timeout }, or null for an
   * unknown round (getJury returns zeros). Fixed at the request, so cached.
   */
  async getRoundJury(aggId) {
    if (!this._juries) this._juries = new Map();
    const id = String(aggId).toLowerCase();
    if (this._juries.has(id)) return this._juries.get(id);
    const [K, M, N, P, timeout] = (await this._withRetry(() => this.aggregator.getJury(aggId), 'getJury')).map(Number);
    const jury = K > 0 ? { K, M, N, P, timeout } : null;
    if (jury) this._juries.set(id, jury);
    return jury;
  }

  // Retry a read against transient RPC errors (public/load-balanced endpoints intermittently fail
  // otherwise-valid calls). Short linear backoff; re-throws the last error.
  async _withRetry(fn, label, tries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn('[verdikta] RPC read failed, retrying', {
          label, attempt, tries, msg: (err.shortMessage || err.message || '').slice(0, 80)
        });
        if (attempt < tries) await new Promise(r => setTimeout(r, 300 * attempt));
      }
    }
    throw lastErr;
  }

  // Public RPCs cap eth_getLogs at a 10,000-block range: scan in chunks, ascending.
  async _getLogsChunked(address, topics, fromBlock, toBlock, chunkSize = MAX_LOG_RANGE) {
    const out = [];
    if (toBlock < fromBlock) return out;
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const chunk = await this._withRetry(
        () => this.provider.getLogs({ address, topics, fromBlock: start, toBlock: end }),
        `getLogs[${start}-${end}]`
      );
      out.push(...chunk);
    }
    return out;
  }

  async _getBlockTimestamps(blockNumbers) {
    const unique = [...new Set(blockNumbers.filter(b => Number.isInteger(b)))];
    const out = {};
    await Promise.all(unique.map(async (bn) => {
      try {
        const blk = await this._withRetry(() => this.provider.getBlock(bn), `getBlock[${bn}]`);
        if (blk && blk.timestamp != null) out[bn] = Number(blk.timestamp);
      } catch (err) {
        logger.warn('Failed to fetch block timestamp', { block: bn, msg: err.message });
      }
    }));
    return out;
  }

  /** The aggregator's ReputationKeeper (lazy-loaded). */
  async getReputationKeeper() {
    if (!this.keeper) {
      this.keeperAddress = await this.aggregator.keeper();
      this.keeper = new ethers.Contract(this.keeperAddress, KEEPER_ABI, this.provider);
      logger.info('ReputationKeeper loaded', { address: this.keeperAddress });
    }
    return this.keeper;
  }

  /**
   * The aggregator's configuration. The jury (K, M, N, P, timeout) is not here: it is each
   * request's (the bounty's), read per round with getRoundJury. The owner bounds it: K <= maxJury
   * (and the keeper's shortlist), T+ < timeout <= maxTimeout and <= 1 day. A round's commit window closes at M+
   * commits, or after T+ (from the draw) with at least M; the round deadline (its timeout) runs
   * from the draw.
   */
  async getAggregatorConfig() {
    const agg = this.aggregator;
    const [bonusMultiplier, maxOracleFee, tPlus, revealWindow, maxJury, maxTimeout] =
      await this._withRetry(() => Promise.all([
        agg.bonusMultiplier(), agg.maxOracleFee(), agg.tPlus(), agg.revealWindow(), agg.maxJury(), agg.maxTimeout()
      ]), 'aggregator-config');
    // Newer reads: optional, so an older deployment still answers the core config.
    const opt = async (fn) => { try { return await this._withRetry(fn, 'aggregator-config-opt', 2); } catch { return null; } };
    // the arbiter pool is the ledger entry ethOwed(address(0)): forfeits in, an eighth out per draw
    const [drawRewardFees, promoteRewardFees, spreadFloor, beaconsAddr, poolWei] = await Promise.all([
      opt(() => agg.drawRewardFees()), opt(() => agg.promoteRewardFees()), opt(() => agg.spreadFloor()),
      opt(() => agg.beacons()), opt(() => agg.ethOwed(ethers.ZeroAddress))
    ]);
    let beaconQuorum = null;
    let beaconPolled = null;
    if (beaconsAddr && beaconsAddr !== ethers.ZeroAddress) {
      const jb = new ethers.Contract(beaconsAddr, BEACONS_ABI, this.provider);
      [beaconQuorum, beaconPolled] = await Promise.all([opt(() => jb.quorum()), opt(() => jb.polled())]);
    }
    return {
      aggregator: this.aggregatorAddress,
      bonusMultiplier: Number(bonusMultiplier),
      maxJury: Number(maxJury),
      maxTimeout: Number(maxTimeout),
      tPlus: Number(tPlus),
      revealWindow: Number(revealWindow),
      maxOracleFee: ethers.formatEther(maxOracleFee),
      drawRewardFees: drawRewardFees == null ? null : Number(drawRewardFees),
      promoteRewardFees: promoteRewardFees == null ? null : Number(promoteRewardFees),
      // on the arbiters' 0..1,000,000 scale; / 10,000 = points of 100
      spreadFloor: spreadFloor == null ? null : Number(spreadFloor),
      beacons: beaconsAddr && beaconsAddr !== ethers.ZeroAddress ? beaconsAddr : null,
      beaconQuorum: beaconQuorum == null ? null : Number(beaconQuorum),
      beaconPolled: beaconPolled == null ? null : Number(beaconPolled),
      arbiterPool: poolWei == null ? null : ethers.formatEther(poolWei)
    };
  }

  /** Registered arbiters (excludes exited ones). */
  async getOracleCount() {
    const all = await this.getAllOracles();
    return all.filter(o => !o.error).length;
  }

  /**
   * The keeper's registry, rebuilt from ArbiterRegistered logs and read by key. Memoized for
   * `maxAgeMs`; concurrent callers share one walk. A key that can't be read yields an error sentinel
   * (and the walk is then not memoized, so the next call retries).
   */
  async getAllOracles({ maxAgeMs = 60000 } = {}) {
    if (this._oraclesCache && Date.now() - this._oraclesCache.ts < maxAgeMs) {
      return this._oraclesCache.data;
    }
    if (this._oraclesInFlight) return this._oraclesInFlight;
    this._oraclesInFlight = this._walkOracles().finally(() => {
      this._oraclesInFlight = null;
    });
    return this._oraclesInFlight;
  }

  async _walkOracles() {
    const keeper = await this.getReputationKeeper();
    const head = await this.provider.getBlockNumber();
    const topic = keeper.interface.getEvent('ArbiterRegistered').topicHash;
    const logs = await this._getLogsChunked(this.keeperAddress, [topic], this.aggregatorDeployBlock, head);
    const keys = [];
    const seen = new Set();
    for (const log of logs) {
      const p = keeper.interface.parseLog(log);
      if (!seen.has(p.args.key)) { seen.add(p.args.key); keys.push({ key: p.args.key, jobId: p.args.jobId }); }
    }
    const oracles = [];
    const batchSize = 6;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize).map(async ({ key, jobId }, j) => {
        try {
          const [a, classes, frozen] = await this._withRetry(() => Promise.all([
            keeper.getArbiter(key), keeper.arbiterClasses(key), keeper.isFrozen(key)
          ]), `arbiter ${key.slice(0, 10)}`);
          return {
            index: i + j,
            key,
            oracle: a.oracle,
            jobId,
            classes: classes.map(c => Number(c)),
            flags: Number(a.flags),
            isActive: (Number(a.flags) & F_REGISTERED) !== 0 &&
              (Number(a.flags) & (F_PAUSED | F_BANNED | F_EXITING | F_UNDERSTAKED)) === 0,
            registered: (Number(a.flags) & F_REGISTERED) !== 0,
            qualityScore: Number(a.quality),
            timelinessScore: Number(a.timeliness),
            offenses: Number(a.offenses),
            fee: ethers.formatEther(a.fee),
            stakeAmount: ethers.formatEther(a.stake),
            lockedUntil: Number(a.blockedUntil),
            blocked: Number(a.blockedUntil) > Math.floor(Date.now() / 1000),
            frozen: Boolean(frozen),
            resyncing: (Number(a.flags) & F_RESYNC) !== 0,
            exitAt: Number(a.exitAt),
            callSentAt: Number(a.callSentAt),
            callAnsweredAt: Number(a.callAnsweredAt)
          };
        } catch (err) {
          logger.warn('[verdikta] Failed to read arbiter, skipping', { key, msg: err.message });
          return { index: i + j, key, error: err.message };
        }
      });
      oracles.push(...(await Promise.all(batch)));
    }
    // Exited arbiters (completeExit) are no longer registered; keep only registered ones.
    const out = oracles.filter(o => o.error || o.registered);
    if (!out.some(o => o.error)) this._oraclesCache = { data: out, ts: Date.now() };
    return out;
  }

  /** The keeper's starting score (a "new" arbiter still has it for both scores). */
  async _startScore() {
    try {
      const keeper = await this.getReputationKeeper();
      const p = await keeper.points();
      return Number(p.start);
    } catch {
      return 500;
    }
  }

  /**
   * operator (lowercased) -> owner address (or null if unreadable), cached per instance.
   */
  async getOwnerMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const unique = [...new Set(operatorAddrs.map(a => String(a).toLowerCase()))];
    const stale = unique.filter(a => {
      const e = this._ownerMap[a];
      return !e || now - e.ts >= maxAgeMs;
    });
    const batchSize = 6;
    for (let i = 0; i < stale.length; i += batchSize) {
      const slice = stale.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        const owner = await this._withRetry(() => op.owner(), `owner(${addr.slice(0, 10)})`).catch(() => null);
        this._ownerMap[addr] = { owner: owner ? String(owner) : null, ts: now };
      }));
    }
    const map = {};
    for (const a of unique) map[a] = this._ownerMap[a]?.owner ?? null;
    return map;
  }

  /**
   * Oracle-check for a bounty: how many registered arbiters in `classId` the bounty's jury could
   * draw under its settings. Eligible (the keeper's own rule, _eligibleAt): registered, not paused,
   * banned, exiting or under-staked, not blocked, not frozen, and posting a fee at or below the
   * bounty's fee ceiling. A fee below the bounty's floor is paid the floor (it doesn't exclude).
   * The draw fills the jury's K slots from the eligible arbiters: with fewer than K, the keeper
   * repeats arbiters (slot k holds pick k mod m), and it fails (refunded) only when none is eligible.
   *
   * A beacon bounty also needs the JuryBeacons quorum from the same class, checked separately:
   * beacons have no fee cap (ReputationKeeper.pickBeacons: registered and selectable only).
   *
   * @param {number} classId
   * @param {{maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling, minOracleFee?, withBeacons?}} oracleSettings (wei strings)
   * @param {{jury?: {K, M, N, P, timeout}}} [opts]  the bounty's jury (its K is the draw size; the
   *   Small preset's K when not given)
   */
  async getClassOracleEligibility(classId, oracleSettings, { jury = null } = {}) {
    const cls = Number(classId);
    const maxFeeWei = BigInt(String(oracleSettings?.maxOracleFee ?? '0'));
    const minFeeWei = BigInt(String(oracleSettings?.minOracleFee ?? '0'));
    const alpha = Number(oracleSettings?.alpha ?? 0);
    const baseCostWei = BigInt(String(oracleSettings?.estimatedBaseCost ?? '0'));
    const scaling = Number(oracleSettings?.maxFeeBasedScaling ?? 1);
    const withBeacons = Boolean(oracleSettings?.withBeacons);

    const [oracles, start] = await Promise.all([this.getAllOracles(), this._startScore()]);
    const K = juryK(jury);
    // Beacon quorum (JuryBeacons.quorum) and whether a draw walks the whole class list.
    let beaconQuorum = null;
    let scansAll = null;
    if (withBeacons) {
      try {
        const addr = await this._withRetry(() => this.aggregator.beacons(), 'beacons');
        if (addr && addr !== ethers.ZeroAddress) {
          beaconQuorum = Number(await this._withRetry(() => new ethers.Contract(addr, BEACONS_ABI, this.provider).quorum(), 'quorum'));
        }
      } catch (_) { /* unknown */ }
      try {
        const keeper = await this.getReputationKeeper();
        scansAll = Boolean(await this._withRetry(() => keeper.scansAll(cls), 'scansAll'));
      } catch (_) { /* unknown */ }
    }
    const drawSize = K;

    const now = Math.floor(Date.now() / 1000);
    const inClass = oracles.filter(o => !o.error && Array.isArray(o.classes) && o.classes.includes(cls));
    const feeWei = (o) => {
      try { return ethers.parseEther(String(o.fee)); } catch { return null; }
    };
    const selectable = inClass.filter(o => ['active', 'new'].includes(arbiterStatus(o, { now, start })));
    const eligible = selectable.filter(o => {
      const f = feeWei(o);
      return f != null && f <= maxFeeWei;
    });
    const pricedOut = selectable.length - eligible.length;
    const frozen = inClass.filter(o => arbiterStatus(o, { now, start }) === 'frozen').length;
    // distinct keys: with fewer than K the keeper repeats arbiters, so only none is unservable
    const eligibleCount = new Set(eligible.map(o => o.key)).size;
    const juryServable = eligibleCount > 0;
    const juryDistinct = eligibleCount >= K;
    const beaconsServable = !withBeacons || (beaconQuorum != null ? selectable.length >= beaconQuorum : null);

    // Owner concentration among the eligible pool.
    const ownerMap = await this.getOwnerMap(eligible.map(o => o.oracle));
    const ownerCounts = {};
    for (const o of eligible) {
      const owner = ownerMap[String(o.oracle).toLowerCase()] || `unknown:${String(o.oracle).toLowerCase()}`;
      ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;
    }
    const distinctOwnersEligible = Object.keys(ownerCounts).length;
    let dominantOwner = null;
    let dominantOwnerCount = 0;
    for (const [owner, n] of Object.entries(ownerCounts)) {
      if (n > dominantOwnerCount) { dominantOwner = owner; dominantOwnerCount = n; }
    }

    const priceBoostEnabled = baseCostWei > 0n || scaling > 1;
    const alphaExtreme = alpha <= 100 || alpha >= 900;

    const warnings = [];
    if (inClass.length === 0) {
      warnings.push(`No arbiters are registered for class ${cls}. Evaluations for this bounty cannot be drawn until at least ${K} join the class.`);
    } else if (!juryServable) {
      warnings.push(`No arbiter in class ${cls} is selectable and priced at or below this bounty's fee ceiling (${ethers.formatEther(maxFeeWei)} ETH). Every draw would fail (EvaluationFailed in the draw phase; the prepay is refunded) until one joins, unfreezes, or the ceiling is raised.`);
    } else if (!juryDistinct) {
      warnings.push(`Only ${eligibleCount} distinct arbiter(s) in class ${cls} are selectable and priced at or below this bounty's fee ceiling (${ethers.formatEther(maxFeeWei)} ETH), but this jury draws ${K}. The draw repeats arbiters to fill its ${K} slots, so the jury holds only ${eligibleCount} independent arbiter(s).`);
    }
    if (withBeacons) {
      if (beaconQuorum == null) {
        warnings.push(`This bounty uses beacons, but the beacon quorum could not be read; the beacon stage needs that many selectable arbiters in class ${cls} (any fee).`);
      } else if (!beaconsServable) {
        warnings.push(`This bounty uses beacons: the beacon stage needs ${beaconQuorum} selectable arbiter(s) in class ${cls} (beacons have no fee cap), but only ${selectable.length} are. The draw would fail at the beacon stage (pool shortage; the prepay is refunded).`);
      }
      if (scansAll === false) {
        warnings.push(`Class ${cls} is longer than one selection walk covers, so how many eligible arbiters a draw finds depends on the seed. After a beacon stage a draw that finds none sends the unspent prepay to the arbiter pool, not back to the requester.`);
      }
    }
    if (pricedOut > 0) {
      warnings.push(`${pricedOut} selectable arbiter(s) in class ${cls} charge more than this bounty's fee ceiling (${ethers.formatEther(maxFeeWei)} ETH) and will not be drawn.`);
    }
    if (frozen > 0) {
      warnings.push(`${frozen} arbiter(s) in class ${cls} are frozen (an unanswered health call) and are not drawn until they answer.`);
    }
    if (eligible.length > 0 && dominantOwnerCount * 2 >= eligible.length) {
      const label = dominantOwner && !dominantOwner.startsWith('unknown:')
        ? `${dominantOwner.slice(0, 6)}…${dominantOwner.slice(-4)}`
        : 'one operator';
      warnings.push(`${label} controls ${dominantOwnerCount} of the ${eligible.length} eligible arbiter(s) — at least half the pool. A single party could dominate the jury.`);
    }
    if (priceBoostEnabled) {
      warnings.push(`Price boost is enabled (estimatedBaseCost ${ethers.formatEther(baseCostWei)} ETH, up to ${scaling}x). Cheaper arbiters are favoured in selection, which trades reputation for cost${minFeeWei > 0n ? ' (fees below the floor score as the floor)' : ''}.`);
    }
    if (alphaExtreme) {
      warnings.push(alpha <= 100
        ? `alpha is ${alpha}: selection is weighted almost entirely on quality score, ignoring timeliness.`
        : `alpha is ${alpha}: selection is weighted almost entirely on timeliness, ignoring quality score.`);
    }

    return {
      available: true,
      classId: cls,
      jury: jury && typeof jury === 'object' ? jury : null,
      oracleSettings: {
        maxOracleFee: maxFeeWei.toString(),
        maxOracleFeeEth: ethers.formatEther(maxFeeWei),
        minOracleFee: minFeeWei.toString(),
        minOracleFeeEth: ethers.formatEther(minFeeWei),
        alpha,
        estimatedBaseCost: baseCostWei.toString(),
        maxFeeBasedScaling: scaling,
        withBeacons
      },
      totalInClass: inClass.length,
      activeInClass: selectable.length,
      frozenInClass: frozen,
      eligibleCount,
      juryServable,
      juryDistinct,
      beaconQuorum,
      beaconsServable,
      scansAll,
      pricedOutCount: pricedOut,
      distinctOwnersEligible,
      dominantOwner: dominantOwner && !dominantOwner.startsWith('unknown:') ? dominantOwner : null,
      dominantOwnerCount,
      oraclesToPoll: K,
      drawSize,
      priceBoostEnabled,
      alphaExtreme,
      eligibleArbiters: eligible.map(o => ({
        oracle: o.oracle,
        key: o.key,
        owner: ownerMap[String(o.oracle).toLowerCase()] || null,
        fee: o.fee,
        qualityScore: o.qualityScore,
        timelinessScore: o.timelinessScore,
        offenses: o.offenses
      })),
      warnings,
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * Arbiter availability per class (status counts, average scores, operators).
   */
  async getArbiterAvailabilityByClass() {
    const [oracles, start] = await Promise.all([this.getAllOracles(), this._startScore()]);
    const byClass = {};
    const now = Math.floor(Date.now() / 1000);

    for (const oracle of oracles) {
      if (oracle.error) continue;
      const status = arbiterStatus(oracle, { now, start });

      for (const classId of oracle.classes) {
        if (!byClass[classId]) {
          byClass[classId] = {
            classId,
            active: 0,
            new: 0,
            blocked: 0,
            inactive: 0,
            frozen: 0,
            // v1 name kept for older clients: a frozen arbiter is the v2 "unresponsive"
            unresponsive: 0,
            total: 0,
            avgQualityScore: 0,
            avgTimelinessScore: 0,
            qualityScores: [],
            timelinessScores: [],
            operatorAddresses: new Set(),
            arbiterList: []
          };
        }
        const c = byClass[classId];
        c.total++;
        if (oracle.oracle) {
          c.operatorAddresses.add(oracle.oracle.toLowerCase());
          c.arbiterList.push({
            address: oracle.oracle,
            key: oracle.key,
            jobId: oracle.jobId,
            classes: oracle.classes || [classId],
            qualityScore: oracle.qualityScore,
            timelinessScore: oracle.timelinessScore,
            offenses: oracle.offenses,
            fee: oracle.fee,
            stakeAmount: oracle.stakeAmount,
            status
          });
        }
        c[status]++;
        if (status === 'frozen') c.unresponsive++;
        c.qualityScores.push(oracle.qualityScore);
        c.timelinessScores.push(oracle.timelinessScore);
      }
    }

    for (const classId of Object.keys(byClass)) {
      const cls = byClass[classId];
      if (cls.qualityScores.length > 0) {
        cls.avgQualityScore = Math.round(cls.qualityScores.reduce((a, b) => a + b, 0) / cls.qualityScores.length);
        cls.avgTimelinessScore = Math.round(cls.timelinessScores.reduce((a, b) => a + b, 0) / cls.timelinessScores.length);
      }
      cls.operators = cls.operatorAddresses.size;
      cls.operatorList = Array.from(cls.operatorAddresses);
      delete cls.qualityScores;
      delete cls.timelinessScores;
      delete cls.operatorAddresses;
    }

    return {
      byClass,
      totalOracles: oracles.filter(o => !o.error).length,
      timestamp: Date.now()
    };
  }

  /**
   * One round's history: its phase and timing (getRoundInfo), each juror's slot (getSlot) and the
   * round's events. Round ids are sequential per aggregator; this reads the escrow's aggregator
   * (`where.aggregator`, when given, must be it). The round's jury (K, M, N, P, timeout) is its own,
   * from getJury.
   *
   * @param {string} aggId  bytes32
   * @param {{aggregator?: string}} [where]
   */
  async getAggHistory(aggId, where = {}) {
    const agg = this.aggregator;
    const aggAddress = await agg.getAddress();
    if (where.aggregator && String(where.aggregator).toLowerCase() !== String(aggAddress).toLowerCase()) {
      throw new Error(`not the escrow's aggregator: ${where.aggregator}`);
    }
    const currentBlock = await this.provider.getBlockNumber();

    const info = await this._withRetry(() => agg.getRoundInfo(aggId), 'getRoundInfo');
    const phase = Number(info.phase);
    if (phase === 0) {
      return { found: false, aggId, aggregator: aggAddress, message: 'No round found on-chain for this ID on this aggregator' };
    }
    const [K, M, N, P, timeout] = (await this._withRetry(() => agg.getJury(aggId), 'getJury')).map(Number);
    const contractParams = { K, M, N, P, timeout };
    const aggregationStatus = {
      phase,
      phaseName: PHASES[phase] || 'unknown',
      requestBlock: Number(info.requestBlock),
      sealed: info.sealedHash !== ethers.ZeroHash,
      closeBlock: Number(info.closeBlock) || null,
      commitCount: Number(info.commits),
      deadline: Number(info.deadline) || null,
      windowEnd: Number(info.windowEnd) || null,
      requestTime: Number(info.requestTime),
      // an undrawn round can be drawn until then; after it only cancelUnsealed (to the arbiter pool)
      drawExpiresAt: Number(info.requestTime) ? Number(info.requestTime) + DRAW_GRACE_SECONDS : null,
      receivedWei: info.received.toString(),
      baseFeesWei: info.baseFees.toString(),
      bonusesWei: info.bonuses.toString(),
      rewardsWei: info.rewards.toString()
    };

    // Jurors: one slot per drawn arbiter (none before the draw). A skipped slot (SlotSkipped
    // reason 1 or 2) has its oracle, key and fee set but no flags: it was never dispatched or paid.
    const slots = [];
    if (phase >= 3 && phase !== 9) {
      for (let i = 0; i < K; i++) {
        const s = await this._withRetry(() => agg.getSlot(aggId, i), `getSlot ${i}`);
        if (s.oracle === ethers.ZeroAddress) break;
        const f = Number(s.flags);
        slots.push({
          slot: i,
          oracle: s.oracle,
          key: s.key,
          payee: s.payee && s.payee !== ethers.ZeroAddress ? s.payee : null,
          dispatched: (f & S_DISPATCHED) !== 0,
          committed: (f & S_COMMITTED) !== 0,
          revealRequested: (f & S_PROMOTED) !== 0,
          revealOK: (f & S_REVEALED) !== 0,
          counted: (f & S_COUNTED) !== 0,
          quality: QCODES[Number(s.qcode) & 0x0f] || null,
          committedAt: Number(s.committedAt) || null,
          feeWei: s.fee.toString()
        });
      }
    }

    // Events, for timing and money: from the request block, a bounded window.
    const fromBlock = aggregationStatus.requestBlock;
    const toBlock = Math.min(currentBlock, fromBlock + EVENT_WINDOW);
    const names = ['RequestAIEvaluation', 'JuryDrawn', 'CommitReceived', 'CommitWindowClosed', 'CommitPhaseComplete',
      'RevealReceived', 'FulfillAIEvaluation', 'EvaluationFailed', 'RoundSettled', 'RoundCancelled',
      'BeaconStageStarted', 'BeaconPayment', 'BasePayment', 'BonusPayment', 'RequesterRefunded', 'SlotSkipped',
      'CommitPayment', 'PoolPayment'];
    const byName = {};
    await Promise.all(names.map(async (name) => {
      let ev;
      try { ev = agg.interface.getEvent(name); } catch { ev = null; }
      if (!ev) { byName[name] = []; return; }
      byName[name] = (await this._getLogsChunked(aggAddress, [ev.topicHash, aggId], fromBlock, toBlock))
        .map((log) => ({ log, args: agg.interface.parseLog(log).args }));
    }));
    const first = (name) => byName[name][0] || null;
    const requestEvent = first('RequestAIEvaluation')
      ? { block: first('RequestAIEvaluation').log.blockNumber, txHash: first('RequestAIEvaluation').log.transactionHash,
          cids: first('RequestAIEvaluation').args.cids }
      : null;
    const drawEvent = first('JuryDrawn')
      ? { block: first('JuryDrawn').log.blockNumber, txHash: first('JuryDrawn').log.transactionHash,
          drawer: first('JuryDrawn').args.drawer, rewardWei: first('JuryDrawn').args.reward.toString() }
      : null;
    let fulfillment = null;
    if (first('FulfillAIEvaluation')) {
      const e = first('FulfillAIEvaluation');
      const aggregated = e.args.aggregated.map(Number);
      fulfillment = {
        aggregated,
        likelihoods: aggregated,                       // v1 name, kept for older clients
        justifications: e.args.justifications,
        justificationCID: e.args.justifications,       // v1 name
        block: e.log.blockNumber,
        txHash: e.log.transactionHash
      };
    }
    const failure = first('EvaluationFailed')
      ? { phase: Number(first('EvaluationFailed').args.phase), phaseName: PHASES[Number(first('EvaluationFailed').args.phase)],
          moneyRule: FAIL_MONEY[Number(first('EvaluationFailed').args.phase)] || null,
          block: first('EvaluationFailed').log.blockNumber, txHash: first('EvaluationFailed').log.transactionHash }
      : null;
    const bySlot = (name) => {
      const m = {};
      for (const e of byName[name]) m[Number(e.args.pollIndex)] = e;
      return m;
    };
    const commits = bySlot('CommitReceived');
    const reveals = bySlot('RevealReceived');
    const basePaid = bySlot('BasePayment');
    const bonusPaid = bySlot('BonusPayment');
    // SlotSkipped: reasons per slot; reason 4 (keeper call at settlement) names no slot.
    const skips = {};
    let keeperCallReverted = false;
    for (const e of byName.SlotSkipped) {
      const reason = Number(e.args.reason);
      if (reason === 4) { keeperCallReverted = true; continue; }
      const i = Number(e.args.pollIndex);
      (skips[i] = skips[i] || []).push(reason);
    }
    const promoteEvent = first('CommitPhaseComplete');

    const blockTimestamps = await this._getBlockTimestamps([
      requestEvent?.block, drawEvent?.block, fulfillment?.block, failure?.block, promoteEvent?.log.blockNumber,
      first('CommitWindowClosed')?.log.blockNumber,
      ...Object.values(commits).map(e => e.log.blockNumber), ...Object.values(reveals).map(e => e.log.blockNumber)
    ]);
    const at = (e) => e ? { block: e.log.blockNumber, timestamp: blockTimestamps[e.log.blockNumber] ?? null, txHash: e.log.transactionHash } : null;
    if (requestEvent) requestEvent.timestamp = blockTimestamps[requestEvent.block] ?? null;
    if (drawEvent) drawEvent.timestamp = blockTimestamps[drawEvent.block] ?? null;
    if (fulfillment) fulfillment.timestamp = blockTimestamps[fulfillment.block] ?? null;
    if (failure) failure.timestamp = blockTimestamps[failure.block] ?? null;
    // Offsets are measured from the draw: the round's deadline and T+ run from it.
    const drawTs = drawEvent?.timestamp ?? null;
    const sinceDraw = (t) => (t != null && drawTs != null ? t - drawTs : null);
    for (const s of slots) {
      const rv = reveals[s.slot];
      // A late reveal (after the N-th finalized the round) is scored by its quality code, not counted.
      s.late = rv ? Boolean(rv.args.late) : false;
      if (s.late && rv.args.qcode != null) s.quality = QCODES[Number(rv.args.qcode) & 0x0f] || s.quality;
      s.timing = { commit: at(commits[s.slot]), reveal: at(rv) };
      s.timing.commitSinceDraw = sinceDraw(s.timing.commit?.timestamp ?? s.committedAt);
      s.timing.revealSinceDraw = sinceDraw(s.timing.reveal?.timestamp ?? null);
      s.skipReasons = (skips[s.slot] || []).map((r) => ({ reason: r, text: SKIP_REASONS[r] }));
      s.skipped = !s.dispatched;
      s.basePaidWei = basePaid[s.slot] ? basePaid[s.slot].args.amount.toString() : null;
      s.bonusPaidWei = bonusPaid[s.slot] ? bonusPaid[s.slot].args.amount.toString() : null;
      // the cluster is known only from bonuses (none are paid when fees are zero)
      s.inCluster = byName.BonusPayment.length ? Boolean(bonusPaid[s.slot]) : null;
    }

    // Money: refunded vs to the arbiter pool (RequesterRefunded to address(0), RoundCancelled), the
    // committers' shares of a never-promoted round (CommitPayment), the reward split, beacons, and the
    // arbiter pool's payout at this round's draw (PoolPayment: to a random registered arbiter, not
    // out of this round's prepay).
    const isPool = (a) => String(a).toLowerCase() === ethers.ZeroAddress;
    const refunds = byName.RequesterRefunded.map((e) => ({
      to: e.args.requester,
      amountWei: e.args.amount.toString(),
      toPool: isPool(e.args.requester),
      block: e.log.blockNumber,
      txHash: e.log.transactionHash
    }));
    const cancelled = first('RoundCancelled')
      ? { toPoolWei: first('RoundCancelled').args[1].toString(), block: first('RoundCancelled').log.blockNumber,
          txHash: first('RoundCancelled').log.transactionHash }
      : null;
    const beaconPayments = byName.BeaconPayment.map((e) => ({ payee: e.args.payee, amountWei: e.args.amount.toString() }));
    const commitPayments = byName.CommitPayment.map((e) => ({ payee: e.args.payee, amountWei: e.args.amount.toString() }));
    const poolPayment = first('PoolPayment')
      ? { payee: first('PoolPayment').args.payee, amountWei: first('PoolPayment').args.amount.toString(),
          block: first('PoolPayment').log.blockNumber, txHash: first('PoolPayment').log.transactionHash }
      : null;
    const sumWei = (xs) => xs.reduce((a, x) => a + BigInt(x), 0n);
    const drawRewardWei = drawEvent ? BigInt(drawEvent.rewardWei) : 0n;
    const beaconWei = sumWei(beaconPayments.map((b) => b.amountWei));
    const committersWei = sumWei(commitPayments.map((c) => c.amountWei));
    const rewardsWei = BigInt(aggregationStatus.rewardsWei);
    // promote() emits no reward event: its reward (effMaxFee x promoteRewardFees) is what
    // getRoundInfo.rewards holds beyond the draw reward, the beacon payments and the committers' shares.
    const otherRewardsWei = drawRewardWei + beaconWei + committersWei;
    const promoteRewardWei = promoteEvent && rewardsWei > otherRewardsWei ? rewardsWei - otherRewardsWei : 0n;
    let promoter = null;
    if (promoteEvent) {
      try {
        const tx = await this._withRetry(() => this.provider.getTransaction(promoteEvent.log.transactionHash), 'promote tx', 2);
        promoter = tx?.from || null;
      } catch { promoter = null; }
    }
    const refundedWei = sumWei(refunds.filter((r) => !r.toPool).map((r) => r.amountWei));
    const toPoolWei = sumWei(refunds.filter((r) => r.toPool).map((r) => r.amountWei)) +
      (cancelled ? BigInt(cancelled.toPoolWei) : 0n);
    const money = {
      receivedWei: aggregationStatus.receivedWei,
      baseFeesWei: aggregationStatus.baseFeesWei,
      bonusesWei: aggregationStatus.bonusesWei,
      rewardsWei: aggregationStatus.rewardsWei,
      rewards: {
        drawWei: drawRewardWei.toString(),
        drawer: drawEvent?.drawer || null,
        promoteWei: promoteRewardWei.toString(),
        promoter,
        promoteMethod: 'getRoundInfo.rewards - JuryDrawn.reward - BeaconPayment total - CommitPayment total (promote emits no reward event); the promoter is the CommitPhaseComplete transaction sender',
        beaconsWei: beaconWei.toString(),
        committersWei: committersWei.toString()
      },
      beacons: first('BeaconStageStarted')
        ? { stageStarted: true, picked: Number(first('BeaconStageStarted').args.beacons), payments: beaconPayments,
            block: first('BeaconStageStarted').log.blockNumber }
        : (beaconPayments.length ? { stageStarted: true, picked: null, payments: beaconPayments } : null),
      refunds,
      cancelled,
      commitPayments,
      poolPayment,
      refundedWei: refundedWei.toString(),
      toPoolWei: toPoolWei.toString(),
      toCommittersWei: committersWei.toString(),
      keeperCallReverted
    };
    const promotion = promoteEvent
      ? { ...at(promoteEvent), promoted: Number(promoteEvent.args.promoted), promoter,
          sinceDraw: sinceDraw(blockTimestamps[promoteEvent.log.blockNumber] ?? null) }
      : null;
    const windowClosed = first('CommitWindowClosed')
      ? { ...at(first('CommitWindowClosed')), sinceDraw: sinceDraw(blockTimestamps[first('CommitWindowClosed').log.blockNumber] ?? null) }
      : null;

    const dispatched = slots.filter(s => s.dispatched);
    const committed = slots.filter(s => s.committed).length;
    const revealed = slots.filter(s => s.revealOK).length;
    const nowSec = Math.floor(Date.now() / 1000);
    // Malformed: jurors were actually asked (dispatched slots exist) and none committed. Skipped
    // slots were never asked, so they say nothing about the package.
    const malformed = dispatched.length > 0 && committed === 0;
    const drawExpired = (phase === 1 || phase === 2) && aggregationStatus.requestTime > 0 &&
      nowSec > aggregationStatus.requestTime + DRAW_GRACE_SECONDS;
    let outcome;
    if (phase === 6 || phase === 7) outcome = 'COMPLETED';
    else if (phase === 9) outcome = 'CANCELLED (never drawn; prepay to the arbiter pool)';
    else if (phase === 8) {
      if (malformed) outcome = LIKELY_MALFORMED_OUTCOME;
      else outcome = `FAILED (${failure ? failure.phaseName : 'unknown'} phase)`;
    } else if (drawExpired) {
      outcome = 'DRAW EXPIRED: can only be cancelled (prepay to the arbiter pool)';
    } else if (phase >= 3 && aggregationStatus.deadline && nowSec > aggregationStatus.deadline) {
      // past its deadline, not yet settled
      outcome = malformed ? LIKELY_MALFORMED_OUTCOME : `FAILED (${PHASES[phase]} phase, not yet settled)`;
    } else {
      outcome = `IN PROCESS (${PHASES[phase]} phase)`;
    }

    const analysis = {
      totalSlots: slots.length,
      dispatched: dispatched.length,
      skipped: slots.filter(s => s.skipped).length,
      skippedSlotIds: slots.filter(s => s.skipped).map(s => s.slot),
      committed,
      promoted: slots.filter(s => s.revealRequested).length,
      revealed,
      counted: slots.filter(s => s.counted).length,
      late: slots.filter(s => s.late).length,
      nonResponding: dispatched.filter(s => !s.committed).length,
      nonRespondingSlotIds: dispatched.filter(s => !s.committed).map(s => s.slot),
      promotedNotRevealed: slots.filter(s => s.revealRequested && !s.revealOK).map(s => s.slot),
      likelyMalformed: outcome === LIKELY_MALFORMED_OUTCOME,
      drawExpired,
      clusterKnown: byName.BonusPayment.length > 0,
      uniqueOracles: new Set(slots.map(s => s.oracle)).size,
      quality: {
        close: slots.filter(s => s.quality === 'close').length,
        off: slots.filter(s => s.quality === 'off').length,
        far: slots.filter(s => s.quality === 'far').length
      }
    };

    return {
      found: true,
      aggId,
      aggregator: aggAddress,
      contractParams,
      aggregationStatus,
      requestEvent,
      drawEvent,
      windowClosed,
      promotion,
      slots,
      fulfillment,
      failure,
      money,
      outcome,
      analysis
    };
  }

  /**
   * Check the service is configured: the aggregator, its keeper and its token.
   */
  async healthCheck() {
    try {
      const keeper = await this.getReputationKeeper();
      const config = await this.getAggregatorConfig();
      let wvdkaAddress = null;
      try {
        wvdkaAddress = await keeper.verdiktaToken();
      } catch (err) {
        logger.debug('Could not get wVDKA token address', { msg: err.message });
      }
      return {
        healthy: true,
        aggregatorAddress: this.aggregatorAddress,
        keeperAddress: this.keeperAddress,
        wvdkaAddress,
        config
      };
    } catch (error) {
      return {
        healthy: false,
        aggregatorAddress: this.aggregatorAddress,
        error: error.message
      };
    }
  }
}

// Singleton instance
let verdiktaService = null;

/**
 * @param {string} providerUrl
 * @param {string} aggregator  the escrow's aggregator (serves every jury)
 * @param {number} deployBlock
 */
function initializeVerdiktaService(providerUrl, aggregator, deployBlock = 0) {
  if (!aggregator) {
    logger.warn('Verdikta service not initialized: no aggregator address');
    return null;
  }
  verdiktaService = new VerdiktaService(providerUrl, aggregator, deployBlock);
  logger.info('Verdikta service initialized', { aggregator });
  return verdiktaService;
}

function getVerdiktaService() {
  return verdiktaService; // Can be null if not configured
}

function isVerdiktaServiceAvailable() {
  return verdiktaService !== null;
}

module.exports = {
  initializeVerdiktaService,
  getVerdiktaService,
  isVerdiktaServiceAvailable,
  VerdiktaService,
  LIKELY_MALFORMED_OUTCOME,
  SKIP_REASONS,
  FAIL_MONEY,
  arbiterStatus
};
