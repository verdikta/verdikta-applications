// StakeAttestation on the v2 aggregator (verdikta-dispatcher `beacon` branch; MIGRATION.md):
//   - the listing's two new oracle terms, the fee floor (minOracleFee) and the beacon flag
//     (withBeacons): checked at list, quoted (maxTotalFee(fee, floor, flag, K, P), with the listing's
//     jury) and sent;
//   - drawJury(claimId): anyone draws a claim's open round through its wallet, so the draw
//     reward comes back to the round's funder;
//   - finalize on the v2 phases: a result from phase 6; a dead round (failed at settle, or
//     cancelled when never drawn) is a failed round; anything else is "evaluation not ready";
//   - erratum E6's bond rule as the v2 aggregator lets it be applied: a round whose jury answered
//     with a result that is no verdict forfeits the bond at expiry (RoundsFailed); rounds that
//     ended at the aggregator with no result return it (RoundsUnanswered);
//   - the lens's openRound and jurorFees.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const {
  ClaimState, Expiry, DisputeKind, Phase, REVEAL, BOND, ORACLE, FEE, V, AWARDS,
  params, deploy, eventsOf, openListing, listAs, revealedClaim, judgeAs, afterDisputeWindow, disputeAs,
  drawAs, expireRound, roundInfo, leftover, quote,
} = H;
const { parseEther, ZeroHash } = ethers;

const TREASURY = "0x0000000000000000000000000000000000007EA5";
const CEILING = parseEther("0.0004");
const EFF = ORACLE.maxOracleFee; // below the ceiling

async function fixture() {
  const f = await deploy();
  const listingId = await openListing(f.sa, f.maker);
  return { ...f, listingId };
}

// A listing of a fresh commit with these oracle terms.
const withOracle = (o) => params({ artifact: H.atCommit(H.freshCommit()), oracle: { ...ORACLE, ...o } });

describe("StakeAttestation: the v2 aggregator", function () {
  describe("the quote", function () {
    it("FEE is the live quote: maxTotalFee(fee, floor, flag, K, P) for the Small jury at the mock's defaults, 18 x the clamped fee", async function () {
      const { sa, aggregator, listingId } = await loadFixture(fixture);
      expect(await sa.commitPrice(listingId)).to.equal(BOND + FEE);
      expect(FEE).to.equal(EFF * 18n);
      expect(FEE).to.equal(await aggregator.maxTotalFee(EFF, 0, false, 6, 3));   // the Small jury's K and P
      expect(await sa.disputeFee(listingId)).to.equal(H.DISPUTE_FEE);
    });

    it("the fee floor raises every juror's pay, and the quote with it; the request sends the clamped fee and the floor", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(fixture);
      const floor = EFF * 3n;
      const p = withOracle({ minOracleFee: floor });
      const id = await openListing(sa, maker, p);
      expect(await sa.commitPrice(id)).to.equal(BOND + quote(EFF, { minFee: floor }));
      expect(await sa.commitPrice(id)).to.equal(BOND + floor * 15n + EFF * 3n);
      const [claimFee, disputeFee] = await sa.jurorFees(id);
      expect([claimFee, disputeFee]).to.deep.equal([floor, floor]);
      const { requestId } = await revealedClaim(sa, hunter, id);
      const q = await aggregator.requestParams(requestId);
      expect([q.maxFee, q.minFee, q.withBeacons]).to.deep.equal([EFF, floor, false]);
      // A floor above the ceiling is allowed, and the ceiling still clamps the max fee.
      await aggregator.setMaxOracleFee(EFF / 2n);
      expect(await sa.jurorFees(id)).to.deep.equal([floor, floor]);
      expect(await sa.commitPrice(id)).to.equal(BOND + floor * 15n + (EFF / 2n) * 3n);
    });

    it("the beacon flag adds the quorum to the quote and is sent with the request", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(fixture);
      const id = await openListing(sa, maker, withOracle({ withBeacons: true }));
      expect(await sa.commitPrice(id)).to.equal(BOND + quote(EFF, { beacons: 2n }));
      const { requestId } = await revealedClaim(sa, hunter, id);
      expect((await aggregator.requestParams(requestId)).withBeacons).to.equal(true);
    });

    it("list checks the new terms: a floor above uint96, a beacon listing without a beacon contract, and an escrow above uint88", async function () {
      const { sa, aggregator, maker } = await loadFixture(fixture);
      const at = (o) => withOracle({ ...o });
      await expect(listAs(sa, maker, at({ minOracleFee: 2n ** 96n }))).to.be.revertedWith("bad fee floor");
      await listAs(sa, maker, at({ minOracleFee: parseEther("0.001") })); // a floor above the ceiling is fine
      // max(eff, floor) x 15 + eff x 3 above type(uint88).max (about 309M ETH)
      await expect(listAs(sa, maker, at({ minOracleFee: 2n ** 96n - 1n }))).to.be.revertedWith("bad budget");
      await aggregator.setBeacons(false, 2);
      await expect(listAs(sa, maker, at({ withBeacons: true }))).to.be.revertedWith("bad budget");
      await listAs(sa, maker, at({ withBeacons: false }));
    });
  });

  describe("the listing's jury (OracleParams.jury): one aggregator for every jury size", function () {
    const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
    const JUMBO = { K: 50, M: 38, N: 27, P: 17, timeout: 600 };
    const J = (j) => [BigInt(j.K), BigInt(j.M), BigInt(j.N), BigInt(j.P), BigInt(j.timeout)];

    it("a Small and a Jumbo (with beacons) listing on one aggregator: each quotes, requests and disputes with its own jury", async function () {
      const { sa, aggregator, maker, hunter, other } = await loadFixture(fixture);
      const small = await openListing(sa, maker, withOracle({ jury: SMALL }));
      const jumbo = await openListing(sa, maker, withOracle({ jury: JUMBO, withBeacons: true }), { escrow: AWARDS[3] * 2n });
      expect((await sa.getListing(jumbo)).oracle.jury).to.deep.equal(J(JUMBO));
      expect(await sa.commitPrice(small)).to.equal(BOND + await aggregator.maxTotalFee(EFF, 0, false, 6, 3));
      expect(await sa.commitPrice(jumbo)).to.equal(BOND + await aggregator.maxTotalFee(EFF, 0, true, 50, 17));
      expect(await sa.disputeFee(jumbo)).to.equal(await aggregator.maxTotalFee(ORACLE.disputeMaxOracleFee, 0, true, 50, 17));
      const a = await revealedClaim(sa, hunter, small);
      const b = await revealedClaim(sa, other, jumbo);
      expect(await aggregator.getJury(a.requestId)).to.deep.equal(J(SMALL));
      expect(await aggregator.getJury(b.requestId)).to.deep.equal(J(JUMBO));
      // the Jumbo round: the beacon stage, then a jury of 50 whose deadline runs 600 s from the draw
      await drawAs(sa, aggregator, b.claimId);
      await aggregator.scriptBeacons(b.requestId, 2, false);
      await sa.drawJury(b.claimId);
      const r = await roundInfo(aggregator, b.requestId);
      expect([r.phase, r.baseFees, r.deadline]).to.deep.equal([Phase.Commit, 50n * EFF, BigInt(await time.latest()) + 600n]);
      await aggregator.scriptResult(b.requestId, V.HIGH, "QmJ");               // 27 counted reveals
      expect((await aggregator.getOutcomeScores(b.requestId, 4))[0].length).to.equal(27);
      await sa.finalize(b.claimId);
      expect((await sa.getClaim(b.claimId)).state).to.equal(ClaimState.Judged);
      // the dispute panel asks for the listing's jury too
      const d = await disputeAs(sa, maker, b.claimId);
      expect(await aggregator.getJury(d.requestId)).to.deep.equal(J(JUMBO));
      expect((await aggregator.requestParams(d.requestId)).withBeacons).to.equal(true);
    });

    for (const [label, jury] of [
      ["M above K", { ...SMALL, K: 4 }],
      ["N above M", { ...SMALL, N: 6 }],
      ["P above N", { ...SMALL, P: 5 }],
      ["P = 0", { ...SMALL, P: 0 }],
      ["P = 1 with N > 1", { ...SMALL, P: 1 }],
      ["N above 40", { K: 50, M: 45, N: 41, P: 17, timeout: 600 }],
      ["a zero timeout", { ...SMALL, timeout: 0 }],
    ]) {
      it(`list refuses a jury with ${label} ("bad jury")`, async function () {
        const { sa, maker } = await loadFixture(fixture);
        await expect(listAs(sa, maker, withOracle({ jury }))).to.be.revertedWith("bad jury");
      });
    }

    it("list accepts N = P = 1; the aggregator's live limits (maxJury) are left to the request, which reverts BadJury", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(fixture);
      await listAs(sa, maker, withOracle({ jury: { K: 1, M: 1, N: 1, P: 1, timeout: 300 } }));
      const id = await openListing(sa, maker, withOracle({ jury: JUMBO }), { escrow: AWARDS[3] });
      await aggregator.setLimits(40, 3600);                                   // the owner lowers maxJury below K = 50
      const { claimId } = await H.claimAs(sa, hunter, id);
      const { requestId } = await H.revealAs(sa, hunter, claimId);          // the submission is refused, not reverted
      expect(requestId).to.equal(ZeroHash);
      expect((await sa.getClaim(claimId)).requestId).to.equal(ZeroHash);
    });
  });

  describe("drawJury(claimId)", function () {
    it("anyone draws the claim's round through its wallet; the reward is the wallet's and comes back to the hunter at finalize", async function () {
      const { sa, aggregator, hunter, other, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      expect(requestId).to.equal(ethers.toBeHex(1, 32)); // v2 ids are sequential from 1; 0 stays "refused"
      const c = await sa.getClaim(claimId);
      await expect(sa.connect(other).drawJury(claimId)).to.be.revertedWithCustomError(aggregator, "TooEarly");
      await mine(1);
      await expect(sa.connect(other).drawJury(claimId))
        .to.emit(aggregator, "JuryDrawn").withArgs(requestId, c.evalWallet, 2n * EFF);
      expect(await aggregator.ethOwed(c.evalWallet)).to.equal(2n * EFF);
      await expect(sa.drawJury(claimId)).to.be.revertedWithCustomError(aggregator, "WrongPhase");
      await aggregator.scriptResult(requestId, V.HIGH, "QmJ");
      // Refund: 18 - 6 base - 9 bonus - 2 draw (scriptResult skips promotion) = 1 eff, plus the 2 eff reward.
      const tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.changeEtherBalance(hunter, 3n * EFF);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, 3n * EFF);
    });

    it("draws a dispute-panel round through its wallet (the maker's), and refuses a claim with no round open", async function () {
      const { sa, aggregator, maker, hunter, other, listingId } = await loadFixture(fixture);
      await expect(sa.drawJury(999)).to.be.revertedWith("bad claimId");
      const { claimId } = await revealedClaim(sa, hunter, listingId);
      await judgeAs(sa, aggregator, other, claimId, V.HIGH);
      await expect(sa.drawJury(claimId)).to.be.revertedWith("no round open");
      const { requestId, wallet } = await disputeAs(sa, maker, claimId);
      await mine(1);
      await expect(sa.connect(other).drawJury(claimId)).to.emit(aggregator, "JuryDrawn").withArgs(requestId, wallet, 2n * ORACLE.disputeMaxOracleFee);
    });

    it("with beacons: the first call starts the stage, the second draws", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(fixture);
      const id = await openListing(sa, maker, withOracle({ withBeacons: true }));
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await drawAs(sa, aggregator, claimId);
      expect((await roundInfo(aggregator, requestId)).phase).to.equal(Phase.Beacons);
      await aggregator.scriptBeacons(requestId, 2, false);
      await sa.drawJury(claimId);
      expect((await roundInfo(aggregator, requestId)).phase).to.equal(Phase.Commit);
    });
  });

  describe("finalize on the v2 phases", function () {
    it("an undrawn round is not ready however long it waits (it never times out), until it can be cancelled", async function () {
      const { sa, aggregator, hunter, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      await time.increase(3600);
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      await mine(2);
      await aggregator.sealSeed(requestId); // sealed: cancellable only after the day's draw limit
      await time.increase(24 * 3600 - 7200);
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      await time.increase(3601 + 3600);
      // finalize cancels it itself: the whole prepay to the treasury, nothing back to the hunter.
      const tx = sa.finalize(claimId);
      await expect(tx).to.emit(aggregator, "RoundCancelled").withArgs(requestId, FEE);
      await expect(tx).to.emit(sa, "EvaluationFailed").withArgs(claimId, listingId, requestId, false);
      await expect(tx).to.changeEtherBalance(hunter, 0n);
      expect((await roundInfo(aggregator, requestId)).phase).to.equal(Phase.Cancelled);
      expect(await aggregator.ethOwed(TREASURY)).to.equal(FEE);
      const c = await sa.getClaim(claimId);
      expect([c.state, c.juryAnswered, c.roundStarted]).to.deep.equal([ClaimState.RoundFailed, false, true]);
    });

    it("a drawn round in commit, closing or reveal is not ready before its deadline; after it finalize settles it", async function () {
      const { sa, aggregator, hunter, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      await drawAs(sa, aggregator, claimId);
      await aggregator.scriptCommits(requestId, 2);
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      const { deadline } = await roundInfo(aggregator, requestId);
      await time.increaseTo(deadline + 1n);
      const refund = await leftover(aggregator, requestId);
      const tx = sa.finalize(claimId);
      await expect(tx).to.emit(aggregator, "EvaluationFailed").withArgs(requestId, Phase.Commit);
      await expect(tx).to.emit(sa, "EvaluationFailed").withArgs(claimId, listingId, requestId, false);
      // Too few commits: the unspent prepay, and the draw reward, come back to the hunter.
      await expect(tx).to.changeEtherBalance(hunter, refund + 2n * EFF);
    });

    it("a result is read from phase 6, before the aggregator settles it", async function () {
      const { sa, aggregator, hunter, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      await judgeAs(sa, aggregator, hunter, claimId, V.MEDIUM);
      expect((await roundInfo(aggregator, requestId)).phase).to.equal(Phase.Final);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
    });

    it("a one-number result is no verdict: the round failed, and the jury answered", async function () {
      const { sa, aggregator, hunter, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      await drawAs(sa, aggregator, claimId);
      await aggregator.scriptResult(requestId, [700_000], "QmJ");
      await expect(sa.finalize(claimId)).to.emit(sa, "EvaluationFailed").withArgs(claimId, listingId, requestId, true);
      const c = await sa.getClaim(claimId);
      expect([c.state, c.juryAnswered]).to.deep.equal([ClaimState.RoundFailed, true]);
    });

    it("a missed beacon quorum fails the round at the second draw, its prepay to the treasury", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(fixture);
      const id = await openListing(sa, maker, withOracle({ withBeacons: true }));
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await drawAs(sa, aggregator, claimId);
      await aggregator.scriptBeacons(requestId, 1, true);
      await expect(sa.drawJury(claimId)).to.emit(aggregator, "EvaluationFailed").withArgs(requestId, Phase.Beacons);
      await expect(sa.finalize(claimId)).to.emit(sa, "EvaluationFailed").withArgs(claimId, id, requestId, false);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
    });
  });

  describe("erratum E6's bond rule on the v2 aggregator (expire)", function () {
    async function failedThenExpired(f, how) {
      const { sa, aggregator, hunter, listingId } = f;
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      if (how === "malformed") {
        await drawAs(sa, aggregator, claimId);
        await aggregator.scriptResult(requestId, [500_000, 500_000], "QmJ");
      } else if (how === "no commits") {
        await expireRound(sa, aggregator, claimId);
      } else if (how === "never promoted") {
        await drawAs(sa, aggregator, claimId);
        await aggregator.scriptCommits(requestId, 6);
        await time.increaseTo((await roundInfo(aggregator, requestId)).deadline + 1n);
      } else if (how === "pool shortage") {
        await aggregator.setPoolShortage(true);
        await drawAs(sa, aggregator, claimId);
        await aggregator.setPoolShortage(false);
      }
      await sa.finalize(claimId);
      const { failedAt } = await sa.getClaim(claimId);
      await time.setNextBlockTimestamp(failedAt + REVEAL);
      return { claimId, tx: sa.connect(f.other).expire(claimId) };
    }

    it("a result that is no verdict (the jury answered): the bond to the maker, RoundsFailed", async function () {
      const f = await loadFixture(fixture);
      const { claimId, tx } = await failedThenExpired(f, "malformed");
      await expect(tx).to.changeEtherBalances([f.maker, f.hunter], [BOND, 0n]);
      await expect(tx).to.emit(f.sa, "Expired").withArgs(claimId, f.listingId, Expiry.RoundsFailed);
    });

    for (const how of ["no commits", "never promoted", "pool shortage"]) {
      it(`a round that ended with no result (${how}): the bond back to the hunter, RoundsUnanswered`, async function () {
        const f = await loadFixture(fixture);
        const { claimId, tx } = await failedThenExpired(f, how);
        await expect(tx).to.changeEtherBalances([f.maker, f.hunter], [0n, BOND]);
        await expect(tx).to.emit(f.sa, "Expired").withArgs(claimId, f.listingId, Expiry.RoundsUnanswered);
        expect((await f.sa.getListing(f.listingId)).noVerdictClaims).to.equal(1n);
      });
    }

    it("once a round's jury answered with no verdict, a later round with no result does not return the bond", async function () {
      const f = await loadFixture(fixture);
      const { sa, aggregator, hunter, listingId } = f;
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      await drawAs(sa, aggregator, claimId);
      await aggregator.scriptResult(requestId, [1n], "QmJ");
      await sa.finalize(claimId);
      await sa.connect(hunter).retrigger(claimId, { value: FEE });
      await expireRound(sa, aggregator, claimId);
      await sa.finalize(claimId);
      const { failedAt } = await sa.getClaim(claimId);
      await time.setNextBlockTimestamp(failedAt + REVEAL);
      const tx = sa.expire(claimId);
      await expect(tx).to.changeEtherBalances([f.maker, hunter], [BOND, 0n]);
      await expect(tx).to.emit(sa, "Expired").withArgs(claimId, listingId, Expiry.RoundsFailed);
    });
  });

  describe("the lens's openRound", function () {
    it("names the open round, its wallet, phase and deadline; zero with none open", async function () {
      const { sa, aggregator, maker, hunter, listingId } = await loadFixture(fixture);
      const { claimId, requestId } = await revealedClaim(sa, hunter, listingId);
      const c = await sa.getClaim(claimId);
      let r = await sa.openRound(claimId);
      expect([r.requestId, r.wallet, r.phase, r.deadline]).to.deep.equal([requestId, c.evalWallet, Phase.Draw, 0n]);
      await drawAs(sa, aggregator, claimId);
      r = await sa.openRound(claimId);
      expect(r.phase).to.equal(Phase.Commit);
      expect(r.deadline).to.equal((await roundInfo(aggregator, requestId)).deadline);
      await aggregator.scriptResult(requestId, V.HIGH, "QmJ");
      await sa.finalize(claimId);
      r = await sa.openRound(claimId);
      expect([r.requestId, r.phase]).to.deep.equal([ZeroHash, 0n]);
      const d = await disputeAs(sa, maker, claimId);
      r = await sa.openRound(claimId);
      expect([r.requestId, r.wallet, r.phase]).to.deep.equal([d.requestId, d.wallet, Phase.Draw]);
    });
  });
});
