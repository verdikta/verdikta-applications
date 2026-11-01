// StakeAttestation, late claims (build node P2e). Design: verdikta-arbiter
// docs/development/stake-attestation-design.md §13.2 (`lateClaim`), §4.1 (the record's `later`
// history); the build plan's decision D6 and errata E1 and E5 override it where they differ
// (stake-attestation/docs/BUILD_PLAN.md):
//   - D6: a late claim is commit-shaped: the two commitments (E5's two-step commit and
//     disclose), the listing's fix window, a reveal with the E1 disclosure line, behind the
//     listing's pending claims, and no award: the bond comes back unless INVALID.
//   - §13.2 names its caller "hunter", with no allowlist (commit's is "hunter, on the
//     allowlist, if any"): a stake that ended cannot keep later findings off its record.
//   - A late claim is recorded under `later` only (lateClaims, lateOutcomeCounts, lateExpired,
//     and a valid one among the findings with late = true); it never changes the history the
//     stake earned while it was open, and it never holds close(): no award rides on it.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");

const {
  ListingState, Outcome, ClaimState, Expiry, DisputeResult, DAY, FIX, GRACE, DISPUTE, REVEAL,
  LISTING_CID, CT_CID, BCID, JUSTIFICATION, ARCHIVE, CT, CK, EK, TOP, AWARDS, BOND, FEE, V,
  params, freshCommit, atCommit, deploy, eventsOf, blockTime,
  listAs, openListing, commitAs, claimAs, revealAs, revealedClaim, judgeAs, afterDisputeWindow,
  disputeAs, judgeDisputeAs, lateAs, lateClaimAs, recordOf, listingIn, outcomesOf, lateOutcomesOf,
} = H;
const { ZeroHash } = ethers;

const DISCLOSE_WINDOW = H.HOUR;
const LISTING_PERIOD = 30n * DAY;
const cidOf = (i) => `Qm${"L".repeat(42)}${String(i).padStart(2, "0")}`;

async function snapshot() {
  return network.provider.send("evm_snapshot");
}
async function restore(id) {
  await network.provider.send("evm_revert", [id]);
}

// An Open listing rolled forward to a fresh successor: returns both ids.
async function rolledListing(sa, maker, p = params(), opts = {}) {
  const id = await openListing(sa, maker, p, opts);
  const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
  await sa.connect(maker).rollForward(id, successor);
  return { id, successor };
}

// An Open listing closed with nothing pending: returns its id.
async function closedListing(sa, maker, p = params(), opts = {}) {
  const id = await openListing(sa, maker, p, opts);
  await sa.connect(maker).close(id);
  return id;
}

// A disclosed late claim revealed at once (the listing's fix window is 0 by default).
async function revealedLate(sa, hunter, listingId, opts = {}) {
  const { claimId } = await lateClaimAs(sa, hunter, listingId, opts);
  const { requestId, rc } = await revealAs(sa, hunter, claimId, opts);
  return { claimId, requestId, rc };
}

describe("StakeAttestation: late claims (P2e, decision D6)", function () {
  // ------------------------------------------------------------------ lateClaim()
  describe("lateClaim()", function () {
    it("is taken on a Rolled or Closed listing only: Listed, Open, lapsed and Depleted listings refuse it", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const hunter = hunters[0];
      const fresh = () => params({ artifact: atCommit(freshCommit()) });
      const listed = await listAs(sa, maker, fresh());
      const open = await openListing(sa, maker, fresh());
      const depleted = await openListing(sa, maker, fresh());
      const { claimId } = await revealedClaim(sa, hunters[1], depleted);
      await judgeAs(sa, aggregator, hunters[1], claimId, V.HIGH);
      await afterDisputeWindow(sa, claimId);
      await sa.settle(claimId);
      expect((await sa.getListing(depleted)).state).to.equal(ListingState.Depleted);
      const { id: rolled } = await rolledListing(sa, maker, fresh());
      const closed = await closedListing(sa, maker, fresh());

      for (const id of [listed, open, depleted]) {
        await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE }), `listing ${id}`)
          .to.be.revertedWith("not accepting late claims");
        expect(await sa.acceptsLateClaims(id)).to.equal(false);
      }
      for (const id of [rolled, closed]) {
        expect(await sa.acceptsLateClaims(id)).to.equal(true);
        expect(await sa.acceptsCommits(id)).to.equal(false);
        await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(sa, "LateClaim");
      }
      // A lapsed listing is still Open: it takes neither commits nor late claims.
      await time.increase(LISTING_PERIOD);
      expect(await sa.isLapsed(open)).to.equal(true);
      await expect(sa.connect(hunter).lateClaim(open, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("not accepting late claims");
      await expect(sa.connect(hunter).lateClaim(99n, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("bad listingId");
      await expect(sa.acceptsLateClaims(99n)).to.be.revertedWith("bad listingId");
    });

    it("stores the two hashes, the bond and the prepay, nothing readable (E5); emits LateClaim, not Committed; counts under later only", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const { id } = await rolledListing(sa, maker);
      const before = await sa.getListing(id);
      const price = await sa.commitPrice(id);
      expect(price).to.equal(BOND + FEE);
      const tx = sa.connect(hunters[2]).lateClaim(id, ARCHIVE, CT, { value: price + 1000n });
      const claimId = (await sa.claimCount()) + 1n;
      await expect(tx).to.emit(sa, "LateClaim").withArgs(claimId, id, hunters[2].address, ARCHIVE, CT, BOND, FEE + 1000n);
      await expect(tx).to.not.emit(sa, "Committed");
      await expect(tx).to.changeEtherBalances([hunters[2], sa], [-(price + 1000n), price + 1000n]);
      const at = await blockTime(await (await tx).wait());

      const c = await sa.getClaim(claimId);
      expect(c.late).to.equal(true);
      expect(c.hunter).to.equal(hunters[2].address);
      expect(c.listingId).to.equal(id);
      expect(c.state).to.equal(ClaimState.Committed);
      expect(c.committedAt).to.equal(at);
      expect([c.archiveHash, c.ciphertextSha256]).to.deep.equal([ARCHIVE, CT]);
      expect([c.bondWei, c.prepayWei]).to.deep.equal([BOND, FEE + 1000n]);
      expect(c.ciphertextCid).to.equal(""); // nothing fetchable until disclose

      const l = await sa.getListing(id);
      expect(l.lateClaims).to.equal(1n);
      expect(l.claimsCommitted).to.equal(before.claimsCommitted); // the history is the stake's
      expect(l.pendingClaims).to.equal(before.pendingClaims); // a late claim never holds close()
      expect(l.headClaim).to.equal(claimId); // it is in the commit-order queue
      expect(l.tailClaim).to.equal(claimId);
    });

    it("is open to every hunter: an invited listing's allowlist does not apply once it rolled or closed", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const p = params({ allowlist: [hunters[0].address] });
      const { id } = await rolledListing(sa, maker, p);
      expect(await sa.isAllowed(id, hunters[1].address)).to.equal(false);
      await expect(sa.connect(hunters[1]).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(sa, "LateClaim");
    });

    it("requires the bond plus the live maxTotalFee, which commitPrice quotes; refuses a zero hash", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE - 1n })).to.be.revertedWith("payment below bond + fee");
      await expect(sa.connect(hunter).lateClaim(id, ZeroHash, CT, { value: BOND + FEE })).to.be.revertedWith("bad archiveHash");
      await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, ZeroHash, { value: BOND + FEE })).to.be.revertedWith("bad ciphertextSha256");
      await aggregator.setFeeMultiplier(5n);
      expect(await sa.commitPrice(id)).to.equal(BOND + H.ORACLE.maxOracleFee * 5n);
      await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("payment below bond + fee");
      await expect(lateAs(sa, hunter, id)).to.not.be.rejected;
    });
  });

  // ------------------------------------------------------------------ E5 and the fix window
  describe("disclosure and the listing's fix window (erratum E5)", function () {
    it("disclose within DISCLOSE_WINDOW; an undisclosed late claim may be expired by anyone after it: bond to the maker, prepay back, a late expiry", async function () {
      const { sa, maker, other, hunters } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      const a = await lateAs(sa, hunters[0], id);
      await expect(sa.connect(other).disclose(a.claimId, CT_CID)).to.be.revertedWith("not hunter");
      await time.setNextBlockTimestamp(a.at + DISCLOSE_WINDOW);
      await expect(sa.connect(hunters[0]).disclose(a.claimId, CT_CID)).to.be.revertedWith("disclose window over");
      const tx = sa.connect(other).expire(a.claimId);
      await expect(tx).to.emit(sa, "Expired").withArgs(a.claimId, id, Expiry.Undisclosed);
      await expect(tx).to.changeEtherBalances([maker, hunters[0], sa], [BOND, FEE, -(BOND + FEE)]);
      const l = await sa.getListing(id);
      expect([l.lateExpired, l.undisclosedClaims, l.pendingClaims]).to.deep.equal([1n, 0n, 0n]);
      expect(l.headClaim).to.equal(0n);
    });

    it("runs the listing's fix window from disclose, its own on a Rolled listing and on a Closed one that had rolled; the maker may flag and release it", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const p = () => params({ artifact: atCommit(freshCommit()), fixWindow: FIX, disclosureGrace: GRACE });
      const { id: rolled } = await rolledListing(sa, maker, p());
      const { id: rolledThenClosed } = await rolledListing(sa, maker, p());
      await sa.connect(maker).close(rolledThenClosed);
      const closed = await closedListing(sa, maker, p());

      for (const id of [rolled, rolledThenClosed, closed]) {
        const { claimId, disclosedAt } = await lateClaimAs(sa, hunters[0], id);
        const c = await sa.getClaim(claimId);
        expect(c.fixWindowEnd, `listing ${id}`).to.equal(disclosedAt + FIX);
        expect((await sa.claimTimes(claimId)).revealableAt, `listing ${id}`).to.equal(disclosedAt + FIX);
        expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed);
        await expect(revealAs(sa, hunters[0], claimId)).to.be.revertedWith("fix window open");
      }

      // The maker may flag within the grace, and release.
      const { claimId, disclosedAt } = await lateClaimAs(sa, hunters[1], closed);
      await time.setNextBlockTimestamp(disclosedAt + GRACE - 1n);
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.emit(sa, "Flagged").withArgs(claimId, closed);
      await expect(sa.connect(maker).release(claimId)).to.emit(sa, "Released").withArgs(claimId, closed);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
      // Recorded under later only: the history's released count is the stake's.
      expect((await sa.getListing(closed)).releasedClaims).to.equal(0n);
      expect((await sa.getClaim(claimId)).released).to.equal(true);
    });

    it("fixWindow 0: revealable as soon as it is disclosed", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      const { claimId, disclosedAt } = await lateClaimAs(sa, hunter, id);
      expect((await sa.getClaim(claimId)).fixWindowEnd).to.equal(disclosedAt);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
    });
  });

  // ------------------------------------------------------------------ reveal
  describe("reveal (erratum E1) and commit order", function () {
    it("sends cids = [listingCid, bcid, the prior valid findings] and the E1 line byte for byte", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const prior = await revealedClaim(sa, hunters[0], id, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, hunters[0], prior.claimId, V.MEDIUM);
      await afterDisputeWindow(sa, prior.claimId);
      await sa.settle(prior.claimId);
      await sa.connect(maker).close(id);

      const { claimId, requestId } = await revealedLate(sa, hunters[1], id, { bcid: cidOf(2) });
      expect([...(await aggregator.getRequestCids(requestId))]).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
      const line = (await aggregator.requestParams(requestId)).addendum;
      expect(line).to.equal(codeReview.formatDisclosureLine({
        archiveSha256: ARCHIVE, ciphertextSha256: CT, ciphertextCid: CT_CID, contentKey: CK, ephemeralKey: EK,
      }));
      expect(line).to.equal(`verdikta-disclosure: ${ARCHIVE} ${CT} ${CT_CID} ${CK} ${EK}`);
      expect(codeReview.parseDisclosureLine(line).ok).to.equal(true);
      const p = await aggregator.requestParams(requestId);
      expect([p.maxFee, p.requestedClass, p.alpha]).to.deep.equal([H.ORACLE.maxOracleFee, H.ORACLE.requestedClass, H.ORACLE.alpha]);
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Revealed);
      expect(c.bcid).to.equal(cidOf(2));
    });

    it("waits behind the pending claims: on a Rolled listing a late claim reveals only once every earlier claim has settled or expired", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      const a = await claimAs(sa, hunters[0], id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await sa.connect(maker).rollForward(id, successor);
      const late = await lateClaimAs(sa, hunters[1], id);
      await sa.connect(maker).release(late.claimId);
      expect(await sa.claimState(late.claimId)).to.equal(ClaimState.Revealable);
      await expect(revealAs(sa, hunters[1], late.claimId)).to.be.revertedWith("earlier claim unresolved");
      expect((await sa.claimTimes(late.claimId)).revealDeadline).to.equal(0n); // the clock waits (D5)

      await revealAs(sa, hunters[0], a.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.DUPLICATE);
      await expect(revealAs(sa, hunters[1], late.claimId)).to.be.revertedWith("earlier claim unresolved");
      const rc = await (await sa.settle(a.claimId)).wait();
      expect((await sa.claimTimes(late.claimId)).revealDeadline).to.equal((await blockTime(rc)) + REVEAL);
      await expect(revealAs(sa, hunters[1], late.claimId, { bcid: cidOf(2) })).to.not.be.rejected;
    });
  });

  // ------------------------------------------------------------------ settlement
  describe("settlement: no award; the bond returned unless INVALID", function () {
    it("a valid late claim gets its bond back and no award, whatever the class and the escrow; DUPLICATE returns the bond; INVALID forfeits it", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const { id } = await rolledListing(sa, maker, params(), { escrow: 2n * TOP });
      const cases = [
        { vector: V.CRITICAL, outcome: Outcome.CRITICAL, bondTo: "hunter", valid: true },
        { vector: V.LOW, outcome: Outcome.LOW, bondTo: "hunter", valid: true },
        { vector: V.DUPLICATE, outcome: Outcome.DUPLICATE, bondTo: "hunter", valid: false },
        { vector: V.INVALID, outcome: Outcome.INVALID, bondTo: "maker", valid: false },
      ];
      const published = [];
      for (const [i, k] of cases.entries()) {
        const hunter = hunters[i];
        const { claimId } = await revealedLate(sa, hunter, id, { bcid: cidOf(i) });
        await judgeAs(sa, aggregator, other, claimId, k.vector);
        if (k.valid) {
          await expect(sa.settle(claimId)).to.be.revertedWith("dispute window open"); // the maker may dispute it
          await afterDisputeWindow(sa, claimId);
        }
        const tx = sa.connect(other).settle(claimId);
        const toMaker = k.bondTo === "maker" ? BOND : 0n;
        const toHunter = k.bondTo === "hunter" ? BOND : 0n;
        await expect(tx).to.changeEtherBalances([maker, hunter, sa], [toMaker, toHunter, -BOND]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, k.outcome, 0n, 0n);
        await expect(tx).to.not.emit(sa, "Depleted");
        const c = await sa.getClaim(claimId);
        expect([c.state, c.paidWei, c.owedWei]).to.deep.equal([ClaimState.Settled, 0n, 0n]);
        if (k.valid) published.push(claimId);
      }
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(2n * TOP); // untouched
      expect(l.owedWei).to.equal(0n);
      expect(l.state).to.equal(ListingState.Rolled);
      expect(outcomesOf({ outcomes: l.outcomeCounts })).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]);
      expect(lateOutcomesOf({ lateOutcomes: l.lateOutcomeCounts })).to.deep.equal([1n, 1n, 1n, 0n, 0n, 1n]);
      expect([...(await sa.validFindings(id))]).to.deep.equal(published); // published, as any valid finding
    });

    it("on a Closed listing with no escrow a valid late claim owes nothing: no shortfall accrues", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      const { claimId } = await revealedLate(sa, hunter, id);
      await judgeAs(sa, aggregator, hunter, claimId, V.CRITICAL);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, BOND);
      const l = await sa.getListing(id);
      expect([l.escrowWei, l.owedWei, l.state]).to.deep.equal([0n, 0n, ListingState.Closed]);
    });

    it("the maker may dispute a valid late claim; the panel's outcome is final; the history's dispute counts stay the stake's", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      const { claimId } = await revealedLate(sa, hunter, id);
      await judgeAs(sa, aggregator, other, claimId, V.HIGH);
      expect(await sa.disputeDeadline(claimId)).to.be.greaterThan(0n);
      await disputeAs(sa, maker, claimId);
      await judgeDisputeAs(sa, aggregator, other, claimId, V.INVALID);
      const c = await sa.getClaim(claimId);
      expect([c.outcome, c.dispute]).to.deep.equal([Outcome.INVALID, DisputeResult.Overturned]);
      await expect(sa.settle(claimId)).to.changeEtherBalances([maker, hunter], [BOND, 0n]);
      const l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.disputesOverturned, l.disputesNoVerdict]).to.deep.equal([0n, 0n, 0n, 0n]);
      expect(l.lateOutcomeCounts[0]).to.equal(1n);
    });

    it("a failed round re-triggers as any claim's (E6); one never settled expires as a late expiry, the bond to the maker", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      let snap = await snapshot();
      let f = await revealedLate(sa, hunter, id);
      await time.increase(300); // the mock's response timeout
      await sa.finalize(f.claimId);
      expect((await sa.getClaim(f.claimId)).state).to.equal(ClaimState.RoundFailed);
      await sa.connect(hunter).retrigger(f.claimId, { value: FEE });
      await judgeAs(sa, aggregator, hunter, f.claimId, V.DUPLICATE);
      await expect(sa.settle(f.claimId)).to.changeEtherBalance(hunter, BOND);
      await restore(snap);

      f = await revealedLate(sa, hunter, id);
      await time.increase(300);
      const rc = await (await sa.finalize(f.claimId)).wait();
      await time.setNextBlockTimestamp((await blockTime(rc)) + REVEAL);
      const tx = sa.connect(other).expire(f.claimId);
      await expect(tx).to.emit(sa, "Expired").withArgs(f.claimId, id, Expiry.RoundsFailed);
      await expect(tx).to.changeEtherBalances([maker, hunter], [BOND, 0n]);
      const l = await sa.getListing(id);
      expect([l.lateExpired, l.noVerdictClaims]).to.deep.equal([1n, 0n]);
    });

    it("an unrevealed late claim expires revealWindow after its reveal clock starts, the bond to the maker", async function () {
      const { sa, maker, other, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker);
      const { claimId, disclosedAt } = await lateClaimAs(sa, hunter, id);
      await time.setNextBlockTimestamp(disclosedAt + REVEAL - 1n);
      await expect(sa.connect(other).expire(claimId)).to.be.revertedWith("reveal window open");
      const tx = sa.connect(other).expire(claimId);
      await expect(tx).to.emit(sa, "Expired").withArgs(claimId, id, Expiry.Unrevealed);
      await expect(tx).to.changeEtherBalances([maker, hunter], [BOND, FEE]);
      const l = await sa.getListing(id);
      expect([l.lateExpired, l.unrevealedClaims]).to.deep.equal([1n, 0n]);
    });

    it("a pending late claim does not hold close(): the Rolled listing closes and returns its escrow, and the late claim still settles", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const { id } = await rolledListing(sa, maker);
      const { claimId } = await revealedLate(sa, hunter, id);
      expect((await sa.getListing(id)).pendingClaims).to.equal(0n);
      await expect(sa.connect(maker).close(id)).to.changeEtherBalance(maker, TOP);
      await judgeAs(sa, aggregator, hunter, claimId, V.MEDIUM);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, BOND);
      expect((await sa.getListing(id)).headClaim).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ catalogue fixture
  describe("catalogue fixtures (verdikta-common data/code-review-fixtures.v1.json)", function () {
    it("later-finding-against-closed-hash: a valid late claim on a hash whose stake has closed is recorded under the record's later history; no award; the bond is returned", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      // While staked: one claim judged INVALID. Then the stake closes.
      const early = await claimAs(sa, hunters[0], id);
      await sa.connect(maker).release(early.claimId);
      await revealAs(sa, hunters[0], early.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, other, early.claimId, V.INVALID);
      await sa.settle(early.claimId);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed").withArgs(id, maker.address, TOP);
      const before = await recordOf(sa, id);

      // Later: a hunter proves a bug in the closed hash. The listing's fix window applies.
      const hunter = hunters[1];
      const { claimId, disclosedAt } = await lateClaimAs(sa, hunter, id);
      await time.setNextBlockTimestamp(disclosedAt + FIX);
      await revealAs(sa, hunter, claimId, { bcid: cidOf(2) });
      await judgeAs(sa, aggregator, other, claimId, V.HIGH);
      await afterDisputeWindow(sa, claimId);
      const tx = sa.connect(other).settle(claimId);
      await expect(tx).to.changeEtherBalances([hunter, maker, sa], [BOND, 0n, -BOND]); // the bond, no award
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, 0n, 0n);

      const r = await recordOf(sa, id);
      const lr = listingIn(r, id);
      expect(lr.state).to.equal(ListingState.Closed);
      expect(r.active.length).to.equal(0); // the badge ended
      // The history the stake earned is unchanged ...
      for (const h of [r.history, lr.history]) {
        expect(h.claims).to.equal(1n);
        expect(outcomesOf(h)).to.deep.equal([1n, 0n, 0n, 0n, 0n, 0n]);
        // ... and the late finding is under later.
        expect(h.lateClaims).to.equal(1n);
        expect(lateOutcomesOf(h)).to.deep.equal([0n, 0n, 0n, 0n, 1n, 0n]);
        expect(h.lateExpired).to.equal(0n);
      }
      expect(outcomesOf(r.history)).to.deep.equal(outcomesOf(before.history));
      expect(r.findingCount).to.equal(1n);
      const [f] = r.findings;
      expect(f.claimId).to.equal(claimId);
      expect(f.late).to.equal(true);
      expect(f.outcome).to.equal(Outcome.HIGH);
      expect(f.paidWei).to.equal(0n);
      expect(f.owedWei).to.equal(0n);
      expect(f.bcid).to.equal(cidOf(2));
      expect(f.revealedAt).to.equal((await sa.getClaim(claimId)).revealedAt);
      expect(lr.escrowWei).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ views
  describe("views", function () {
    it("claimState, claimTimes and settleableAt follow a late claim as any claim", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await closedListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      const { claimId, at } = await lateAs(sa, hunter, id);
      expect((await sa.claimTimes(claimId)).discloseDeadline).to.equal(at + DISCLOSE_WINDOW);
      const disclosedAt = await blockTime(await (await sa.connect(hunter).disclose(claimId, CT_CID)).wait());
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed);
      await time.increaseTo(disclosedAt + FIX);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
      expect((await sa.claimTimes(claimId)).revealDeadline).to.equal(disclosedAt + FIX + REVEAL);
      await revealAs(sa, hunter, claimId);
      const { at: judgedAt } = await judgeAs(sa, aggregator, hunter, claimId, V.LOW);
      expect(await sa.settleableAt(claimId)).to.equal(judgedAt + DISPUTE);
    });

    it("declares LateClaim with the fields of Committed", async function () {
      const { sa } = await loadFixture(deploy);
      const names = (e) => sa.interface.getEvent(e).inputs.map((i) => `${i.type} ${i.name}`);
      expect(names("LateClaim")).to.deep.equal(names("Committed"));
    });
  });
});
