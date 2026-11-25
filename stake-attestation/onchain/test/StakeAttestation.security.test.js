// StakeAttestation: proofs of concept from the v2 security review (2026-11-25). Each describe is
// one finding; the fixed ones assert the fixed behaviour (and fail on the code before the fix),
// the others pin the behaviour the report describes so a later design change shows up here.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time, mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const {
  ClaimState, DisputeResult, DisputeKind, Expiry, Outcome, TOP, AWARDS, BOND, DISPUTE_FEE, ORACLE, REVEAL, V,
  params, deployDefaults, deploy, openListing, claimAs, commitAs, revealAs, revealedClaim, judgeAs, confirmAs, roundInfo,
} = H;

// A round run to the end at the mock with `vector` as every juror's reveal: drawn after the
// requester's 30 s, all K commit, promoted, N reveals. The jurors are paid; the wallet gets nothing back.
async function runRound(aggregator, requestId, vector) {
  await time.increase(31);
  const r = await roundInfo(aggregator, requestId);
  const now = BigInt(await ethers.provider.getBlockNumber());
  if (now < r.requestBlock + 2n) await mine(Number(r.requestBlock + 2n - now));
  await aggregator.drawJury(requestId);
  const [K, , N] = (await aggregator.getJury(requestId)).map(Number);
  await aggregator.scriptCommits(requestId, K);
  await mine(1);
  await aggregator.promote(requestId);
  await aggregator.scriptReveals(requestId, Array.from({ length: N }, () => vector.map(BigInt)), "QmJustification");
}

describe("StakeAttestation: security review proofs of concept", function () {
  describe("escrow-funded confirmations are capped at one retry", function () {
    it("a jury that answers every confirmation with no verdict cannot drain the escrow round after round", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults); // size 0: every award confirms
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await revealedClaim(sa, hunter, id);
      await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
      const c0 = await sa.getClaim(claimId);
      const opensAt = c0.judgedAt + (await sa.getListing(id)).disputeWindow;
      await time.setNextBlockTimestamp(opensAt);

      // Two rounds, each answered with a one-number result (no verdict) and paid for from the escrow.
      for (let i = 0; i < 2; i++) {
        const { requestId } = await confirmAs(sa, other, claimId);
        await runRound(aggregator, requestId, [1n]);
        await expect(sa.connect(other).finalize(claimId)).to.emit(sa, "DisputeFailed").withArgs(claimId, id, requestId, true);
      }
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - 2n * DISPUTE_FEE);
      const c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.disputeKind, c.confirmRetried])
        .to.deep.equal([ClaimState.Judged, DisputeResult.NoVerdict, DisputeKind.Confirmation, true]);

      // Before the fix a third, fourth, ... confirmation started here, each another DISPUTE_FEE
      // out of the escrow, until the confirmation deadline (revealWindow, up to 90 days).
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("confirmation retried");
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - 2n * DISPUTE_FEE);

      // The deadline decides, as for any confirmation with no verdict: the first verdict pays.
      await time.setNextBlockTimestamp(opensAt + REVEAL);
      await expect(sa.connect(other).settle(claimId)).to.emit(sa, "ConfirmationNoVerdict").withArgs(claimId, id);
      expect((await sa.getClaim(claimId)).paidWei).to.equal(AWARDS[2]);
    });

    it("a maker's dispute with no verdict leaves the confirmation and its one retry", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await revealedClaim(sa, hunter, id);
      await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
      const { requestId } = await H.disputeAs(sa, maker, claimId);
      await runRound(aggregator, requestId, [1n]);
      await sa.finalize(claimId);
      const c0 = await sa.getClaim(claimId);
      await time.setNextBlockTimestamp(c0.judgedAt + (await sa.getListing(id)).disputeWindow);
      for (let i = 0; i < 2; i++) {
        const r = await confirmAs(sa, other, claimId);
        await runRound(aggregator, r.requestId, [1n]);
        await sa.finalize(claimId);
      }
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("confirmation retried");
    });
  });

  describe("a fee quote the aggregator cannot give is a refused submission, not an unrevealable claim", function () {
    it("a beacon listing whose aggregator drops its beacons: the reveal stands as RoundFailed and the bond comes back", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ oracle: { ...ORACLE, withBeacons: true } }));
      const { claimId } = await claimAs(sa, hunter, id);
      const held = (await sa.getClaim(claimId)).prepayWei;
      await aggregator.setBeacons(false, 2); // maxTotalFee now reverts for this listing
      await expect(sa.commitPrice(id)).to.be.reverted;

      // Before the fix the reveal reverted ("bad budget"), the claim could only expire as
      // Unrevealed and its bond went to the maker.
      const tx = sa.connect(hunter).reveal(claimId, H.BCID, H.CK, H.EK, { value: 0n });
      await expect(tx).to.emit(sa, "SubmissionFailed");
      const c = await sa.getClaim(claimId);
      expect([c.state, c.requestId, c.prepayWei]).to.deep.equal([ClaimState.RoundFailed, ethers.ZeroHash, held]);

      await time.setNextBlockTimestamp(c.failedAt + BigInt(REVEAL));
      const exp = sa.expire(claimId);
      await expect(exp).to.emit(sa, "Expired").withArgs(claimId, id, Expiry.SubmissionsRefused);
      await expect(exp).to.changeEtherBalances([hunter, maker], [BOND + held, 0n]);
    });

    it("with the quote back, a re-trigger sends the held prepay as before", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ oracle: { ...ORACLE, withBeacons: true } }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setBeacons(false, 2);
      await sa.connect(hunter).reveal(claimId, H.BCID, H.CK, H.EK);
      await aggregator.setBeacons(true, 2);
      const topUp = await sa.retriggerTopUp(claimId);
      await expect(sa.connect(hunter).retrigger(claimId, { value: topUp })).to.emit(sa, "EvaluationRequested");
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Revealed);
    });

    it("a prepay below a quote the aggregator does give still reverts the reveal", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params());
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setBonusMultiplier(5); // the live quote rises above the commit's prepay
      await expect(sa.connect(hunter).reveal(claimId, H.BCID, H.CK, H.EK, { value: 0n })).to.be.revertedWith("prepay below fee");
    });
  });

  describe("the commit-order queue: a maker's own claims stall every hunter behind them at no cost (reported, not fixed)", function () {
    it("three disclosed junk claims by the maker's other address hold a real claim for three reveal windows; the maker gets every bond back", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const [hunter, sybil] = hunters;
      const id = await openListing(sa, maker, params());
      const junk = [];
      for (let i = 0; i < 3; i++) junk.push((await claimAs(sa, sybil, id, { archive: ethers.id(`junk${i}`) })).claimId);
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(revealAs(sa, hunter, claimId)).to.be.revertedWith("earlier claim unresolved");

      const makerBefore = await ethers.provider.getBalance(maker.address);
      for (const j of junk) {
        const { revealDeadline } = await sa.claimTimes(j); // max(revealable, headSince) + revealWindow
        await time.setNextBlockTimestamp(revealDeadline);
        await sa.connect(hunter).expire(j); // anyone; only at the end of the junk claim's reveal window
      }
      // The maker (the junk's bond recipient) is up 3 bonds; the sybil got its prepays back.
      expect((await ethers.provider.getBalance(maker.address)) - makerBefore).to.equal(3n * BOND);
      const l = await sa.getListing(id);
      expect([l.headClaim, l.unrevealedClaims]).to.deep.equal([claimId, 3n]);
      const { requestId } = await revealAs(sa, hunter, claimId);
      expect(requestId).to.not.equal(ethers.ZeroHash);
    });
  });
});
