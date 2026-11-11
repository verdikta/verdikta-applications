// The Solidity settlement rule against @verdikta/common's settleBugOutcome (design §8.7,
// decisions 10 and 11; build plan erratum E4 for the 999,995-1,000,000 sum range): the same
// outcome, class and award on common's fixture vectors and on >= 1,000 random vectors weighted
// to the edges (exact threshold, ties, the flooring loss), and the same refusals (a vector common
// rejects is a failed round on-chain). The narrow INVALID too (erratum E8; common knows the floor
// since 1.9.0-attest.4): under the default floor and under three others, the same `narrow` and so
// the same bond. The rule runs through the lens's judgeVector, which compiles the same
// ClaimRules.judge and isNarrowInvalid that finalize and settle use; a sample also goes through
// finalize and settle end to end, under the default floor and common's lowest.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");
const { rng, split } = require("./helpers/random");

const { Outcome, ClaimState, SCALE, T, AWARDS, BOND, TOP, JUSTIFICATION } = H;
const { parseEther } = ethers;
const OUTCOMES = codeReview.BUG_OUTCOMES;
const MIN_SUM = SCALE - 5;

// common's fixture vectors: test/unit/codeReviewFixtures.test.js (the catalogue cases with a
// settleBugOutcome helper) and test/unit/codeReviewSettlement.test.js, verdikta-common 49a99fa.
const COMMON_FIXTURE_VECTORS = [
  [0, 0, 0, 400000, 350000, 250000],
  [400000, 200000, 0, 200000, 200000, 0],
  [200000, 400000, 0, 200000, 200000, 0],
  [0, 0, 1000000, 0, 0, 0],
  [0, 0, 0, 1000000, 0, 0],
  [0, 0, 0, 0, 1000000, 0],
  [0, 0, 0, 0, 0, 1000000],
  [0, 1000000, 0, 0, 0, 0],
  [1000000, 0, 0, 0, 0, 0],
  [400000, 200000, 300000, 100000, 0, 0],
  [50000, 50000, 100000, 100000, 600000, 100000],
  [0, 0, 0, 600000, 400000, 0],
  [0, 0, 0, 0, 500000, 500000],
  [0, 0, 0, 0, 499999, 500001],
  [500000, 0, 0, 0, 500000, 0],
  [100000, 0, 800000, 100000, 0, 0],
  [900000, 0, 50000, 50000, 0, 0],
  [100000, 700000, 100000, 100000, 0, 0],
  [300000, 300000, 200000, 200000, 0, 0],
  [300001, 299999, 200000, 200000, 0, 0],
  [300000, 0, 0, 250000, 450000, 0],
  [0, 0, 0, 333333, 333333, 333333],
  [100000, 100000, 100000, 100000, 100000, 499995],
  // and the ones common rejects
  [1000000],
  [1000000, 0, 0, 0, 0],
  [999994, 0, 0, 0, 0, 0],
  [1000001, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 999994],
  [0, 0, 0, 0, 1, 1000000],
];

const sumOf = (r) => SCALE - r.int(0, 5); // 999,995..1,000,000: the aggregator's flooring loss

const GENERATORS = {
  // any composition
  uniform(r) {
    return split(r, sumOf(r), 6);
  },
  // mass on one to three outcomes
  sparse(r) {
    const k = r.int(1, 3);
    const idx = [0, 1, 2, 3, 4, 5].sort(() => r.next() - 0.5).slice(0, k);
    const parts = split(r, sumOf(r), k);
    const v = [0, 0, 0, 0, 0, 0];
    idx.forEach((i, j) => (v[i] = parts[j]));
    return v;
  },
  // the valid mass at or right around the threshold
  validEdge(r) {
    const s = sumOf(r);
    const valid = r.pick([T - 2, T - 1, T, T + 1, 500000, 499999]);
    const [lo, mid, hi, top] = split(r, valid, 4);
    const rest = s - valid;
    const inv = r.next() < 0.3 ? Math.floor(rest / 2) : r.int(0, rest);
    return [inv, rest - inv, lo, mid, hi, top];
  },
  // the mass at or above some class exactly at (or one below) the threshold
  classEdge(r) {
    const s = sumOf(r);
    const c = r.int(2, 5);
    const target = r.pick([T, T - 1, T + 1]);
    const above = c === 5 ? 0 : r.int(0, target);
    const v = [0, 0, 0, 0, 0, 0];
    const aboveParts = split(r, above, 5 - c || 1);
    for (let i = c + 1; i <= 5; i++) v[i] = aboveParts[i - c - 1];
    v[c] = target - above;
    const below = split(r, s - target, c);
    for (let i = 0; i < c; i++) v[i] = below[i];
    return v;
  },
  // INVALID and DUPLICATE tied, the valid mass short of the threshold
  tie(r) {
    const s = sumOf(r);
    const x = r.int(Math.ceil((s - T + 1) / 2), Math.floor(s / 2));
    const [a, b, c, d] = split(r, s - 2 * x, 4);
    return [x, x, a, b, c, d];
  },
  // two valid classes tied, the rest elsewhere
  classTie(r) {
    const s = sumOf(r);
    const i = r.int(2, 4);
    const half = r.int(Math.ceil(T / 2), Math.floor(s / 2));
    const v = [0, 0, 0, 0, 0, 0];
    v[i] = half;
    v[i + 1] = half;
    const rest = split(r, s - 2 * half, 2);
    v[0] = rest[0];
    v[1] = rest[1];
    return v;
  },
};

function malformed(r) {
  switch (r.int(0, 4)) {
    case 0: // a length other than 6
      return split(r, SCALE, r.pick([1, 2, 3, 4, 5, 7, 8, 10, 20]));
    case 1: // the sum just outside the range
      return split(r, r.pick([MIN_SUM - 1, MIN_SUM - r.int(2, 1000), SCALE + 1, SCALE + r.int(2, 1000)]), 6);
    case 2: // one component above the scale
      return split(r, SCALE, 6).map((x, i, a) => (i === 0 ? SCALE + 1 + r.int(0, 10) : x));
    case 3: // far from the scale
      return split(r, r.int(0, MIN_SUM - 1), 6);
    default: // empty
      return [];
  }
}

// The narrow-INVALID floors besides the default the contract deploys with, THRESHOLD (the empty
// band: every INVALID forfeits), that the listings below are judged under (erratum E8): common's
// lowest, one inside the band, and the band's top, where only a valid mass of exactly THRESHOLD - 1
// is narrow. The floor decides `narrow` and the bond only, never the outcome or the award.
const FLOORS = [codeReview.NARROW_INVALID_FLOOR_MIN, 350_000, T - 1];
const invalidWith = (mass) => [SCALE - mass, 0, 0, mass, 0, 0]; // INVALID with exactly `mass` valid, on MEDIUM
// Each floor's edges: valid mass at it and one below, an INVALID/DUPLICATE tie inside the band
// (DUPLICATE, never narrow), and all the mass on DUPLICATE or INVALID (a gate failure: never narrow).
const FLOOR_EDGE_VECTORS = [
  ...FLOORS.flatMap((f) => [invalidWith(f), invalidWith(f - 1), [(SCALE - f) / 2, (SCALE - f) / 2, 0, f, 0, 0].map(Math.floor)]),
  [0, SCALE - 350_000, 0, 350_000, 0, 0],
  [SCALE, 0, 0, 0, 0, 0],
  [0, SCALE, 0, 0, 0, 0],
];

// The listing terms the vectors are settled under, with common's stake for each, and the floor
// list() copies onto each listing from the program. One listing per floor, so a vector is judged
// under every floor at no extra call (the coverage job runs these under instrumentation).
const STAKES = [
  { awards: AWARDS, lowest: Outcome.MEDIUM, floor: T }, // common's code_review.bug.json, the default floor
  { awards: [parseEther("0.05"), ...AWARDS.slice(1)], lowest: Outcome.LOW, floor: FLOORS[0] },
  { awards: [parseEther("0.05"), ...AWARDS.slice(1)], lowest: Outcome.HIGH, floor: FLOORS[1] },
  { awards: [parseEther("0.05"), ...AWARDS.slice(1)], lowest: Outcome.CRITICAL, floor: FLOORS[2] },
  { awards: [7n, 7n, 7n, 7n], lowest: Outcome.LOW, floor: T },
];
const LOWEST = STAKES[1]; // the stake judged under common's lowest floor
const commonStake = ({ awards, lowest }) => ({
  awards: { LOW: String(awards[0]), MEDIUM: String(awards[1]), HIGH: String(awards[2]), CRITICAL: String(awards[3]) },
  lowestClassCounted: OUTCOMES[Number(lowest)],
});

// common's verdict under the stake's floor, or null where it refuses the vector.
function commonVerdict(vector, stake) {
  try {
    return codeReview.settleBugOutcome(vector, commonStake(stake), { narrowInvalidFloor: stake.floor });
  } catch (e) {
    if (e instanceof TypeError) return null;
    throw e;
  }
}

const listWith = (f, s) => H.listAs(f.sa, f.maker, H.params({ artifact: H.atCommit(H.freshCommit()), awards: s.awards, lowestClassCounted: s.lowest }));

async function deployWithStakes() {
  const f = await H.deploy();
  expect(await f.sa.narrowInvalidFloor()).to.equal(BigInt(T));
  const ids = [];
  for (const s of STAKES) {
    await f.sa.connect(f.owner).setNarrowInvalidFloor(s.floor);
    ids.push(await listWith(f, s));
    expect((await f.sa.getListing(ids.at(-1))).narrowInvalidFloor).to.equal(BigInt(s.floor));
  }
  return { ...f, ids };
}

function expectSame(got, want, label) {
  if (want === null) {
    expect(got.wellFormed, `${label}: common refuses it`).to.equal(false);
    expect(got.awardWei).to.equal(0n);
    expect(got.narrow).to.equal(false);
    return;
  }
  expect(got.wellFormed, label).to.equal(true);
  expect(got.outcome, `${label}: ${want.outcome}`).to.equal(BigInt(want.outcomeIndex));
  expect(got.awardWei, `${label}: award`).to.equal(want.paidWei);
  expect(got.narrow, `${label}: narrow (${want.bond})`).to.equal(want.narrow);
}

async function compare(sa, ids, vector, label) {
  for (let k = 0; k < STAKES.length; k++) {
    expectSame(await sa.judgeVector(ids[k], vector), commonVerdict(vector, STAKES[k]), `${label} [${vector}] stake ${k}, floor ${STAKES[k].floor}`);
  }
  return commonVerdict(vector, STAKES[0]) !== null;
}

describe("StakeAttestation: settlement equals @verdikta/common settleBugOutcome (differential)", function () {
  this.timeout(1_200_000);

  it("on common's fixture vectors, under five award tables and four floors, and on each floor's edges", async function () {
    const { sa, ids } = await loadFixture(deployWithStakes);
    expect(await sa.THRESHOLD()).to.equal(BigInt(codeReview.DEFAULT_SETTLEMENT_THRESHOLD));
    expect(await sa.MIN_SCORE_SUM()).to.equal(BigInt(codeReview.OUTCOME_MASS_MIN_TOTAL));
    expect(await sa.MIN_NARROW_INVALID_FLOOR()).to.equal(BigInt(codeReview.NARROW_INVALID_FLOOR_MIN));
    for (const v of COMMON_FIXTURE_VECTORS) await compare(sa, ids, v, "fixture");
    const narrow = STAKES.map(() => 0);
    for (const v of FLOOR_EDGE_VECTORS) {
      expect(await compare(sa, ids, v, "floor edge")).to.equal(true);
      STAKES.forEach((s, k) => { if (commonVerdict(v, s).narrow) narrow[k]++; });
    }
    // the edges reach a narrow INVALID under every floor of the band, and none at THRESHOLD
    STAKES.forEach((s, k) => (s.floor === T ? expect(narrow[k]).to.equal(0) : expect(narrow[k]).to.be.greaterThan(0)));
    expect(commonVerdict(invalidWith(FLOORS[0] - 1), LOWEST).narrow).to.equal(false);
  });

  it("on >= 1,000 random well-formed vectors weighted to the threshold, the ties and the flooring loss, and on malformed ones", async function () {
    const { sa, ids } = await loadFixture(deployWithStakes);
    const seed = 0x5a7c2026;
    const r = rng(seed);
    const names = Object.keys(GENERATORS);
    const seen = { exactThreshold: 0, oneBelow: 0, invDupTie: 0, flooringLoss: 0, narrowAtLowest: 0, invalidBelowLowest: 0, byOutcome: [0, 0, 0, 0, 0, 0] };
    let wellFormed = 0;
    for (let i = 0; i < 1200; i++) {
      const name = names[i % names.length];
      const v = GENERATORS[name](r);
      expect(await compare(sa, ids, v, `seed ${seed} #${i} ${name}`)).to.equal(true);
      wellFormed++;
      const valid = v[2] + v[3] + v[4] + v[5];
      if (valid === T) seen.exactThreshold++;
      if (valid === T - 1) seen.oneBelow++;
      if (v[0] === v[1] && valid < T) seen.invDupTie++;
      if (v.reduce((a, b) => a + b, 0) < SCALE) seen.flooringLoss++;
      seen.byOutcome[commonVerdict(v, STAKES[0]).outcomeIndex]++;
      const atLowest = commonVerdict(v, LOWEST);
      if (atLowest.narrow) seen.narrowAtLowest++;
      else if (atLowest.outcome === "INVALID") seen.invalidBelowLowest++;
    }
    for (let i = 0; i < 150; i++) {
      const v = malformed(r);
      expect(await compare(sa, ids, v, `seed ${seed} malformed #${i}`)).to.equal(false);
    }
    expect(wellFormed).to.be.at.least(1000);
    // The generators really reach the edges and every outcome.
    expect(seen.exactThreshold).to.be.greaterThan(20);
    expect(seen.oneBelow).to.be.greaterThan(20);
    expect(seen.invDupTie).to.be.greaterThan(20);
    expect(seen.flooringLoss).to.be.greaterThan(500);
    expect(seen.narrowAtLowest).to.be.greaterThan(20);
    expect(seen.invalidBelowLowest).to.be.greaterThan(20);
    for (const n of seen.byOutcome) expect(n).to.be.greaterThan(20);
  });

  it("end to end: finalize and settle pay what common pays, the bond included, and fail the rounds common refuses", async function () {
    const { sa, aggregator, owner, maker, hunter } = await loadFixture(H.deploy);
    // one claim under the default floor (every INVALID forfeits), one under common's lowest
    const id = await H.openListing(sa, maker, H.params(), { escrow: 2n * TOP });
    await sa.connect(owner).setNarrowInvalidFloor(FLOORS[0]);
    const lowId = await H.openListing(sa, maker, H.params({ artifact: H.atCommit(H.freshCommit()) }), { escrow: 2n * TOP });
    const claims = [
      { listingId: id, stake: STAKES[0], ...(await H.revealedClaim(sa, hunter, id)) },
      { listingId: lowId, stake: { ...STAKES[0], floor: FLOORS[0] }, ...(await H.revealedClaim(sa, hunter, lowId)) },
    ];
    const r = rng(0x00c0ffee);
    const names = Object.keys(GENERATORS);
    const sample = [
      ...COMMON_FIXTURE_VECTORS,
      ...FLOOR_EDGE_VECTORS,
      ...Array.from({ length: 24 }, (_, i) => GENERATORS[names[i % names.length]](r)),
    ].filter((v) => v.length >= 2 && v.length <= 20); // what a real round can deliver
    const seen = { judged: 0, failed: 0, paid: 0, narrow: 0, forfeited: 0 };
    for (const v of sample) {
      const snap = await network.provider.send("evm_snapshot");
      // both rounds finalize before the clock moves past either dispute window
      for (const k of claims) {
        await aggregator.scriptResult(k.requestId, v, JUSTIFICATION);
        await sa.finalize(k.claimId);
      }
      for (const k of claims) {
        const label = `[${v}] floor ${k.stake.floor}`;
        const want = commonVerdict(v, k.stake);
        const c = await sa.getClaim(k.claimId);
        if (want === null) {
          expect(c.state, label).to.equal(ClaimState.RoundFailed);
          seen.failed++;
          continue;
        }
        seen.judged++;
        if (want.paidWei > 0n) seen.paid++;
        if (want.narrow) seen.narrow++;
        if (want.bond === "forfeited") seen.forfeited++;
        expect(c.state, label).to.equal(ClaimState.Judged);
        expect(c.outcome, label).to.equal(BigInt(want.outcomeIndex));
        await H.afterDisputeWindow(sa, k.claimId);
        const toHunter = want.bond === "returned" ? BOND + want.paidWei : 0n;
        const toMaker = want.bond === "forfeited" ? BOND : 0n;
        await expect(sa.settle(k.claimId), label).to.changeEtherBalances([hunter, maker], [toHunter, toMaker]);
        expect((await sa.getClaim(k.claimId)).paidWei).to.equal(want.paidWei);
        const published = (await sa.validFindings(k.listingId)).length === 1;
        expect(published, `${label} published`).to.equal(want.published);
      }
      await network.provider.send("evm_revert", [snap]);
    }
    expect(seen.judged).to.be.greaterThan(60);
    expect(seen.paid).to.be.greaterThan(20);
    expect(seen.failed).to.be.greaterThan(6);
    expect(seen.narrow).to.be.greaterThan(3);
    expect(seen.forfeited).to.be.greaterThan(3);
  });
});
