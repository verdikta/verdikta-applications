// StakeAttestation, judgement and settlement (build node P2c): finalize by polling (erratum E4),
// the six-outcome settlement under THRESHOLD (design §8.7, decisions 10 and 11), Depleted and
// owed awards (§13.1), and the payouts of §13.2. Design: verdikta-arbiter
// docs/development/stake-attestation-design.md §8.7, §13.1, §13.2; the build plan's errata
// E4 and E6 and decision D5 override it where they differ (stake-attestation/docs/BUILD_PLAN.md).
//
// Failed rounds only enter the failed-round state here (erratum E6: re-trigger and the no-fault
// expiry are P2d's); disputes are P2d's.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");

const {
  ListingState, Outcome, ClaimState, FIX, DISPUTE, GRACE, T,
  LISTING_CID, BCID, JUSTIFICATION, TOP, AWARDS, BOND, FEE, V,
  params, freshCommit, atCommit, deploy, eventsOf, blockTime,
  listAs, openListing, commitAs, claimAs, revealAs, revealedClaim, judgeAs, afterDisputeWindow,
  recordOf, listingIn, outcomesOf, findingIds, flagIds,
} = H;
const { parseEther, ZeroHash } = ethers;

// A distinct, valid CIDv0-shaped string per claim.
const cidOf = (i) => `Qm${"F".repeat(42)}${String(i).padStart(2, "0")}`;

// common's stake block for the default listing (code_review.bug.json): what settleBugOutcome pays.
const COMMON_STAKE = {
  awards: { LOW: "0", MEDIUM: "0.1 ETH", HIGH: "0.4 ETH", CRITICAL: "2 ETH" },
  lowestClassCounted: "MEDIUM",
};

async function snapshot() {
  return network.provider.send("evm_snapshot");
}
async function restore(id) {
  await network.provider.send("evm_revert", [id]);
}

async function requestCidsOf(sa, aggregator, claimId) {
  const { requestId } = await sa.getClaim(claimId);
  return [...(await aggregator.getRequestCids(requestId))];
}

// One claim through to judgement on `listingId`; returns its id.
async function judgedClaim(sa, aggregator, hunter, listingId, vector, opts = {}) {
  const { claimId } = await revealedClaim(sa, hunter, listingId, opts);
  await judgeAs(sa, aggregator, hunter, claimId, vector);
  return claimId;
}

// ... and settled (waiting out the dispute window when the outcome is valid).
async function settledClaim(sa, aggregator, hunter, listingId, vector, opts = {}) {
  const claimId = await judgedClaim(sa, aggregator, hunter, listingId, vector, opts);
  await afterDisputeWindow(sa, claimId);
  const rc = await (await sa.settle(claimId)).wait();
  return { claimId, rc };
}

describe("StakeAttestation: judgement and settlement (P2c)", function () {
  // ------------------------------------------------------------------ finalize
  describe("finalize() (erratum E4: the contract polls)", function () {
    it("is permissionless: reads getEvaluation, stores the vector, outcome and judgedAt, starts the dispute window, emits Judged", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      const vector = [100000, 0, 0, 300000, 400000, 200000]; // CRITICAL 200k, HIGH and above 600k >= T
      await aggregator.scriptResult(requestId, vector, JUSTIFICATION);

      const tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.emit(sa, "Judged").withArgs(claimId, id, Outcome.HIGH, vector, JUSTIFICATION);
      const judgedAt = await blockTime(await (await tx).wait());
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Judged);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Judged);
      expect(c.outcome).to.equal(Outcome.HIGH);
      expect([...c.vector]).to.deep.equal(vector.map(BigInt));
      expect(c.judgedAt).to.equal(judgedAt);
      expect(await sa.settleableAt(claimId)).to.equal(judgedAt + DISPUTE); // the dispute window
      // Still unresolved: the claim holds its place at the head of commit order.
      const l = await sa.getListing(id);
      expect(l.headClaim).to.equal(claimId);
      expect(l.pendingClaims).to.equal(1n);
    });

    it("refuses a claim that is not Revealed: committed, judged or settled", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(sa.finalize(claimId)).to.be.revertedWith("not revealed");
      await revealAs(sa, hunter, claimId);
      await judgeAs(sa, aggregator, hunter, claimId, V.INVALID);
      await expect(sa.finalize(claimId)).to.be.revertedWith("not revealed");
      await sa.settle(claimId);
      await expect(sa.finalize(claimId)).to.be.revertedWith("not revealed");
      await expect(sa.finalize(99n)).to.be.revertedWith("bad claimId");
    });

    it("with no result while the round is open, reverts 'evaluation not ready' and changes nothing", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, rc } = await revealedClaim(sa, hunter, id);
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      await time.setNextBlockTimestamp((await blockTime(rc)) + 299n); // the mock's response timeout is 300 s
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Revealed);
    });

    it("with no result after the response timeout, settles the round at the aggregator and enters the failed-round state (E6), never reverting", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await time.increase(300);
      const balance = await ethers.provider.getBalance(sa.target);
      const tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.emit(sa, "EvaluationFailed").withArgs(claimId, id, requestId, false);
      await expect(tx).to.emit(aggregator, "EvaluationTimedOut").withArgs(requestId);
      await expect(tx).to.not.emit(sa, "Judged");
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.RoundFailed);
      expect(c.requestId).to.equal(requestId); // a round was started (P2d tells the cases apart by it)
      expect((await aggregator.getAggregationStatus(requestId)).isComplete).to.equal(true);
      // The claim stays unresolved at the head of commit order; its bond is still held.
      const l = await sa.getListing(id);
      expect(l.headClaim).to.equal(claimId);
      expect(l.pendingClaims).to.equal(1n);
      expect(await ethers.provider.getBalance(sa.target)).to.equal(balance);
      await expect(sa.finalize(claimId)).to.be.revertedWith("not revealed");
    });

    it("a round someone else already timed out at the aggregator is a failed round too", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await time.increase(300);
      await aggregator.finalizeEvaluationTimeout(requestId);
      await expect(sa.finalize(claimId)).to.emit(sa, "EvaluationFailed").withArgs(claimId, id, requestId, false);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
    });

    it("a late result that finalizeEvaluationTimeout delivers is judged", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await aggregator.scriptLateResult(requestId, V.CRITICAL, JUSTIFICATION);
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      await time.increase(300);
      await expect(sa.finalize(claimId)).to.emit(sa, "Judged").withArgs(claimId, id, Outcome.CRITICAL, V.CRITICAL, JUSTIFICATION);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
    });

    it("a vector whose length is not 6 or whose sum is outside 999,995-1,000,000 is a failed round, never a revert", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      await aggregator.setMaxLikelihoodLength(32n);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      const MAX = (1n << 256n) - 1n;
      const malformed = [
        [500000, 500000],                                   // a two-outcome vector
        [0, 0, 0, 0, 1000000],                              // five
        [0, 0, 0, 0, 0, 1000000, 0],                        // seven
        Array.from({ length: 20 }, (_, i) => (i === 5 ? 1000000 : 0)),
        Array.from({ length: 32 }, () => 31250),
        [0, 0, 0, 0, 0, 999994],                            // one unit below the flooring loss
        [0, 0, 0, 0, 1, 1000000],                           // one above 1,000,000
        [0, 0, 0, 0, 0, 0],
        [1000001, 0, 0, 0, 0, 0],                           // one component above the scale
        [MAX, 1n, 0n, 0n, 0n, 0n],                          // would overflow a plain sum
        [MAX, MAX, MAX, MAX, MAX, MAX],
        [0n, 0n, 0n, 0n, (1n << 255n), (1n << 255n) + 1000000n], // wraps to 1,000,000 mod 2^256
      ];
      for (const vector of malformed) {
        const snap = await snapshot();
        await aggregator.scriptResult(requestId, vector.map(BigInt), JUSTIFICATION);
        const tx = sa.finalize(claimId);
        await expect(tx, `[${vector}]`).to.emit(sa, "EvaluationFailed").withArgs(claimId, id, requestId, true);
        await expect(tx).to.not.emit(sa, "Judged");
        const c = await sa.getClaim(claimId);
        expect(c.state, `[${vector}]`).to.equal(ClaimState.RoundFailed);
        expect([...c.vector]).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]); // a failed round stores no verdict
        await restore(snap);
      }
    });

    it("accepts every sum from 999,995 to 1,000,000 (the aggregator floors each averaged component)", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      expect(await sa.MIN_SCORE_SUM()).to.equal(999_995n);
      for (let loss = 0; loss <= 5; loss++) {
        const snap = await snapshot();
        const vector = [0, 0, 0, 333333, 333333, 333334 - loss]; // three arbiters' floored average
        await aggregator.scriptResult(requestId, vector, JUSTIFICATION);
        await expect(sa.finalize(claimId), `loss ${loss}`).to.emit(sa, "Judged");
        expect((await sa.getClaim(claimId)).outcome).to.equal(Outcome.HIGH);
        await restore(snap);
      }
    });

    it("returns the unspent prepay to the hunter through the wallet's ethOwed, on a verdict and on a failed round", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const unspent = FEE / 3n;
      await aggregator.setRefundAmount(unspent);
      const id = await openListing(sa, maker);
      for (const timedOut of [false, true]) {
        const snap = await snapshot();
        const hunter = hunters[timedOut ? 1 : 0];
        const { claimId, requestId } = await revealedClaim(sa, hunter, id);
        const { evalWallet } = await sa.getClaim(claimId);
        if (timedOut) await time.increase(300);
        else await aggregator.scriptResult(requestId, V.HIGH, JUSTIFICATION);
        const tx = sa.finalize(claimId);
        await expect(tx).to.changeEtherBalances([hunter, sa], [unspent, 0n]);
        await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, unspent);
        expect(await aggregator.ethOwed(evalWallet)).to.equal(0n);
        expect(await ethers.provider.getBalance(evalWallet)).to.equal(0n);
        await restore(snap);
      }
    });

    it("a broken aggregator withdrawal never blocks finalize: the verdict stands and RefundDeferred is emitted", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      await aggregator.setRefundAmount(FEE);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await aggregator.scriptResult(requestId, V.CRITICAL, JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      const tx = sa.finalize(claimId);
      await expect(tx).to.emit(sa, "RefundDeferred").withArgs(claimId, (await sa.getClaim(claimId)).evalWallet);
      await expect(tx).to.emit(sa, "Judged");
      await expect(tx).to.not.emit(sa, "LeftoverRefunded");
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Judged);
      expect(await aggregator.ethOwed(c.evalWallet)).to.equal(FEE); // still the wallet's credit (recoverLeftoverEth, P2d)
    });

    it("a refund that burns its gas budget is deferred too, and finalize still completes", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      await aggregator.setRefundAmount(FEE);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await aggregator.scriptResult(requestId, V.INVALID, JUSTIFICATION);
      await aggregator.setWithdrawBurnsGas(true);
      expect(await sa.INLINE_REFUND_GAS_LIMIT()).to.equal(200_000n);
      await expect(sa.finalize(claimId)).to.emit(sa, "RefundDeferred").withArgs(claimId, (await sa.getClaim(claimId)).evalWallet);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
    });

    it("the refund always gets its whole gas budget: too little gas reverts finalize instead of deferring the refund", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      await aggregator.setRefundAmount(FEE);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await aggregator.scriptResult(requestId, V.HIGH, JUSTIFICATION);
      const NEEDED = 200_000n + 200_000n / 63n + 30_000n;
      expect(await sa.INLINE_REFUND_GAS_NEEDED()).to.equal(NEEDED);
      const estimate = await sa.finalize.estimateGas(claimId);
      let reverted = 0;
      for (const limit of [150_000n, 250_000n, 300_000n, estimate - 30_000n, estimate - 5_000n, estimate]) {
        const snap = await snapshot();
        try {
          const rc = await (await sa.finalize(claimId, { gasLimit: limit })).wait();
          expect(eventsOf(sa, rc, "RefundDeferred"), `limit ${limit}`).to.have.length(0);
          expect(eventsOf(sa, rc, "LeftoverRefunded"), `limit ${limit}`).to.have.length(1);
        } catch (e) {
          reverted++;
          expect((await sa.getClaim(claimId)).state, `limit ${limit}`).to.equal(ClaimState.Revealed);
        } finally {
          await restore(snap);
        }
      }
      expect(reverted).to.be.greaterThan(0);
      await expect(sa.finalize(claimId, { gasLimit: 250_000n })).to.be.revertedWith("gas below INLINE_REFUND_GAS_NEEDED");
      await expect(sa.finalize(claimId, { gasLimit: estimate })).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, FEE);
    });

    it("plain ETH is refused; only an EvaluationWallet clone's refund is accepted", async function () {
      const { sa, other } = await loadFixture(deploy);
      await expect(other.sendTransaction({ to: sa.target, value: 1n })).to.be.revertedWith("plain ETH refused");
      const relay = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      await expect(relay.act(sa.target, "0x", { value: 1n })).to.be.revertedWith("plain ETH refused");
      // ETH with unknown calldata goes to the (non-payable) fallback and is refused there.
      await expect(other.sendTransaction({ to: sa.target, value: 1n, data: "0x12345678" })).to.be.reverted;
      // A clone the contract never asked to refund cannot push ETH in either: only the
      // requester operates a wallet, and the requester is this contract.
      expect(await sa.walletCodehash()).to.equal(
        ethers.keccak256(
          ethers.concat(["0x363d3d373d3d3d363d73", await sa.walletImplementation(), "0x5af43d82803e903d91602b57fd5bf3"])
        )
      );
    });

    it("the wallet a reveal creates carries the codehash receive() accepts", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await revealedClaim(sa, hunter, id);
      const { evalWallet } = await sa.getClaim(claimId);
      expect(ethers.keccak256(await ethers.provider.getCode(evalWallet))).to.equal(await sa.walletCodehash());
    });
  });

  // ------------------------------------------------------------------ settle
  describe("settle()", function () {
    it("INVALID and DUPLICATE settle at once, by anyone: no dispute is possible on them", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const a = await judgedClaim(sa, aggregator, hunters[0], id, V.INVALID);
      expect(await sa.settleableAt(a)).to.equal((await sa.getClaim(a)).judgedAt);
      await expect(sa.connect(other).settle(a)).to.emit(sa, "Settled").withArgs(a, id, hunters[0].address, Outcome.INVALID, 0n, 0n);
      const b = await judgedClaim(sa, aggregator, hunters[1], id, V.DUPLICATE);
      await expect(sa.connect(other).settle(b)).to.emit(sa, "Settled").withArgs(b, id, hunters[1].address, Outcome.DUPLICATE, 0n, 0n);
      expect((await sa.getClaim(a)).state).to.equal(ClaimState.Settled);
      expect((await sa.getClaim(b)).state).to.equal(ClaimState.Settled);
    });

    it("a valid outcome settles only after the dispute window: one second before and at the boundary", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const claimId = await judgedClaim(sa, aggregator, hunter, id, V.MEDIUM);
      const { judgedAt } = await sa.getClaim(claimId);
      await expect(sa.settle(claimId)).to.be.revertedWith("dispute window open");
      await time.setNextBlockTimestamp(judgedAt + DISPUTE - 1n);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("dispute window open");
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(claimId)).to.emit(sa, "Settled");
    });

    it("refuses a claim that is not Judged, and settles a claim once", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(sa.settle(claimId)).to.be.revertedWith("not judged");
      await revealAs(sa, hunter, claimId);
      await expect(sa.settle(claimId)).to.be.revertedWith("not judged");
      await judgeAs(sa, aggregator, hunter, claimId, V.DUPLICATE);
      await sa.settle(claimId);
      await expect(sa.settle(claimId)).to.be.revertedWith("not judged");
      await expect(sa.settle(42n)).to.be.revertedWith("bad claimId");
      // A failed round is not judged (P2d re-triggers it).
      const second = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const failed = await revealedClaim(sa, hunter, second);
      await time.increase(300);
      await sa.finalize(failed.claimId);
      await expect(sa.settle(failed.claimId)).to.be.revertedWith("not judged");
    });

    it("pays min(awards[class], escrow) plus the bond to the hunter, records paid and owed per claim, emits Settled and leaves the queue", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: TOP + AWARDS[2] });
      const first = await claimAs(sa, hunters[0], id);
      const second = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], first.claimId);
      await judgeAs(sa, aggregator, hunters[0], first.claimId, V.CRITICAL);
      await afterDisputeWindow(sa, first.claimId);
      const tx = sa.settle(first.claimId);
      await expect(tx).to.changeEtherBalances([hunters[0], maker, sa], [TOP + BOND, 0n, -(TOP + BOND)]);
      await expect(tx).to.emit(sa, "Settled").withArgs(first.claimId, id, hunters[0].address, Outcome.CRITICAL, TOP, 0n);
      const settledAt = await blockTime(await (await tx).wait());
      const c = await sa.getClaim(first.claimId);
      expect(c.state).to.equal(ClaimState.Settled);
      expect(c.settledAt).to.equal(settledAt);
      expect(c.paidWei).to.equal(TOP);
      expect(c.owedWei).to.equal(0n);
      let l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(AWARDS[2]);
      expect(l.state).to.equal(ListingState.Depleted); // below the top award
      expect(l.pendingClaims).to.equal(1n);
      expect(l.headClaim).to.equal(second.claimId); // the next claim's turn ...
      expect(l.headSince).to.equal(settledAt); // ... and its reveal clock's floor (decision D5)
      expect([...(await sa.validFindings(id))]).to.deep.equal([first.claimId]);

      // What is left is short of the next award: the claim is paid it and owed the rest.
      await revealAs(sa, hunters[1], second.claimId, { bcid: cidOf(2) });
      expect(await requestCidsOf(sa, aggregator, second.claimId)).to.deep.equal([LISTING_CID, cidOf(2), BCID]);
      await judgeAs(sa, aggregator, hunters[1], second.claimId, V.CRITICAL);
      await afterDisputeWindow(sa, second.claimId);
      const tx2 = sa.settle(second.claimId);
      await expect(tx2).to.changeEtherBalances([hunters[1], sa], [AWARDS[2] + BOND, -(AWARDS[2] + BOND)]);
      await expect(tx2).to.emit(sa, "Settled")
        .withArgs(second.claimId, id, hunters[1].address, Outcome.CRITICAL, AWARDS[2], TOP - AWARDS[2]);
      const c2 = await sa.getClaim(second.claimId);
      expect(c2.paidWei).to.equal(AWARDS[2]);
      expect(c2.owedWei).to.equal(TOP - AWARDS[2]);
      l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(0n);
      expect(l.owedWei).to.equal(TOP - AWARDS[2]);
      expect(l.pendingClaims).to.equal(0n);
      expect(l.headClaim).to.equal(0n);
    });

    it("counts every settled claim by outcome on the listing", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const vectors = [V.INVALID, V.DUPLICATE, V.LOW, V.MEDIUM, V.INVALID, V.HIGH, V.CRITICAL];
      for (let i = 0; i < vectors.length; i++) {
        await settledClaim(sa, aggregator, hunters[i % 4], id, vectors[i], { bcid: cidOf(i) });
      }
      expect([...(await sa.getListing(id)).outcomeCounts]).to.deep.equal([2n, 1n, 1n, 1n, 1n, 1n]);
    });

    it("pays a hunter or a maker that rejects ETH through the pull ledger", async function () {
      const { sa, aggregator, owner, hunter } = await loadFixture(deploy);
      const Rejecting = await ethers.getContractFactory("MockRejectingHunter");
      const makerC = await Rejecting.deploy();
      const hunterC = await Rejecting.deploy();
      await makerC.setRejecting(true);
      await hunterC.setRejecting(true);
      const act = (who, fn, args, value = 0n) => who.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
      const p = params();
      await act(makerC, "list", [p, LISTING_CID, H.DISPUTE_CID, []]);
      const id = await sa.listingCount();
      const fee = await sa.feeDue(id);
      await act(makerC, "fund", [id, fee], fee + TOP);

      // INVALID: the bond to the rejecting maker is credited.
      await act(hunterC, "commit", [id, H.ARCHIVE, H.CT], await sa.commitPrice(id));
      const a = await sa.claimCount();
      await act(hunterC, "disclose", [a, H.CT_CID]);
      await act(hunterC, "reveal", [a, BCID, H.CK, H.EK]);
      await judgeAs(sa, aggregator, owner, a, V.INVALID);
      await expect(sa.settle(a)).to.emit(sa, "PaymentDeferred").withArgs(makerC.target, BOND);
      expect(await sa.withdrawable(makerC.target)).to.equal(BOND);

      // CRITICAL: the award and the bond to the rejecting hunter are credited.
      await act(hunterC, "commit", [id, H.ARCHIVE, H.CT], await sa.commitPrice(id));
      const b = await sa.claimCount();
      await act(hunterC, "disclose", [b, H.CT_CID]);
      await act(hunterC, "reveal", [b, BCID, H.CK, H.EK]);
      await judgeAs(sa, aggregator, owner, b, V.CRITICAL);
      await afterDisputeWindow(sa, b);
      await expect(sa.settle(b)).to.emit(sa, "PaymentDeferred").withArgs(hunterC.target, TOP + BOND);
      await hunterC.setRejecting(false);
      await expect(hunterC.claim(sa.target)).to.changeEtherBalance(hunterC, TOP + BOND);
    });

    for (const entry of ["settle", "finalize", "fund", "close", "withdraw"]) {
      it(`re-entering ${entry}() from a settlement payment is refused and the payment lands`, async function () {
        const { sa, aggregator, owner, maker } = await loadFixture(deploy);
        const reentrant = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
        const act = (fn, args, value = 0n) => reentrant.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
        const id = await openListing(sa, maker);
        await act("commit", [id, H.ARCHIVE, H.CT], await sa.commitPrice(id));
        const claimId = await sa.claimCount();
        await act("disclose", [claimId, H.CT_CID]);
        await act("reveal", [claimId, BCID, H.CK, H.EK]);
        await judgeAs(sa, aggregator, owner, claimId, V.DUPLICATE);
        const args = { settle: [claimId], finalize: [claimId], fund: [id, 0n], close: [id], withdraw: [] }[entry];
        await reentrant.setAttack(sa.target, sa.interface.encodeFunctionData(entry, args));
        await expect(sa.settle(claimId)).to.changeEtherBalance(reentrant, BOND);
        expect(await reentrant.attempted()).to.equal(true);
        expect(await reentrant.attackOk()).to.equal(false);
        expect(await reentrant.attackReasonHash()).to.equal(
          ethers.keccak256(sa.interface.encodeErrorResult("Error(string)", ["reentrant"]))
        );
      });
    }
  });

  // ------------------------------------------------------------------ Depleted and owed
  describe("Depleted and owed awards (design §13.1)", function () {
    it("fund() on a Depleted listing first pays owed claims in commit order (partially if it must), then reopens", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker); // escrow exactly the top award
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      const c = await claimAs(sa, hunters[2], id);
      const run = async ({ claimId }, hunter, vector, bcid) => {
        await revealAs(sa, hunter, claimId, { bcid });
        await judgeAs(sa, aggregator, hunter, claimId, vector);
        await afterDisputeWindow(sa, claimId);
        return sa.settle(claimId);
      };
      await expect(run(a, hunters[0], V.CRITICAL, cidOf(1))).to.emit(sa, "Depleted").withArgs(id, 0n);
      await expect(run(b, hunters[1], V.HIGH, cidOf(2)))
        .to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.HIGH, 0n, AWARDS[2]);
      await run(c, hunters[2], V.CRITICAL, cidOf(3));
      let l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Depleted);
      expect(l.owedWei).to.equal(AWARDS[2] + TOP);
      expect((await sa.getClaim(b.claimId)).owedWei).to.equal(AWARDS[2]);
      expect((await sa.getClaim(c.claimId)).owedWei).to.equal(TOP);

      // A top-up of 1 ETH: b's 0.4 in full, then 0.6 of c's 2.
      const top1 = parseEther("1");
      const tx = sa.connect(maker).fund(id, 0n, { value: top1 });
      await expect(tx).to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[2], 0n);
      await expect(tx).to.emit(sa, "OwedPaid").withArgs(c.claimId, id, hunters[2].address, top1 - AWARDS[2], TOP - (top1 - AWARDS[2]));
      await expect(tx).to.emit(sa, "Funded").withArgs(id, maker.address, 0n, 0n);
      await expect(tx).to.not.emit(sa, "Reopened");
      const rc = await (await tx).wait();
      const paidOrder = eventsOf(sa, rc, "OwedPaid").map((e) => e.args.claimId);
      expect(paidOrder).to.deep.equal([b.claimId, c.claimId]); // commit order
      expect(await sa.withdrawable(hunters[1].address)).to.equal(AWARDS[2]);
      expect(await sa.withdrawable(hunters[2].address)).to.equal(top1 - AWARDS[2]);
      expect((await sa.getClaim(b.claimId)).paidWei).to.equal(AWARDS[2]);
      expect((await sa.getClaim(c.claimId)).paidWei).to.equal(top1 - AWARDS[2]);
      l = await sa.getListing(id);
      expect(l.owedWei).to.equal(TOP + AWARDS[2] - top1);
      expect(l.escrowWei).to.equal(0n);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("amount owed");

      // The rest of c's award, then the escrow back at the top award: reopened.
      const rest = TOP + AWARDS[2] - top1;
      const tx2 = sa.connect(maker).fund(id, 0n, { value: rest + TOP });
      await expect(tx2).to.emit(sa, "OwedPaid").withArgs(c.claimId, id, hunters[2].address, rest, 0n);
      await expect(tx2).to.emit(sa, "Funded").withArgs(id, maker.address, TOP, TOP);
      await expect(tx2).to.emit(sa, "Reopened").withArgs(id, TOP);
      expect((await sa.getClaim(c.claimId)).paidWei).to.equal(TOP);
      expect((await sa.getClaim(c.claimId)).owedWei).to.equal(0n);
      l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Open);
      expect(l.owedWei).to.equal(0n);
      expect(await sa.acceptsCommits(id)).to.equal(true);
      // Nothing owed any more: a further top-up goes straight to the escrow.
      await expect(sa.connect(maker).fund(id, 0n, { value: 5n })).to.not.emit(sa, "OwedPaid");
      await expect(sa.connect(hunters[2]).withdraw()).to.changeEtherBalance(hunters[2], TOP);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed").withArgs(id, maker.address, TOP + 5n);
    });

    it("only an Open listing becomes Depleted: a Rolled listing that pays out below the top award stays Rolled", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }), { escrow: TOP });
      const { claimId } = await claimAs(sa, hunter, id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await sa.connect(maker).rollForward(id, successor);
      await revealAs(sa, hunter, claimId);
      await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.not.emit(sa, "Depleted");
      let l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Rolled);
      expect(l.escrowWei).to.equal(TOP - AWARDS[2]);
      await sa.connect(maker).close(id);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Closed);
    });

    it("a Rolled listing short of an award owes the shortfall; fund() pays it before the escrow", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }), { escrow: TOP });
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await sa.connect(maker).rollForward(id, successor);
      await revealAs(sa, hunters[0], a.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.CRITICAL);
      await afterDisputeWindow(sa, a.claimId);
      await expect(sa.settle(a.claimId)).to.not.emit(sa, "Depleted");
      await revealAs(sa, hunters[1], b.claimId, { bcid: cidOf(2) });
      await judgeAs(sa, aggregator, hunters[1], b.claimId, V.MEDIUM);
      await afterDisputeWindow(sa, b.claimId);
      await sa.settle(b.claimId);
      let l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Rolled);
      expect(l.owedWei).to.equal(AWARDS[1]);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("amount owed");
      const tx = sa.connect(maker).fund(id, 0n, { value: AWARDS[1] + 7n });
      await expect(tx).to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[1], 0n);
      await expect(tx).to.emit(sa, "Funded").withArgs(id, maker.address, 7n, 7n);
      await expect(tx).to.not.emit(sa, "Reopened");
      l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Rolled);
      expect(l.owedWei).to.equal(0n);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed").withArgs(id, maker.address, 7n);
    });
  });

  // ------------------------------------------------------------------ catalogue fixtures
  describe("catalogue fixtures (verdikta-common data/code-review-fixtures.v1.json)", function () {
    it("settlement-median-class-split: 400,000 / 350,000 / 250,000 on MEDIUM / HIGH / CRITICAL settles HIGH and pays HIGH's award", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const vector = [0, 0, 0, 400000, 350000, 250000];
      const common = codeReview.settleBugOutcome(vector, COMMON_STAKE);
      expect(common).to.include({ valid: true, class: "HIGH", bond: "returned" });
      const id = await openListing(sa, maker);
      const { claimId } = await revealedClaim(sa, hunter, id);
      const judged = await judgeAs(sa, aggregator, hunter, claimId, vector);
      expect(eventsOf(sa, judged.rc, "Judged")[0].args.outcome).to.equal(Outcome.HIGH);
      await afterDisputeWindow(sa, claimId);
      const tx = sa.settle(claimId);
      await expect(tx).to.changeEtherBalance(hunter, common.paidWei + BOND);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, common.paidWei, 0n);
      expect(common.paidWei).to.equal(AWARDS[2]);
      // The record (P2e): one finding, class HIGH, HIGH's award paid.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => [f.claimId, f.outcome, f.paidWei, f.owedWei])).to.deep.equal([[claimId, Outcome.HIGH, AWARDS[2], 0n]]);
      expect(outcomesOf(r.history)).to.deep.equal([0n, 0n, 0n, 0n, 1n, 0n]);
    });

    it("settlement-below-threshold-split: INVALID and DUPLICATE hold half the mass; DUPLICATE when its mass is at least INVALID's, else INVALID; nothing paid or published", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const cases = [
        { vector: [400000, 200000, 0, 200000, 200000, 0], outcome: Outcome.INVALID },
        { vector: [200000, 400000, 0, 200000, 200000, 0], outcome: Outcome.DUPLICATE },
        // exactly half valid: a 50/50 split on validity is not valid; the tie between INVALID
        // and DUPLICATE settles DUPLICATE
        { vector: [250000, 250000, 500000, 0, 0, 0], outcome: Outcome.DUPLICATE },
        { vector: [250001, 249999, 0, 0, 0, 500000], outcome: Outcome.INVALID },
      ];
      for (let i = 0; i < cases.length; i++) {
        const { vector, outcome } = cases[i];
        expect(BigInt(codeReview.settleBugOutcome(vector, COMMON_STAKE).outcomeIndex)).to.equal(outcome);
        const hunter = hunters[i % 4];
        const claimId = await judgedClaim(sa, aggregator, hunter, id, vector, { bcid: cidOf(i) });
        const tx = sa.settle(claimId); // at once
        const bondTo = outcome === Outcome.INVALID ? maker : hunter;
        await expect(tx).to.changeEtherBalance(bondTo, BOND);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, outcome, 0n, 0n);
      }
      expect([...(await sa.validFindings(id))]).to.deep.equal([]); // nothing published
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(TOP);
      expect([...l.outcomeCounts]).to.deep.equal([2n, 2n, 0n, 0n, 0n, 0n]);
      // The record (P2e): four counts, nothing published.
      const r = await recordOf(sa, id);
      expect(outcomesOf(r.history)).to.deep.equal([2n, 2n, 0n, 0n, 0n, 0n]);
      expect([r.findingCount, r.findings.length]).to.deep.equal([0n, 0]);
      // One unit past half is valid, at the lowest class with a majority at or above it.
      const claimId = await judgedClaim(sa, aggregator, hunters[0], id, [250000, 249999, 500001, 0, 0, 0], { bcid: cidOf(9) });
      expect((await sa.getClaim(claimId)).outcome).to.equal(Outcome.LOW);
    });

    it("bond-returned-on-valid: LOW, MEDIUM, HIGH and CRITICAL each return the bond, paid or not, and publish the finding", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const classes = [Outcome.LOW, Outcome.MEDIUM, Outcome.HIGH, Outcome.CRITICAL];
      const published = [];
      for (let i = 0; i < classes.length; i++) {
        const hunter = hunters[i];
        const vector = H.oneHot(Number(classes[i]));
        const claimId = await judgedClaim(sa, aggregator, hunter, id, vector, { bcid: cidOf(i) });
        // the request of each carries every earlier valid finding
        expect(await requestCidsOf(sa, aggregator, claimId)).to.deep.equal([LISTING_CID, cidOf(i), ...published]);
        await afterDisputeWindow(sa, claimId);
        const award = classes[i] >= Outcome.MEDIUM ? AWARDS[Number(classes[i]) - 2] : 0n;
        await expect(sa.settle(claimId)).to.changeEtherBalances([hunter, maker], [BOND + award, 0n]);
        published.push(cidOf(i));
      }
      expect((await sa.validFindings(id)).length).to.equal(4);
      // The record (P2e): every one published, with its class and what it was paid.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => f.bcid)).to.deep.equal(published);
      expect([...r.findings].map((f) => f.outcome)).to.deep.equal(classes);
      expect([...r.findings].map((f) => f.paidWei)).to.deep.equal([0n, AWARDS[1], AWARDS[2], AWARDS[3]]);
      expect(outcomesOf(r.history)).to.deep.equal([0n, 0n, 1n, 1n, 1n, 1n]);
    });

    it("bond-returned-on-duplicate: the bond comes back; nothing is paid or published; the prepay is spent", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const unspent = FEE / 4n;
      await aggregator.setRefundAmount(unspent);
      const id = await openListing(sa, maker);
      const hunter = hunters[0];
      const { claimId, requestId } = await revealedClaim(sa, hunter, id, { bcid: cidOf(1) });
      expect(await aggregator.ethReceived(requestId)).to.equal(FEE); // the commit's prepay funded the round
      await aggregator.scriptResult(requestId, V.DUPLICATE, JUSTIFICATION);
      // The prepay is spent: only what the oracles left comes back.
      await expect(sa.connect(maker).finalize(claimId)).to.changeEtherBalance(hunter, unspent);
      await expect(sa.connect(maker).settle(claimId)).to.changeEtherBalances([hunter, maker], [BOND, 0n]);
      expect((await sa.getClaim(claimId)).paidWei).to.equal(0n);
      expect([...(await sa.validFindings(id))]).to.deep.equal([]);
      // The record (P2e): a count, nothing published.
      const r = await recordOf(sa, id);
      expect(outcomesOf(r.history)).to.deep.equal([0n, 1n, 0n, 0n, 0n, 0n]);
      expect(r.findingCount).to.equal(0n);
      const next = await revealedClaim(sa, hunters[1], id, { bcid: cidOf(2) });
      expect(await requestCidsOf(sa, aggregator, next.claimId)).to.deep.equal([LISTING_CID, cidOf(2)]);
    });

    it("bond-forfeited-on-invalid: a gate failure or a jury rejection sends the bond to the maker; the claim is counted; nothing is published", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      for (const [i, vector] of [V.INVALID, [400000, 200000, 300000, 100000, 0, 0]].entries()) {
        expect(codeReview.settleBugOutcome(vector, COMMON_STAKE).bond).to.equal("forfeited");
        const claimId = await judgedClaim(sa, aggregator, hunters[i], id, vector, { bcid: cidOf(i) });
        await expect(sa.settle(claimId)).to.changeEtherBalances([maker, hunters[i], sa], [BOND, 0n, -BOND]);
      }
      const l = await sa.getListing(id);
      expect(l.outcomeCounts[0]).to.equal(2n);
      expect([...(await sa.validFindings(id))]).to.deep.equal([]);
      // The record (P2e) counts both claims and publishes neither.
      const r = await recordOf(sa, id);
      expect(outcomesOf(r.history)).to.deep.equal([2n, 0n, 0n, 0n, 0n, 0n]);
      expect([r.history.claims, r.findingCount]).to.deep.equal([2n, 0n]);
    });

    it("valid-below-counted-class: bond back, no award although LOW has one, the finding published and counted", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const awards = [parseEther("0.05"), ...AWARDS.slice(1)];
      const id = await openListing(sa, maker, params({ awards, lowestClassCounted: Outcome.MEDIUM }));
      const claimId = await judgedClaim(sa, aggregator, hunters[0], id, V.LOW, { bcid: cidOf(1) });
      await expect(sa.settle(claimId)).to.be.revertedWith("dispute window open"); // valid: the maker may dispute
      await afterDisputeWindow(sa, claimId);
      const tx = sa.settle(claimId);
      await expect(tx).to.changeEtherBalances([hunters[0], maker], [BOND, 0n]);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunters[0].address, Outcome.LOW, 0n, 0n);
      await expect(tx).to.not.emit(sa, "Depleted");
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(TOP);
      expect(l.state).to.equal(ListingState.Open);
      expect(l.outcomeCounts[2]).to.equal(1n);
      expect([...(await sa.validFindings(id))]).to.deep.equal([claimId]);
      // The record (P2e): published (class LOW, nothing paid) and counted.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => [f.claimId, f.outcome, f.paidWei, f.bcid])).to.deep.equal([[claimId, Outcome.LOW, 0n, cidOf(1)]]);
      expect(outcomesOf(r.history)).to.deep.equal([0n, 0n, 1n, 0n, 0n, 0n]);
      const next = await revealedClaim(sa, hunters[1], id, { bcid: cidOf(2) });
      expect(await requestCidsOf(sa, aggregator, next.claimId)).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
    });

    it("payout-depletes-escrow: a valid award leaves escrowWei below the top award; Depleted refuses commits; pending claims keep settling and the shortfall accrues to owedWei", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker); // escrow = the top award
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.HIGH);
      await afterDisputeWindow(sa, a.claimId);
      const tx = sa.settle(a.claimId);
      await expect(tx).to.emit(sa, "Depleted").withArgs(id, TOP - AWARDS[2]);
      await expect(tx).to.changeEtherBalance(hunters[0], AWARDS[2] + BOND);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Depleted);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(hunters[2]).commit(id, H.ARCHIVE, H.CT, { value: BOND + FEE })).to.be.revertedWith("not accepting commits");

      // b was committed before the depletion and still settles: 1.6 paid, 0.4 owed.
      await revealAs(sa, hunters[1], b.claimId, { bcid: cidOf(2) });
      await judgeAs(sa, aggregator, hunters[1], b.claimId, V.CRITICAL);
      await afterDisputeWindow(sa, b.claimId);
      const tx2 = sa.settle(b.claimId);
      await expect(tx2).to.changeEtherBalance(hunters[1], TOP - AWARDS[2] + BOND);
      await expect(tx2).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.CRITICAL, TOP - AWARDS[2], AWARDS[2]);
      await expect(tx2).to.not.emit(sa, "Depleted"); // already Depleted
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(0n);
      expect(l.owedWei).to.equal(AWARDS[2]); // shown on the record
      const cb = await sa.getClaim(b.claimId);
      expect(cb.paidWei).to.equal(TOP - AWARDS[2]);
      expect(cb.owedWei).to.equal(AWARDS[2]);
      // Shown on the record (P2e): the listing Depleted and owing, the finding short.
      let r = await recordOf(sa, id);
      let lr = listingIn(r, id);
      expect([lr.state, lr.escrowWei, lr.owedWei]).to.deep.equal([ListingState.Depleted, 0n, AWARDS[2]]);
      expect([...r.findings].map((f) => [f.claimId, f.paidWei, f.owedWei])).to.deep.equal([
        [a.claimId, AWARDS[2], 0n], [b.claimId, TOP - AWARDS[2], AWARDS[2]],
      ]);

      // Topped up: the owed claim is paid first, then the listing reopens.
      const top = sa.connect(maker).fund(id, 0n, { value: AWARDS[2] + TOP });
      await expect(top).to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[2], 0n);
      await expect(top).to.emit(sa, "Reopened").withArgs(id, TOP);
      expect(await sa.acceptsCommits(id)).to.equal(true);
      r = await recordOf(sa, id);
      lr = listingIn(r, id);
      expect([lr.state, lr.escrowWei, lr.owedWei]).to.deep.equal([ListingState.Open, TOP, 0n]);
      expect([r.findings[1].paidWei, r.findings[1].owedWei]).to.deep.equal([TOP, 0n]);
      await expect(sa.connect(hunters[2]).commit(id, H.ARCHIVE, H.CT, { value: BOND + FEE })).to.emit(sa, "Committed");
    });

    it("payment-gate-failure: a deterministic gate failure settles INVALID; the prepay is spent as on any evaluation; the bond goes to the maker", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const unspent = FEE / 5n;
      await aggregator.setRefundAmount(unspent);
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      // A gate failure arrives as the full mass on INVALID (design §8.7).
      await aggregator.scriptResult(requestId, V.INVALID, JUSTIFICATION);
      await expect(sa.connect(other).finalize(claimId)).to.changeEtherBalance(hunter, unspent); // only what the oracles left
      const tx = sa.connect(other).settle(claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, sa], [BOND, 0n, -BOND]);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
      expect(await aggregator.ethReceived(requestId)).to.equal(FEE); // the prepay funded the round
      const r = await recordOf(sa, id); // P2e: counted INVALID, not published
      expect([outcomesOf(r.history)[0], r.findingCount]).to.deep.equal([1n, 0n]);
    });

    it("payment-gate-pass-jury-rejection: the valid mass is below the threshold with INVALID the larger remainder; INVALID; the prepay is spent; the bond goes to the maker", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const vector = [450000, 150000, 250000, 150000, 0, 0];
      expect(codeReview.settleBugOutcome(vector, COMMON_STAKE)).to.include({ outcome: "INVALID", bond: "forfeited" });
      const id = await openListing(sa, maker);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      await aggregator.scriptResult(requestId, vector, JUSTIFICATION);
      await expect(sa.connect(other).finalize(claimId)).to.changeEtherBalance(hunter, 0n); // nothing left unspent
      await expect(sa.connect(other).settle(claimId)).to.changeEtherBalances([maker, hunter], [BOND, 0n]);
      expect((await sa.getClaim(claimId)).outcome).to.equal(Outcome.INVALID);
      const r = await recordOf(sa, id); // P2e: counted INVALID, not published
      expect([outcomesOf(r.history)[0], r.findingCount]).to.deep.equal([1n, 0n]);
    });

    it("two-hunters-same-root-cause-minutes-apart: the second reveal waits for the first to settle; the first is paid; the second is judged with the first in its context and settles DUPLICATE", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const [first, second] = hunters;
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      const a = await claimAs(sa, first, id, { archive: ethers.sha256(ethers.toUtf8Bytes("first archive")) });
      await time.increase(5 * 60); // five minutes later, the same root cause
      const b = await claimAs(sa, second, id, { archive: ethers.sha256(ethers.toUtf8Bytes("second archive")) });
      await time.setNextBlockTimestamp(b.disclosedAt + FIX); // both fix windows have ended
      await revealAs(sa, first, a.claimId, { bcid: cidOf(1) });
      await expect(sa.connect(second).reveal(b.claimId, cidOf(2), H.CK, H.EK)).to.be.revertedWith("earlier claim unresolved");
      await judgeAs(sa, aggregator, first, a.claimId, V.HIGH);
      await expect(sa.connect(second).reveal(b.claimId, cidOf(2), H.CK, H.EK)).to.be.revertedWith("earlier claim unresolved");
      await afterDisputeWindow(sa, a.claimId);
      await expect(sa.settle(a.claimId)).to.changeEtherBalance(first, AWARDS[2] + BOND);

      await revealAs(sa, second, b.claimId, { bcid: cidOf(2) });
      expect(await requestCidsOf(sa, aggregator, b.claimId)).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
      await judgeAs(sa, aggregator, second, b.claimId, V.DUPLICATE);
      const tx = sa.settle(b.claimId); // DUPLICATE: at once
      await expect(tx).to.changeEtherBalances([second, maker], [BOND, 0n]);
      await expect(tx).to.emit(sa, "Settled").withArgs(b.claimId, id, second.address, Outcome.DUPLICATE, 0n, 0n);
      expect([...(await sa.validFindings(id))]).to.deep.equal([a.claimId]);
      // The record (P2e): the first is the finding, paid; the second a DUPLICATE count.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => [f.claimId, f.hunter, f.paidWei])).to.deep.equal([[a.claimId, first.address, AWARDS[2]]]);
      expect(outcomesOf(r.history)).to.deep.equal([0n, 1n, 0n, 0n, 1n, 0n]);
    });

    it("poc-also-fails-at-makers-fixed-hash: after a roll-forward the claim is judged against the committed hash and paid from its escrow", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const SUCCESSOR_CID = "Qm" + "S".repeat(44);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      const { claimId } = await claimAs(sa, hunter, id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }), { listingCid: SUCCESSOR_CID });
      await time.increase(3n * H.DAY); // the maker fixes during the window and rolls forward
      await sa.connect(maker).rollForward(id, successor);
      await revealAs(sa, hunter, claimId);
      // The request names the committed version's archive, not the successor's.
      const cids = await requestCidsOf(sa, aggregator, claimId);
      expect(cids[0]).to.equal(LISTING_CID);
      expect(cids).to.not.include(SUCCESSOR_CID);
      await judgeAs(sa, aggregator, hunter, claimId, V.CRITICAL);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, TOP + BOND);
      expect((await sa.getListing(id)).escrowWei).to.equal(0n);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Rolled);
      expect((await sa.getListing(successor)).escrowWei).to.equal(TOP); // untouched
      // The record (P2e): the finding is the committed hash's; the successor's record has none.
      const rp = await recordOf(sa, id);
      expect(findingIds(rp)).to.deep.equal([claimId]);
      expect(rp.findings[0].outcome).to.equal(Outcome.CRITICAL);
      expect(listingIn(rp, id).successor).to.equal(successor);
      const rs = await recordOf(sa, successor);
      expect([rs.findingCount, rs.history.claims]).to.deep.equal([0n, 0n]);
    });

    it("bug-learned-after-open: known issues cannot be added after open; the maker fixes and rolls forward or leaves it claimable; a hunter who proves it is paid", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const KNOWN = [ethers.sha256(ethers.toUtf8Bytes("known issue 1"))];
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }), { knownIssueIds: KNOWN });
      // No function but list() takes known issues: there is no way to add one to an open listing.
      const takesIds = sa.interface.fragments.filter(
        (f) => f.type === "function" && f.inputs.some((i) => i.type === "bytes32[]")
      );
      expect(takesIds.map((f) => f.name)).to.deep.equal(["list"]);

      // Left claimable: a hunter proves the bug and is owed the award.
      const a = await claimAs(sa, hunters[0], id);
      await time.setNextBlockTimestamp(a.disclosedAt + FIX);
      await revealAs(sa, hunters[0], a.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.MEDIUM);
      await afterDisputeWindow(sa, a.claimId);
      await expect(sa.settle(a.claimId)).to.changeEtherBalance(hunters[0], AWARDS[1] + BOND);

      // Fixed and rolled forward: a claim committed before the roll is still paid in full.
      await sa.connect(maker).fund(id, 0n, { value: AWARDS[1] });
      const b = await claimAs(sa, hunters[1], id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await sa.connect(maker).rollForward(id, successor);
      await revealAs(sa, hunters[1], b.claimId, { bcid: cidOf(2) });
      await judgeAs(sa, aggregator, hunters[1], b.claimId, V.HIGH);
      await afterDisputeWindow(sa, b.claimId);
      await expect(sa.settle(b.claimId)).to.changeEtherBalance(hunters[1], AWARDS[2] + BOND);
      expect([...(await sa.getListing(id)).knownIssueIds]).to.deep.equal(KNOWN);
      // The record (P2e): both proofs are findings of the listed hash, each paid its award.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => [f.claimId, f.paidWei, f.owedWei])).to.deep.equal([
        [a.claimId, AWARDS[1], 0n], [b.claimId, AWARDS[2], 0n],
      ]);
    });

    it("maker-disclosure-key-unusable: the maker lost the disclosure key, the claim was verifiably encrypted to it, and the award is still owed", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      // The maker's key pair; the private half is lost (never used again below).
      const { recipient } = codeReview.generateDisclosureKeyPair();
      const keyBytes = codeReview.parseDisclosureKey(recipient);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE, disclosureKey: ethers.hexlify(keyBytes) }));

      // The hunter encrypts the archive to the registered key and commits both hashes.
      const plaintext = ethers.toUtf8Bytes("a claim archive the maker can no longer read");
      const secrets = codeReview.generateDisclosureSecrets();
      const ciphertext = codeReview.encryptForDisclosure(plaintext, recipient, secrets);
      const archive = codeReview.disclosureSha256(plaintext);
      const ct = codeReview.disclosureSha256(ciphertext);
      const { claimId } = await claimAs(sa, hunter, id, { archive, ct });
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.emit(sa, "Flagged"); // a statement, not a verdict

      await time.increase(FIX);
      const { requestId } = await revealAs(sa, hunter, claimId, { ck: secrets.contentKey, ek: secrets.ephemeralKey });
      // What every arbiter checks, from public data only: it verifies against the listing's key.
      const line = (await aggregator.requestParams(requestId)).addendum;
      const parsed = codeReview.parseDisclosureLine(line);
      expect(parsed.ok).to.equal(true);
      const onChainKey = ethers.getBytes((await sa.getListing(id)).disclosureKey);
      const gate = codeReview.verifyDisclosure({
        plaintext, ciphertext, disclosureKey: onChainKey, ...parsed.fields,
      });
      expect(gate).to.include({ ok: true, gate: "disclosure" });

      await judgeAs(sa, aggregator, hunter, claimId, V.CRITICAL);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, TOP + BOND);
      expect((await sa.getClaim(claimId)).flaggedBadDisclosure).to.equal(true);
      // The record (P2e): the award paid on the finding, and the maker's flag beside it.
      const r = await recordOf(sa, id);
      expect([...r.findings].map((f) => [f.claimId, f.paidWei])).to.deep.equal([[claimId, TOP]]);
      expect(flagIds(r)).to.deep.equal([claimId]);
      expect([r.flags[0].state, r.flags[0].outcome]).to.deep.equal([ClaimState.Settled, Outcome.CRITICAL]);
    });
  });

  // ------------------------------------------------------------------ views and events
  describe("views and events", function () {
    it("judgeVector (the lens) settles a vector under a listing's terms, at the contract's address and at the lens's own", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const r = await sa.judgeVector(id, [0, 0, 0, 400000, 350000, 250000]);
      expect(r.wellFormed).to.equal(true);
      expect(r.outcome).to.equal(Outcome.HIGH);
      expect(r.awardWei).to.equal(AWARDS[2]);
      const lens = new ethers.Contract(await sa.lens(), H.mergedAbi("StakeAttestationLens"), maker);
      const direct = await lens.judgeVector(id, [0, 0, 1000000, 0, 0, 0]);
      expect([direct.wellFormed, direct.outcome, direct.awardWei]).to.deep.equal([true, Outcome.LOW, 0n]);
      const bad = await sa.judgeVector(id, [1, 2, 3]);
      expect([bad.wellFormed, bad.outcome, bad.awardWei]).to.deep.equal([false, Outcome.INVALID, 0n]);
      expect(await sa.THRESHOLD()).to.equal(BigInt(T));
    });

    it("settleableAt is 0 unless the claim is Judged", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await revealedClaim(sa, hunter, id);
      expect(await sa.settleableAt(claimId)).to.equal(0n);
      await judgeAs(sa, aggregator, hunter, claimId, V.DUPLICATE);
      await sa.settle(claimId);
      expect(await sa.settleableAt(claimId)).to.equal(0n);
    });

    it("declares an event for every state change this node adds", async function () {
      const { sa } = await loadFixture(deploy);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of ["Judged", "EvaluationFailed", "Settled", "Depleted", "OwedPaid", "LeftoverRefunded", "RefundDeferred"]) {
        expect(events, name).to.include(name);
      }
    });
  });
});
