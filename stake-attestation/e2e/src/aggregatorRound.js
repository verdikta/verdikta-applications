// What the real aggregator does with one round's oracle answers, off-chain: a port of
// ReputationAggregator.fulfill, _dispatchRevealRequests, _finalizeAggregation and the settlement
// arithmetic, and of AggregatorLib (verdikta-dispatcher, reputationBasedAggregator/contracts, at
// the commit in test/fixtures/aggregator-lib.vectors.json, whose answers came from the real
// library). The poll-only mock takes a finished result; this decides what that result is, by the
// real rules, from what the real External Adapter answered. It holds no chain state and makes no
// call, so a test can feed it anything.
import { AbiCoder, sha256 } from 'ethers';

/** The real contract's defaults (its constructor; K,M,N,P = 6,4,3,2, B = 3) and limits. */
export const REAL_CONFIG = Object.freeze({
  k: 6, // commitOraclesToPoll
  m: 4, // oraclesToPoll: the first M commits go on to reveal
  n: 3, // requiredResponses: the first N reveals are aggregated
  p: 2, // clusterSize
  bonus: 3, // bonusMultiplier
  maxLikelihoodLength: 20,
  maxRevealCidLength: 121, // MAX_CID_LENGTH + 21
  maxArbiterScore: 10n ** 34n, // MAX_ARBITER_RETURN_SCORE
});

const MASK_128 = (1n << 128n) - 1n;

/** bytes16(bytes32(response[0] << 128)) as AggregatorLib.bytes16ToHexLower writes it, or null for the zero hash. */
export function commitHashOf(response0) {
  const low = BigInt(response0) & MASK_128;
  return low === 0n ? null : low.toString(16).padStart(32, '0');
}

/** bytes16(sha256(abi.encode(operator, response, salt))), 32 lowercase hex. */
export function revealHashOf(operator, response, salt) {
  const encoded = AbiCoder.defaultAbiCoder().encode(['address', 'uint256[]', 'uint256'], [operator, response, salt]);
  return sha256(encoded).slice(2, 34);
}

/** AggregatorLib.isValidCidSalt and parseCidSaltUnchecked: { cid, salt } for "<cid>:<20 hex>", else null. */
export function parseCidSalt(packed) {
  if (typeof packed !== 'string' || packed.length <= 21) return null;
  const at = packed.lastIndexOf(':');
  if (at < 0 || packed.length - at - 1 !== 20) return null;
  const hex = packed.slice(at + 1);
  if (!/^[0-9a-fA-F]{20}$/.test(hex)) return null;
  return { cid: packed.slice(0, at), salt: BigInt(`0x${hex}`) };
}

/** AggregatorLib.normalizeToModal: every vector at the modal length, ties to the smaller; truncate or zero-fill. */
export function normalizeToModal(vectors) {
  let bestCount = 0;
  let modalLen = 0;
  for (const v of vectors) {
    const c = vectors.filter((w) => w.length === v.length).length;
    if (c > bestCount || (c === bestCount && v.length < modalLen)) {
      bestCount = c;
      modalLen = v.length;
    }
  }
  const normalized = vectors.map((v) => Array.from({ length: modalLen }, (_, i) => (i < v.length ? v[i] : 0n)));
  return { normalized, modalLen };
}

function distance(a, b) {
  let sum = 0n;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
    sum += diff * diff;
  }
  return sum;
}

/** AggregatorLib.findBestCluster: flags over `selected`: the closest pair, then greedy to P. */
export function findBestCluster(vectors, selected, clusterSize) {
  const count = selected.length;
  if (count < 2) throw new Error('NeedMoreResponses');
  const p = Math.min(clusterSize, count);
  let bestA = 0;
  let bestB = 0;
  let bestDist = null;
  for (let i = 0; i < count - 1; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const d = distance(vectors[selected[i]], vectors[selected[j]]);
      if (bestDist === null || d < bestDist) {
        bestDist = d;
        bestA = i;
        bestB = j;
      }
    }
  }
  const flags = new Array(count).fill(0);
  flags[bestA] = 1;
  flags[bestB] = 1;
  for (let size = 2; size < p; size += 1) {
    let bestCand = 0;
    let bestScore = null;
    for (let i = 0; i < count; i += 1) {
      if (flags[i] === 1) continue;
      let score = 0n;
      for (let k = 0; k < count; k += 1) if (flags[k] === 1) score += distance(vectors[selected[i]], vectors[selected[k]]);
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        bestCand = i;
      }
    }
    flags[bestCand] = 1;
  }
  return flags;
}

/**
 * One round, as the real contract keeps it. fulfill() answers what the real fulfill would do:
 *   { kind: 'reverted', reason }   the transaction reverts (nothing recorded)
 *   { kind: 'ignored', reason }    it succeeds and records nothing (the contract's early returns)
 *   { kind: 'commit' }             a commit recorded
 *   { kind: 'reveal-phase', reveals: [{ slot, cid }] }  the M-th commit: Mode-2 requests go out
 *   { kind: 'reveal' }             a reveal recorded
 *   { kind: 'finalized', likelihoods, justifications, clustered }  the N-th reveal
 */
export class AggregatorRound {
  /**
   * @param {object} o
   * @param {(slot: number) => string} o.operatorOf - the operator address of a poll slot
   * @param {bigint} o.fee - each polled oracle's registered fee, at most the clamped ceiling
   * @param {object} [o.config] - REAL_CONFIG by default
   */
  constructor({ operatorOf, fee, config = REAL_CONFIG }) {
    this.config = config;
    this.operatorOf = operatorOf;
    this.fee = BigInt(fee);
    this.commitHash = new Map(); // slot -> 32 hex
    this.commitPhaseComplete = false;
    this.responses = []; // { slot, likelihoods, cid, selected }
    this.isComplete = false;
    this.result = null;
    this.bonusCredited = 0n;
  }

  /** What the round's prepay must cover: maxTotalFee, effMaxFee * (K + B * P). */
  static required(effMaxFee, config = REAL_CONFIG) {
    return BigInt(effMaxFee) * BigInt(config.k + config.bonus * config.p);
  }

  /** The base fees credited at request time, to all K polled oracles. */
  get baseCredited() {
    return this.fee * BigInt(this.config.k);
  }

  /** ethReceived - baseCredited - bonusCredited, the real refund's one expression, on every exit path. */
  refund(ethReceived) {
    return BigInt(ethReceived) - this.baseCredited - this.bonusCredited;
  }

  fulfill(slot, response, cid) {
    if (this.isComplete) return { kind: 'reverted', reason: 'AggregationComplete' };
    const looksLikeCommit = response.length === 1 && cid.length === 0;
    const looksLikeReveal = response.length >= 2 && cid.length > 0;
    if (!looksLikeCommit && !looksLikeReveal) return { kind: 'reverted', reason: 'MalformedPayload' };
    return looksLikeCommit ? this.#commit(slot, response) : this.#reveal(slot, response, cid);
  }

  #commit(slot, response) {
    const hash = commitHashOf(response[0]);
    if (hash === null) return { kind: 'ignored', reason: 'zero commit' };
    if (this.commitPhaseComplete) return { kind: 'ignored', reason: 'commit after the reveal phase began' };
    if (this.commitHash.has(slot)) return { kind: 'ignored', reason: 'duplicate commit' };
    this.commitHash.set(slot, hash);
    if (this.commitHash.size < this.config.m) return { kind: 'commit' };
    this.commitPhaseComplete = true;
    const reveals = [...this.commitHash.entries()].sort((a, b) => a[0] - b[0]).map(([s, h]) => ({ slot: s, cid: `2:${h}` }));
    return { kind: 'reveal-phase', reveals };
  }

  #reveal(slot, response, cid) {
    if (!this.commitPhaseComplete) return { kind: 'reverted', reason: 'RevealBeforeCommit' };
    if (response.length > this.config.maxLikelihoodLength) return { kind: 'ignored', reason: 'RevealTooManyScores' };
    if (Buffer.byteLength(cid, 'utf8') > this.config.maxRevealCidLength) return { kind: 'ignored', reason: 'RevealCidTooLong' };
    if (this.responses.some((r) => r.slot === slot)) return { kind: 'ignored', reason: 'duplicate reveal' };
    const parsed = parseCidSalt(cid);
    if (!parsed) return { kind: 'ignored', reason: 'InvalidRevealFormat' };
    const recomputed = revealHashOf(this.operatorOf(slot), response, parsed.salt);
    if (recomputed !== this.commitHash.get(slot)) return { kind: 'ignored', reason: 'RevealHashMismatch' };
    const likelihoods = response.map((v) => (v > this.config.maxArbiterScore ? this.config.maxArbiterScore : v));
    this.responses.push({ slot, likelihoods, cid: parsed.cid, selected: this.responses.length < this.config.n });
    if (this.responses.length < this.config.n) return { kind: 'reveal' };
    return this.#finalize();
  }

  #finalize() {
    const selected = this.responses.map((r, i) => (r.selected ? i : -1)).filter((i) => i >= 0);
    const { normalized, modalLen } = normalizeToModal(this.responses.map((r) => r.likelihoods));
    const cluster = selected.length >= 2 ? findBestCluster(normalized, selected, this.config.p) : new Array(selected.length).fill(0);
    const sums = new Array(modalLen).fill(0n);
    let clusterCount = 0n;
    const justifications = [];
    selected.forEach((responseIndex, i) => {
      if (cluster[i] !== 1) return;
      normalized[responseIndex].forEach((v, j) => { sums[j] += v; });
      clusterCount += 1n;
      justifications.push(this.responses[responseIndex].cid);
      this.bonusCredited += this.fee * BigInt(this.config.bonus);
    });
    const likelihoods = clusterCount > 0n ? sums.map((v) => v / clusterCount) : sums;
    this.isComplete = true;
    this.result = { likelihoods, justifications: justifications.join(','), clustered: Number(clusterCount) };
    return { kind: 'finalized', ...this.result };
  }
}
