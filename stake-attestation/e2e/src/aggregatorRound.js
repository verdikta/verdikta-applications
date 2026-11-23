// What the real v2 aggregator does with one round's oracle answers, off-chain: a port of the v2
// ReputationAggregator's fulfill, closeCommits, promote and _finalize, and of ScoringLib and
// AggregatorLib.parseCidSalt (verdikta-dispatcher, `beacon` branch, reputationBasedAggregator/contracts;
// test/fixtures/scoring-lib.vectors.json holds the real libraries' answers, and
// test/fixtures/gen-scoring-vectors.cjs regenerates them). The poll-only mock takes the finished
// result; this decides what that result is, by the real rules, from what the real External Adapter
// answered. It holds no chain state and makes no call, so a test can feed it anything.
//
// A round on v2, as a requester sees it: the request escrows; drawJury (from block B+2) draws K
// jurors and sends each the commit request ("1:<cids>[:<addendum>]"); a commit is one number, the
// keccak256 commitment, with no CID; the window closes at the M+-th commit (M+ = M + ceil((K - M) / 2)),
// or by closeCommits once T+ has passed with at least M; promote (from the close block + 2) draws M of
// the commits with the seed keccak256(aggId, "promote", blockhash(C + 1)) and sends each the reveal
// request "2:<64 hex commitment>"; a reveal always has a CID ("<cid>:<32 hex salt>"), so a one-number
// reveal is never taken for a commit; the N-th counted reveal finalizes. Nothing here reverts: the
// real fulfill returns early on anything it does not take (v2 has no reveal diagnostics).
import { AbiCoder, keccak256, solidityPacked } from 'ethers';

/** The real contract's defaults (its declarations: K, M, N, P = 6, 5, 4, 3; B = 3) and limits. */
export const REAL_CONFIG = Object.freeze({
  k: 6, // K: jurors drawn, each sent the commit request
  m: 5, // M: commits promoted to reveal (and the least that may be closed after T+)
  n: 4, // N: counted reveals; the N-th finalizes
  p: 3, // P: the cluster that is averaged and earns the bonus
  bonus: 3, // bonusMultiplier
  drawFees: 2, // drawRewardFees: the drawer's reward, in fees of the clamped ceiling
  promoteFees: 1, // promoteRewardFees: promote()'s caller's reward
  responseTimeoutSeconds: 300, // the round's deadline, from the draw
  tPlus: 155, // the commit window's T+, from the draw
  revealWindow: 120, // reveal time guaranteed after promote()
  requesterDrawPriority: 30, // seconds in which only the requester earns the draw reward
  spreadFloor: 30000n,
  maxLikelihoodLength: 20,
  maxRevealCidLength: 133, // MAX_CID_LENGTH + 33: ":" and the 32-hex salt
  maxScore: 10n ** 34n, // MAX_SCORE
});

/** M+ = M + ceil((K - M) / 2): the commit that closes the window early. */
export const mPlusOf = (config = REAL_CONFIG) => config.m + Math.floor((config.k - config.m + 1) / 2);

const coder = AbiCoder.defaultAbiCoder();
const hex64 = (h) => BigInt(h).toString(16).padStart(64, '0');

/** keccak256(abi.encode(bytes32 aggId, address operator, uint256[] response, uint256 salt)), 64 lowercase hex: the v2 commitment. */
export function commitmentOf(aggId, operator, response, salt) {
  return keccak256(coder.encode(['bytes32', 'address', 'uint256[]', 'uint256'], [aggId, operator, response, salt])).slice(2);
}

/** A commit's number as the aggregator reads it (bytes32(response[0]), all 32 bytes), or null for the zero hash. */
export function commitHashOf(response0) {
  const h = BigInt(response0);
  return h === 0n || h >= 1n << 256n ? null : hex64(h);
}

/** AggregatorLib.parseCidSalt: { cid, salt } for "<cid>:<32 hex>" with a CID of at least one character, else null. */
export function parseCidSalt(packed) {
  if (typeof packed !== 'string') return null;
  const b = Buffer.from(packed, 'utf8');
  const n = b.length;
  if (n < 34 || b[n - 33] !== 0x3a) return null;
  const hex = b.subarray(n - 32).toString('latin1');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return { cid: b.subarray(0, n - 33).toString('utf8'), salt: BigInt(`0x${hex}`) };
}

const dist2 = (a, b) => a.reduce((s, x, i) => {
  const d = x > b[i] ? x - b[i] : b[i] - x;
  return s + d * d;
}, 0n);

/** ScoringLib.bestCluster: the cluster of P (2 at least, n at most) by the nearest-neighbour rule, or the exact 1-D window. */
export function bestCluster(v, P) {
  const n = v.length;
  if (n < 2) throw new Error('NeedTwo');
  let p = Math.min(P, n);
  if (p < 2) p = 2;
  const len = v[0].length;
  if (v.some((x) => x.length !== len)) throw new Error('LengthMismatch');
  const inCluster = new Array(n).fill(false);
  if (len === 1) {
    // sorted by value, ties to the earlier reveal; the first window of P with the least P*sum(x^2) - (sum x)^2
    const order = v.map((x, i) => [x[0], i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    let best = null;
    let start = 0;
    for (let s = 0; s + p <= n; s += 1) {
      let s1 = 0n;
      let s2 = 0n;
      for (let k = s; k < s + p; k += 1) {
        s1 += order[k][0];
        s2 += order[k][0] * order[k][0];
      }
      const score = BigInt(p) * s2 - s1 * s1;
      if (best === null || score < best) {
        best = score;
        start = s;
      }
    }
    for (let k = start; k < start + p; k += 1) inCluster[order[k][1]] = true;
    return inCluster;
  }
  const d = v.map((a) => v.map((b) => dist2(a, b)));
  let bestScore = null;
  let group = [];
  for (let c = 0; c < n; c += 1) {
    // the P nearest to c, c included (distance 0), ties to the earlier reveal
    const near = d[c].map((x, j) => [x, j]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).slice(0, p).map(([, j]) => j);
    let score = 0n;
    for (let x = 0; x < p; x += 1) for (let y = x + 1; y < p; y += 1) score += d[near[x]][near[y]];
    if (bestScore === null || score < bestScore) {
      bestScore = score;
      group = near;
    }
  }
  for (const j of group) inCluster[j] = true;
  return inCluster;
}

/** ScoringLib.tieOrder: positions sorted by the top 248 bits of keccak256(abi.encode(seed, ids[i])), then position. */
export function tieOrder(seed, ids) {
  const keyOf = (id) => BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [seed, id]))) >> 8n;
  return ids.map((id, i) => [keyOf(id), i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map(([, i]) => i);
}

/** ScoringLib._normalize: every vector at the most common length (ties to the LONGER), truncated or zero-filled. */
export function normalize(v) {
  if (v.length === 0 || v.every((x) => x.length === v[0].length)) return v;
  let modalLen = 0;
  let bestCount = 0;
  for (const x of v) {
    const c = v.filter((y) => y.length === x.length).length;
    if (c > bestCount || (c === bestCount && x.length > modalLen)) {
      bestCount = c;
      modalLen = x.length;
    }
  }
  return v.map((x) => Array.from({ length: modalLen }, (_, i) => (i < x.length ? x[i] : 0n)));
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const h = a.length >> 1;
  return a.length % 2 === 1 ? a[h] : (a[h - 1] + a[h]) / 2n;
};
const dev = (x, med) => med.reduce((m, mj, j) => {
  const xj = j < x.length ? x[j] : 0n;
  const dj = xj > mj ? xj - mj : mj - xj;
  return dj > m ? dj : m;
}, 0n);
const classOf = (distance, spread) => (distance * 2n <= spread * 3n ? 1 : distance <= spread * 3n ? 2 : 3);

/** ScoringLib.classifyOne: 1 close (d <= 1.5 spread), 2 off (d <= 3 spread), 3 far. */
export const classifyOne = (x, med, spread) => classOf(dev(x, med), BigInt(spread));

/** ScoringLib.classify: each vector's class against the coordinate-wise median and the floored robust spread. */
export function classify(v, floor) {
  const len = v[0].length;
  const med = Array.from({ length: len }, (_, j) => median(v.map((x) => x[j])));
  const dist = v.map((x) => dev(x, med));
  let spread = (median(dist) * 14826n) / 10000n;
  if (spread < BigInt(floor)) spread = BigInt(floor);
  return { codes: dist.map((x) => classOf(x, spread)), med, spread };
}

/** ScoringLib.aggregate: the cluster (ties by the seeded order), its floored coordinate-wise mean, and the classes. */
export function aggregate(vectors, P, floor, seed, ids) {
  const v = normalize(vectors);
  const n = v.length;
  const inCl = new Array(n).fill(false);
  if (n >= 2) {
    const perm = tieOrder(seed, ids);
    const c = bestCluster(perm.map((i) => v[i]), P);
    c.forEach((x, i) => { if (x) inCl[perm[i]] = true; });
  } else if (n === 1) {
    inCl[0] = true;
  }
  const len = n > 0 ? v[0].length : 0;
  const agg = new Array(len).fill(0n);
  let cnt = 0n;
  v.forEach((x, i) => {
    if (!inCl[i]) return;
    cnt += 1n;
    x.forEach((y, j) => { agg[j] += y; });
  });
  const mean = cnt > 0n ? agg.map((y) => y / cnt) : agg;
  return { inCl, agg: mean, ...classify(v, floor) };
}

/** ScoringLib.pickPromoted: M of the committed slots, a partial Fisher-Yates on keccak256(abi.encodePacked(seed, j)). */
export function pickPromoted(committed, m, seed) {
  const pool = [];
  committed.forEach((c, i) => { if (c) pool.push(i); });
  const n = pool.length;
  const chosen = [];
  for (let j = 0; j < m; j += 1) {
    const pick = j + Number(BigInt(keccak256(solidityPacked(['bytes32', 'uint256'], [seed, j]))) % BigInt(n - j));
    [pool[j], pool[pick]] = [pool[pick], pool[j]];
    chosen.push(pool[j]);
  }
  return chosen;
}

/** promote()'s seed: keccak256(abi.encodePacked(aggId, "promote", blockhash(C + 1))). */
export const promoteSeedOf = (aggId, blockHash) => keccak256(solidityPacked(['bytes32', 'string', 'bytes32'], [aggId, 'promote', blockHash]));

/**
 * One round, as the real contract keeps it once drawn. fulfill() answers what the real fulfill does:
 *   { kind: 'ignored', reason }     an early return: nothing recorded
 *   { kind: 'commit' }              a commit recorded
 *   { kind: 'closed' }              the M+-th commit, or the M-th or later after T+: the window closed
 *                                   (promote is due from block C + 2)
 *   { kind: 'reveal' }              a counted reveal
 *   { kind: 'finalized', likelihoods, justifications, clustered }   the N-th counted reveal
 *   { kind: 'late', qcode }         a promoted slot's reveal after finalization: classified, not counted
 * close() is closeCommits (after T+, with at least M commits), promote(seed) the promotion draw, which
 * names the reveal requests to send.
 */
export class AggregatorRound {
  /**
   * @param {object} o
   * @param {string} o.aggId - bytes32
   * @param {(slot: number) => string} o.operatorOf - the operator address of a slot
   * @param {bigint} o.fee - what each juror is paid: max(its posted fee, the floor); the bonus scales off it
   * @param {string} [o.sealedHash] - the round's sealed seed (getRoundInfo), which breaks cluster ties
   * @param {object} [o.config] - REAL_CONFIG by default
   */
  constructor({ aggId, operatorOf, fee, sealedHash = `0x${'00'.repeat(32)}`, config = REAL_CONFIG }) {
    this.aggId = aggId;
    this.config = config;
    this.operatorOf = operatorOf;
    this.fee = BigInt(fee);
    this.sealedHash = sealedHash;
    this.phase = 'commit'; // commit, closing, reveal, final
    this.commitHash = new Map(); // slot -> 64 hex
    this.promoted = new Set();
    this.revealed = new Set();
    this.responses = []; // counted reveals, in reveal order: { slot, likelihoods, cid }
    this.result = null;
    this.bonusCredited = 0n;
  }

  get isComplete() {
    return this.phase === 'final';
  }

  /** maxTotalFee(maxFee, minFee, withBeacons) of the real contract: max(eff, minFee) x (K + B x P [+ quorum]) + eff x (draw + promote). */
  static required(effMaxFee, { minFee = 0n, beacons = 0, config = REAL_CONFIG } = {}) {
    const eff = BigInt(effMaxFee);
    const juror = BigInt(minFee) > eff ? BigInt(minFee) : eff;
    return juror * BigInt(config.k + config.bonus * config.p + beacons) + eff * BigInt(config.drawFees + config.promoteFees);
  }

  /** The base fees, credited at the draw to all K jurors. */
  get baseCredited() {
    return this.fee * BigInt(this.config.k);
  }

  /** The real refund's one expression: received - base - bonus - rewards (draw, promote, beacons), on every exit path. */
  refund(received, rewards = 0n) {
    return BigInt(received) - this.baseCredited - this.bonusCredited - BigInt(rewards);
  }

  /**
   * @param {object} [at] - the chain's clock at the answer: `late` past the round's deadline (the real fulfill
   *        returns at once), `pastWindow` past T+ (a commit that brings the count to M closes the window)
   */
  fulfill(slot, response, cid, { late = false, pastWindow = false } = {}) {
    if (late) return { kind: 'ignored', reason: 'past the deadline' };
    if (response.length === 1 && cid.length === 0) return this.#commit(slot, response[0], pastWindow);
    return this.#reveal(slot, response, cid);
  }

  #commit(slot, value, pastWindow) {
    const hash = commitHashOf(value);
    if (this.phase !== 'commit') return { kind: 'ignored', reason: 'commit after the window closed' };
    if (hash === null) return { kind: 'ignored', reason: 'zero commit' };
    if (this.commitHash.has(slot)) return { kind: 'ignored', reason: 'duplicate commit' };
    this.commitHash.set(slot, hash);
    if (this.commitHash.size >= mPlusOf(this.config) || (pastWindow && this.commitHash.size >= this.config.m)) {
      this.phase = 'closing';
      return { kind: 'closed' };
    }
    return { kind: 'commit' };
  }

  /** closeCommits, after T+: the window closes with at least M commits; null if it may not. */
  close() {
    if (this.phase !== 'commit' || this.commitHash.size < this.config.m) return null;
    this.phase = 'closing';
    return { kind: 'closed' };
  }

  /** promote(): M of the commits, drawn with `seed` (promoteSeedOf). The reveal requests, in draw order. */
  promote(seed) {
    if (this.phase !== 'closing') throw new Error('WrongPhase');
    const committed = Array.from({ length: this.config.k }, (_, s) => this.commitHash.has(s));
    const chosen = pickPromoted(committed, this.config.m, seed);
    this.phase = 'reveal';
    for (const s of chosen) this.promoted.add(s);
    return chosen.map((s) => ({ slot: s, cid: `2:${this.commitHash.get(s)}` }));
  }

  #reveal(slot, response, cid) {
    if (this.phase !== 'reveal' && this.phase !== 'final') return { kind: 'ignored', reason: 'not in the reveal phase' };
    if (!this.promoted.has(slot) || this.revealed.has(slot)) return { kind: 'ignored', reason: this.revealed.has(slot) ? 'duplicate reveal' : 'not promoted' };
    if (response.length === 0 || response.length > this.config.maxLikelihoodLength) return { kind: 'ignored', reason: 'bad length' };
    if (Buffer.byteLength(cid, 'utf8') > this.config.maxRevealCidLength) return { kind: 'ignored', reason: 'CID too long' };
    const parsed = parseCidSalt(cid);
    if (!parsed) return { kind: 'ignored', reason: 'bad CID and salt' };
    if (commitmentOf(this.aggId, this.operatorOf(slot), response, parsed.salt) !== this.commitHash.get(slot)) return { kind: 'ignored', reason: 'hash mismatch' };
    const likelihoods = response.map((v) => (v > this.config.maxScore ? this.config.maxScore : v));
    this.revealed.add(slot);
    if (this.phase === 'final') return { kind: 'late', qcode: classifyOne(likelihoods, this.result.median, this.result.spread) };
    this.responses.push({ slot, likelihoods, cid: parsed.cid });
    if (this.responses.length < this.config.n) return { kind: 'reveal' };
    return this.#finalize();
  }

  #finalize() {
    const { inCl, agg, med, spread } = aggregate(
      this.responses.map((r) => r.likelihoods), this.config.p, this.config.spreadFloor, this.sealedHash, this.responses.map((r) => r.slot),
    );
    const justifications = [];
    let clustered = 0;
    inCl.forEach((x, i) => {
      if (!x) return;
      clustered += 1;
      justifications.push(this.responses[i].cid);
      this.bonusCredited += this.fee * BigInt(this.config.bonus);
    });
    this.phase = 'final';
    this.result = { likelihoods: agg, justifications: justifications.join(','), clustered, median: med, spread };
    return { kind: 'finalized', likelihoods: agg, justifications: this.result.justifications, clustered };
  }
}
