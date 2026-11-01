// StakeAttestation, disputes, failed rounds, re-trigger and leftover recovery (build node P2d).
// Design: verdikta-arbiter docs/development/stake-attestation-design.md §13.2 (dispute,
// retrigger), §12 (the round times out), §10.4 (the dispute panel) and §10.8; the build plan's
// errata override it where they differ (stake-attestation/docs/BUILD_PLAN.md):
//   - E2: a dispute request is cids = [disputeCid, the claim's bcid, up to 8 prior valid
//     bcids] and the addendum is the E1 disclosure line, a LF, and "verdikta-dispute:
//     <statementCid>"; the statement is pinned, never inline.
//   - E6 (owner decision Q12): the bond follows the round. A round the arbiters ran that
//     settled no verdict leaves the claim re-triggerable with a fresh prepay inside a bounded
//     window; if no round settles before expiry the bond goes to the maker; it comes back only
//     when the aggregator refused to start every attempt. This supersedes §12's "expires the
//     claim with the bond returned" and the catalogue's wording of
//     payment-round-timeout-retrigger.
// The re-trigger window is the claim's revealWindow from its FIRST failure (a re-triggered
// round that fails again does not extend it), so a failed claim holds the head of the
// commit-order queue for at most revealWindow plus one round.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");
const { linkedFactory } = require("./helpers/linked");

const {
  ListingState, Outcome, ClaimState, Expiry, DisputeResult, DISPUTE, REVEAL,
  LISTING_CID, DISPUTE_CID, CT_CID, BCID, JUSTIFICATION, STATEMENT_CID, ARCHIVE, CT, CK, EK,
  TOP, AWARDS, BOND, ORACLE, FEE, DISPUTE_FEE, V,
  params, freshCommit, atCommit, deploy, eventsOf, blockTime,
  openListing, claimAs, revealAs, revealedClaim, judgeAs, afterDisputeWindow, disputeAs, judgeDisputeAs,
} = H;
const { ZeroHash, ZeroAddress } = ethers;

const JUSTIFICATION_2 = "bafkreidisputejustificationxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
// A distinct, valid CIDv0-shaped string per claim.
const cidOf = (i) => `Qm${"D".repeat(42)}${String(i).padStart(2, "0")}`;
const MALFORMED = [500000n, 500000n]; // a completed result that is no verdict (two outcomes)

async function snapshot() {
  return network.provider.send("evm_snapshot");
}
async function restore(id) {
  await network.provider.send("evm_revert", [id]);
}
const balanceOf = (a) => ethers.provider.getBalance(a.target ?? a.address ?? a);

async function deployWithHarness() {
  const f = await deploy();
  const args = [f.aggregator.target, f.owner.address, f.feeRecipient.address, H.LISTING_FEE];
  const d = await (await linkedFactory("StakeAttestationHarness")).deploy(...args);
  return { ...f, harness: new ethers.Contract(d.target, H.mergedAbi("StakeAttestationHarness"), f.owner) };
}

// One claim revealed and judged `vector` on `listingId`.
async function judgedClaim(sa, aggregator, hunter, listingId, vector, opts = {}) {
  const { claimId, requestId } = await revealedClaim(sa, hunter, listingId, opts);
  const { at } = await judgeAs(sa, aggregator, hunter, claimId, vector);
  return { claimId, requestId, judgedAt: at };
}

// One claim on `listingId` whose round failed `how`: "timeout" (a round the arbiters ran that
// settled no verdict), "malformed" (a completed result that is no verdict) or "refused" (the
// aggregator refused the submission). Returns the failure's time.
async function failedClaim(sa, aggregator, hunter, listingId, how, opts = {}) {
  const { claimId } = await claimAs(sa, hunter, listingId, opts);
  if (how === "refused") {
    await aggregator.setPaused(true);
    const { rc } = await revealAs(sa, hunter, claimId, opts);
    await aggregator.setPaused(false);
    expect(eventsOf(sa, rc, "SubmissionFailed")).to.have.length(1);
    return { claimId, requestId: ZeroHash, failedAt: await blockTime(rc) };
  }
  const { requestId } = await revealAs(sa, hunter, claimId, opts);
  if (how === "timeout") await time.increase(300); // the mock's response timeout
  else await aggregator.scriptResult(requestId, MALFORMED, JUSTIFICATION);
  const rc = await (await sa.finalize(claimId)).wait();
  expect(eventsOf(sa, rc, "EvaluationFailed")).to.have.length(1);
  return { claimId, requestId, failedAt: await blockTime(rc) };
}

// One claim committed at the quoted price and revealed with `extra` wei above the live fee, so
// its round's leftover is distinct (revealedClaim would pass `value` to the commit as well).
async function overpaidClaim(sa, hunter, listingId, extra, opts = {}) {
  const { claimId } = await claimAs(sa, hunter, listingId, opts);
  const { requestId } = await revealAs(sa, hunter, claimId, { ...opts, value: extra });
  return { claimId, requestId };
}

// The round a re-trigger starts times out at the aggregator; finalize records the failure.
async function failAgain(sa, claimId) {
  await time.increase(300);
  await sa.finalize(claimId);
  expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
}

async function retriggerAs(sa, hunter, claimId, { value, gasLimit } = {}) {
  const v = value === undefined ? await sa.retriggerTopUp(claimId) : value;
  const rc = await (await sa.connect(hunter).retrigger(claimId, { value: v, ...(gasLimit ? { gasLimit } : {}) })).wait();
  const ev = eventsOf(sa, rc, "EvaluationRequested")[0];
  return { rc, requestId: ev ? ev.args.requestId : ZeroHash, wallet: ev ? ev.args.wallet : ZeroAddress };
}

describe("StakeAttestation: disputes, failed rounds, re-trigger and leftover recovery (P2d)", function () {
  // ------------------------------------------------------------------ dispute
  describe("dispute() (design §13.2, erratum E2)", function () {
    it("is the maker's, once, on a Judged claim with a valid outcome, inside disputeWindow from judgedAt", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const dispute = (who, claimId, opts = {}) =>
        sa.connect(who).dispute(claimId, opts.cid ?? STATEMENT_CID, { value: opts.value ?? DISPUTE_FEE });

      const { claimId } = await claimAs(sa, hunters[0], id);
      await expect(dispute(maker, claimId)).to.be.revertedWith("not judged"); // committed
      await revealAs(sa, hunters[0], claimId);
      await expect(dispute(maker, claimId)).to.be.revertedWith("not judged"); // revealed
      await judgeAs(sa, aggregator, hunters[0], claimId, V.HIGH);
      const { judgedAt } = await sa.getClaim(claimId);

      await expect(dispute(other, claimId)).to.be.revertedWith("not maker");
      await expect(dispute(hunters[0], claimId)).to.be.revertedWith("not maker");
      await expect(dispute(maker, 99n)).to.be.revertedWith("bad claimId");
      // erratum E2: the statement is pinned and passed by CID; text is refused.
      for (const bad of ["the PoC asserts intended behaviour", "Qm" + "x".repeat(10), "Qm" + "x".repeat(99), `${STATEMENT_CID}:x`, `${STATEMENT_CID},x`, ""]) {
        await expect(dispute(maker, claimId, { cid: bad }), bad).to.be.revertedWith("bad statementCid");
      }
      await expect(dispute(maker, claimId, { value: DISPUTE_FEE - 1n })).to.be.revertedWith("prepay below fee");

      // The window is half-open: open one second before its end, over at it.
      const snap = await snapshot();
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(dispute(maker, claimId)).to.be.revertedWith("dispute window over");
      await restore(snap);
      await time.setNextBlockTimestamp(judgedAt + DISPUTE - 1n);
      await expect(dispute(maker, claimId)).to.emit(sa, "Disputed");

      // Once: not while the dispute is open, and not after it ended, even inside the window.
      await expect(dispute(maker, claimId)).to.be.revertedWith("not judged");
      await judgeDisputeAs(sa, aggregator, other, claimId, V.HIGH);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
      await expect(dispute(maker, claimId)).to.be.revertedWith("already disputed");
      await sa.settle(claimId);
      await expect(dispute(maker, claimId)).to.be.revertedWith("not judged"); // settled

      // INVALID and DUPLICATE are not disputable (they settle at once, design decision D5);
      // a failed round is not judged.
      for (const [vector, label] of [[V.INVALID, "INVALID"], [V.DUPLICATE, "DUPLICATE"]]) {
        const l2 = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
        const j = await judgedClaim(sa, aggregator, hunters[1], l2, vector);
        await expect(dispute(maker, j.claimId), label).to.be.revertedWith("not a valid outcome");
      }
      const l3 = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const f = await failedClaim(sa, aggregator, hunters[2], l3, "timeout");
      await expect(dispute(maker, f.claimId)).to.be.revertedWith("not judged");
    });

    it("pays the live dispute maxTotalFee through its own EvaluationWallet clone, whose funder is the maker", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, requestId: claimRequest } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      expect(await sa.disputeFee(id)).to.equal(DISPUTE_FEE);

      const tx = sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE });
      await expect(tx).to.changeEtherBalances([maker, sa, aggregator], [-DISPUTE_FEE, 0n, DISPUTE_FEE]);
      const rc = await (await tx).wait();
      const [ev] = eventsOf(sa, rc, "Disputed");
      const { wallet, requestId } = ev.args;
      expect(ev.args.claimId).to.equal(claimId);
      expect(ev.args.listingId).to.equal(id);
      expect(ev.args.statementCid).to.equal(STATEMENT_CID);
      expect(ev.args.prepayWei).to.equal(DISPUTE_FEE);
      expect(requestId).to.not.equal(claimRequest);

      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Disputed);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Disputed);
      expect(c.dispute).to.equal(DisputeResult.Pending);
      expect(c.disputedOutcome).to.equal(Outcome.HIGH);
      expect(c.disputedAt).to.equal(await blockTime(rc));
      expect(c.disputeWallet).to.equal(wallet);
      expect(c.disputeRequestId).to.equal(requestId);
      // The first verdict is untouched until the dispute round is read.
      expect(c.outcome).to.equal(Outcome.HIGH);
      expect([...c.vector]).to.deep.equal(V.HIGH.map(BigInt));
      expect((await sa.getListing(id)).disputesFiled).to.equal(1n);

      // Its own wallet: a fresh clone, never the claim round's, funded by the maker.
      expect(wallet).to.not.equal(c.evalWallet);
      expect(ethers.keccak256(await ethers.provider.getCode(wallet))).to.equal(await sa.walletCodehash());
      expect([...(await sa.walletInfo(wallet))]).to.deep.equal([maker.address, claimId]);
      expect([...(await sa.walletInfo(c.evalWallet))]).to.deep.equal([hunter.address, claimId]);
      expect(await aggregator.ethReceived(requestId)).to.equal(DISPUTE_FEE);

      // The dispute panel's fee, with the listing's other oracle settings (design §10.4).
      const p = await aggregator.requestParams(requestId);
      expect(p.maxFee).to.equal(ORACLE.disputeMaxOracleFee);
      expect(p.requestedClass).to.equal(ORACLE.requestedClass);
      expect(p.alpha).to.equal(ORACLE.alpha);
      expect(p.estimatedBaseCost).to.equal(ORACLE.estimatedBaseCost);
      expect(p.maxFeeBasedScaling).to.equal(ORACLE.maxFeeBasedScaling);
    });

    it("the fee is live (erratum E3): it follows the aggregator's multiplier and ceiling; more is accepted and funds the request", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const a = await judgedClaim(sa, aggregator, hunters[0], id, V.HIGH);
      await aggregator.setFeeMultiplier(4n);
      expect(await sa.disputeFee(id)).to.equal(ORACLE.disputeMaxOracleFee * 4n);
      await expect(sa.connect(maker).dispute(a.claimId, STATEMENT_CID, { value: DISPUTE_FEE })).to.be.revertedWith("prepay below fee");
      const { requestId } = await disputeAs(sa, maker, a.claimId, { value: ORACLE.disputeMaxOracleFee * 4n + 999n });
      expect(await aggregator.ethReceived(requestId)).to.equal(ORACLE.disputeMaxOracleFee * 4n + 999n);
      await judgeDisputeAs(sa, aggregator, maker, a.claimId, V.HIGH);
      await sa.settle(a.claimId);

      // A ceiling below the panel's fee clamps it, and the base cost stays below the fee.
      await aggregator.setFeeMultiplier(3n);
      const ceiling = ORACLE.estimatedBaseCost; // at the base cost: the base must drop below it
      await aggregator.setMaxOracleFee(ceiling);
      expect(await sa.disputeFee(id)).to.equal(ceiling * 3n);
      const b = await judgedClaim(sa, aggregator, hunters[1], id, V.MEDIUM, { bcid: cidOf(2) });
      const d = await disputeAs(sa, maker, b.claimId);
      const p = await aggregator.requestParams(d.requestId);
      expect(p.maxFee).to.equal(ceiling);
      expect(p.estimatedBaseCost).to.equal(ceiling - 1n);
    });

    it("the request: cids = [disputeCid, the claim's bcid, the 8 most recent prior valid bcids]; the addendum is the E1 line, LF, the E2 line, byte for byte as common formats them", async function () {
      const { harness: sa, aggregator, maker, hunter } = await loadFixture(deployWithHarness);
      const id = await openListing(sa, maker);
      const priors = [];
      for (let i = 1; i <= 9; i++) {
        const { claimId } = await claimAs(sa, hunter, id);
        await revealAs(sa, hunter, claimId, { bcid: cidOf(i) });
        await sa.harnessResolve(claimId); // P2c: settled
        await sa.harnessAddValidFinding(id, claimId); // P2c: valid
        priors.push(cidOf(i));
      }
      const { claimId, requestId: claimRequest } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      const { requestId } = await disputeAs(sa, maker, claimId);

      const cids = [...(await aggregator.getRequestCids(requestId))];
      expect(cids).to.deep.equal([DISPUTE_CID, BCID, ...priors.slice(1)]);
      expect(cids.length).to.equal(Number(await aggregator.MAX_CID_COUNT()));
      // The same claim and prior findings the claim's own round carried, behind the dispute archive.
      expect([...(await aggregator.getRequestCids(claimRequest))]).to.deep.equal([LISTING_CID, ...cids.slice(1)]);

      const addendum = (await aggregator.requestParams(requestId)).addendum;
      const disclosure = { archiveSha256: ARCHIVE, ciphertextSha256: CT, ciphertextCid: CT_CID, contentKey: CK, ephemeralKey: EK };
      const want = codeReview.formatAddendum({ disclosure, dispute: { statementCid: STATEMENT_CID } });
      expect(addendum).to.equal(want);
      expect(Buffer.from(addendum, "utf8").equals(Buffer.from(want, "utf8"))).to.equal(true);
      expect(addendum).to.equal(`${codeReview.formatDisclosureLine(disclosure)}\n${codeReview.formatDisputeLine(STATEMENT_CID)}`);
      // The first line is the reveal's line: the arbiters re-run the disclosure gate.
      const [line1, line2, ...rest] = addendum.split("\n");
      expect(rest).to.deep.equal([]);
      expect(line1).to.equal((await aggregator.requestParams(claimRequest)).addendum);
      expect(line2).to.equal(`verdikta-dispute: ${STATEMENT_CID}`);
      const parsed = codeReview.parseAddendum(addendum);
      expect(parsed.ok).to.equal(true);
      expect(parsed.disclosure).to.deep.equal(disclosure);
      expect(parsed.dispute).to.deep.equal({ statementCid: STATEMENT_CID });
      expect(codeReview.stripAddendum(addendum).text).to.equal(""); // nothing for a model to read
    });

    it("the longest dispute addendum (100-character CIDs) is 476 bytes, inside the aggregator's 1,000", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const ctCid = "Qm" + "Z".repeat(98);
      const statementCid = "b" + "7".repeat(99);
      const { claimId } = await revealedClaim(sa, hunter, id, { cid: ctCid });
      await judgeAs(sa, aggregator, hunter, claimId, V.CRITICAL);
      const { requestId } = await disputeAs(sa, maker, claimId, { statementCid });
      const addendum = (await aggregator.requestParams(requestId)).addendum;
      expect(addendum.length).to.equal(476);
      expect(addendum.length).to.be.at.most(Number(await aggregator.MAX_ADDENDUM_LENGTH()));
      expect(codeReview.parseAddendum(addendum).dispute).to.deep.equal({ statementCid });
    });

    it("a refused dispute submission reverts the dispute: nothing is recorded, and the maker may try again inside the window", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      await aggregator.setPaused(true);
      await expect(sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE }))
        .to.be.revertedWithCustomError(aggregator, "EnforcedPause");
      // Too little gas for the request reverts the whole dispute too: no gas limit enters a state.
      await aggregator.setPaused(false);
      await aggregator.setRequestGasCost(3_000_000n);
      await expect(sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE, gasLimit: 1_500_000n })).to.be.reverted;
      let c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Judged);
      expect(c.dispute).to.equal(DisputeResult.None);
      expect((await sa.getListing(id)).disputesFiled).to.equal(0n);
      await expect(sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE })).to.emit(sa, "Disputed");
      c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Disputed);
    });
  });

  // ------------------------------------------------------------------ the dispute round
  describe("the dispute round: the second finalize is final", function () {
    it("anyone finalizes it; its verdict replaces the first and settles at once, with no second dispute window", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, judgedAt } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      const { requestId } = await disputeAs(sa, maker, claimId);
      await expect(sa.settle(claimId)).to.be.revertedWith("not judged"); // Disputed waits for its round
      await expect(sa.finalize(claimId)).to.be.revertedWith("evaluation not ready");
      expect(await sa.settleableAt(claimId)).to.equal(0n);

      await aggregator.scriptResult(requestId, V.MEDIUM, JUSTIFICATION_2);
      const tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.emit(sa, "DisputeJudged")
        .withArgs(claimId, id, DisputeResult.Overturned, Outcome.MEDIUM, V.MEDIUM, JUSTIFICATION_2);
      await expect(tx).to.not.emit(sa, "Judged");
      const endedAt = await blockTime(await (await tx).wait());
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Judged);
      expect(c.outcome).to.equal(Outcome.MEDIUM);
      expect([...c.vector]).to.deep.equal(V.MEDIUM.map(BigInt));
      expect(c.disputedOutcome).to.equal(Outcome.HIGH); // the record keeps what was disputed
      expect(c.dispute).to.equal(DisputeResult.Overturned);
      expect(c.disputeEndedAt).to.equal(endedAt);
      expect(c.judgedAt).to.equal(judgedAt); // the first verdict's time stays on the record
      expect(c.requestId).to.not.equal(requestId);
      expect(await sa.settleableAt(claimId)).to.equal(endedAt);
      expect(await sa.disputeDeadline(claimId)).to.equal(0n);
      const l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.disputesOverturned, l.disputesNoVerdict]).to.deep.equal([1n, 0n, 1n, 0n]);
      await expect(sa.finalize(claimId)).to.be.revertedWith("not revealed");

      // Settle at once, well inside the first dispute window.
      expect(BigInt(await time.latest())).to.be.lessThan(judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(claimId)).to.emit(sa, "Settled")
        .withArgs(claimId, id, hunter.address, Outcome.MEDIUM, AWARDS[1], 0n);
    });

    it("a failed dispute round (timed out, or a result that is no verdict) leaves the first verdict standing, and settle proceeds at once", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      for (const how of ["timeout", "malformed"]) {
        const snap = await snapshot();
        const { requestId } = await disputeAs(sa, maker, claimId);
        if (how === "timeout") await time.increase(300);
        else await aggregator.scriptResult(requestId, [0n, 0n, 0n, 0n, 0n, 999_000n], JUSTIFICATION_2); // a sum short of a verdict
        const tx = sa.connect(other).finalize(claimId);
        await expect(tx, how).to.emit(sa, "DisputeFailed").withArgs(claimId, id, requestId, how === "malformed");
        await expect(tx).to.not.emit(sa, "DisputeJudged");
        const endedAt = await blockTime(await (await tx).wait());
        const c = await sa.getClaim(claimId);
        expect(c.state, how).to.equal(ClaimState.Judged);
        expect(c.dispute).to.equal(DisputeResult.NoVerdict);
        expect(c.outcome).to.equal(Outcome.HIGH);
        expect([...c.vector]).to.deep.equal(V.HIGH.map(BigInt));
        expect(c.disputeEndedAt).to.equal(endedAt);
        expect((await sa.getListing(id)).disputesNoVerdict).to.equal(1n);
        await expect(sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE })).to.be.revertedWith("already disputed");
        const settle = sa.connect(other).settle(claimId);
        await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, AWARDS[2], 0n);
        await expect(settle).to.changeEtherBalance(hunter, AWARDS[2] + BOND);
        await restore(snap);
      }
    });

    it("dispute-flips: the maker escalates a valid verdict inside disputeWindowHours and the panel returns INVALID or a lower class; its outcome is final and payout and bond follow it; a flip to INVALID forfeits the bond to the maker", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const cases = [
        { first: V.HIGH, panel: V.INVALID, outcome: Outcome.INVALID, payee: "maker", paid: 0n, valid: false },
        { first: V.CRITICAL, panel: V.MEDIUM, outcome: Outcome.MEDIUM, payee: "hunter", paid: AWARDS[1], valid: true },
        { first: V.HIGH, panel: V.DUPLICATE, outcome: Outcome.DUPLICATE, payee: "hunter", paid: 0n, valid: false },
        { first: V.MEDIUM, panel: V.LOW, outcome: Outcome.LOW, payee: "hunter", paid: 0n, valid: true }, // below the counted class
      ];
      for (const k of cases) {
        const snap = await snapshot();
        const { claimId, judgedAt } = await judgedClaim(sa, aggregator, hunter, id, k.first);
        await time.setNextBlockTimestamp(judgedAt + DISPUTE - 1n); // the window's last second
        await disputeAs(sa, maker, claimId);
        await judgeDisputeAs(sa, aggregator, other, claimId, k.panel, JUSTIFICATION_2);
        const c = await sa.getClaim(claimId);
        expect(c.outcome).to.equal(k.outcome);
        expect(c.dispute).to.equal(DisputeResult.Overturned);
        expect((await sa.getListing(id)).disputesOverturned).to.equal(1n);

        const tx = sa.connect(other).settle(claimId);
        const toMaker = k.payee === "maker" ? BOND : 0n;
        const toHunter = k.payee === "hunter" ? BOND + k.paid : 0n;
        await expect(tx).to.changeEtherBalances([maker, hunter, sa], [toMaker, toHunter, -(toMaker + toHunter)]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, k.outcome, k.paid, 0n);
        const l = await sa.getListing(id);
        expect(l.escrowWei).to.equal(TOP - k.paid);
        expect(l.outcomeCounts[Number(k.outcome)]).to.equal(1n);
        expect([...(await sa.validFindings(id))]).to.deep.equal(k.valid ? [claimId] : []);
        await restore(snap);
      }
    });

    it("dispute-holds: the dispute panel confirms the class; the original verdict stands, the maker's escalation prepay is spent, and the record shows a failed dispute", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
      // The maker pays the escalation prepay; the oracles spend all of it (no refund).
      const d = sa.connect(maker).dispute(claimId, STATEMENT_CID, { value: DISPUTE_FEE });
      await expect(d).to.changeEtherBalance(maker, -DISPUTE_FEE);
      const { disputeRequestId } = await sa.getClaim(claimId);
      const panel = [0, 0, 0, 200_000, 500_000, 300_000]; // HIGH and above 800k >= T, CRITICAL alone below
      await aggregator.scriptResult(disputeRequestId, panel, JUSTIFICATION_2);
      const tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.emit(sa, "DisputeJudged").withArgs(claimId, id, DisputeResult.Held, Outcome.HIGH, panel, JUSTIFICATION_2);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, maker.address, 0n);
      await expect(tx).to.changeEtherBalance(maker, 0n); // spent: nothing comes back
      const c = await sa.getClaim(claimId);
      expect(c.outcome).to.equal(Outcome.HIGH);
      expect(c.disputedOutcome).to.equal(Outcome.HIGH);
      expect(c.dispute).to.equal(DisputeResult.Held); // the record's failed dispute
      expect([...c.vector]).to.deep.equal(panel.map(BigInt)); // the final verdict is the panel's
      const l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.disputesOverturned, l.disputesNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
      const settle = sa.connect(other).settle(claimId);
      await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, AWARDS[2], 0n);
      await expect(settle).to.changeEtherBalances([hunter, maker], [AWARDS[2] + BOND, 0n]);
      expect([...(await sa.validFindings(id))]).to.deep.equal([claimId]);
    });

    it("the panel may also find a higher class: its outcome is final either way", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await judgedClaim(sa, aggregator, hunter, id, V.MEDIUM);
      await disputeAs(sa, maker, claimId);
      await expect(judgeDisputeAs(sa, aggregator, maker, claimId, V.CRITICAL)).to.not.be.reverted;
      expect((await sa.getClaim(claimId)).dispute).to.equal(DisputeResult.Overturned);
      await expect(sa.settle(claimId)).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.CRITICAL, TOP, 0n);
    });
  });

  // ------------------------------------------------------------------ failed rounds
  describe("failed rounds and retrigger() (erratum E6)", function () {
    it("retrigger is the hunter's, from the failed-round state only, inside revealWindow from the failure", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const hunter = hunters[0];
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("not failed"); // committed
      const { requestId } = await revealAs(sa, hunter, claimId);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("not failed"); // revealed
      await time.increase(300);
      const rc = await (await sa.finalize(claimId)).wait();
      const failedAt = await blockTime(rc);
      let c = await sa.getClaim(claimId);
      expect(c.failedAt).to.equal(failedAt);
      expect(c.roundStarted).to.equal(true);
      expect(c.requestId).to.equal(requestId);
      expect(await sa.retriggerDeadline(claimId)).to.equal(failedAt + REVEAL);

      await expect(sa.connect(other).retrigger(claimId, { value: FEE })).to.be.revertedWith("not hunter");
      await expect(sa.connect(maker).retrigger(claimId, { value: FEE })).to.be.revertedWith("not hunter");
      await expect(sa.connect(hunter).retrigger(99n, { value: FEE })).to.be.revertedWith("bad claimId");
      // The round that ran spent its prepay: a fresh one is due in full.
      expect(await sa.retriggerTopUp(claimId)).to.equal(FEE);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE - 1n })).to.be.revertedWith("prepay below fee");

      const snap = await snapshot();
      await time.setNextBlockTimestamp(failedAt + REVEAL);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("retrigger window over");
      await restore(snap);
      await time.setNextBlockTimestamp(failedAt + REVEAL - 1n);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.emit(sa, "Retriggered").withArgs(claimId, id);
      c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Revealed);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("not failed");
      await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("not failed"); // judged
    });

    it("after a round that ran and settled no verdict (timed out, or a malformed result): a fresh prepay through a new wallet; the old prepay was spent and its leftover refunded; the claim is judged as usual", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const unspent = FEE / 4n;
      await aggregator.setRefundAmount(unspent);
      for (const how of ["timeout", "malformed"]) {
        const snap = await snapshot();
        const { claimId } = await claimAs(sa, hunter, id);
        const first = await revealAs(sa, hunter, claimId);
        const firstWallet = (await sa.getClaim(claimId)).evalWallet;
        if (how === "timeout") await time.increase(300);
        else await aggregator.scriptResult(first.requestId, MALFORMED, JUSTIFICATION);
        const fin = sa.finalize(claimId);
        await expect(fin).to.emit(sa, "EvaluationFailed").withArgs(claimId, id, first.requestId, how === "malformed");
        await expect(fin).to.changeEtherBalance(hunter, unspent); // the leftover, inline
        const { failedAt } = await sa.getClaim(claimId);

        const tx = sa.connect(hunter).retrigger(claimId, { value: FEE });
        await expect(tx, how).to.changeEtherBalances([hunter, sa, aggregator], [-FEE, 0n, FEE]);
        const rc = await (await tx).wait();
        const [req] = eventsOf(sa, rc, "EvaluationRequested");
        const c = await sa.getClaim(claimId);
        expect(req.args.claimId).to.equal(claimId);
        expect(req.args.wallet).to.equal(c.evalWallet);
        expect(req.args.prepayWei).to.equal(FEE);
        expect(c.state).to.equal(ClaimState.Revealed);
        expect(c.requestId).to.equal(req.args.requestId);
        expect(c.requestId).to.not.equal(first.requestId);
        expect(c.evalWallet).to.not.equal(firstWallet);
        expect([...(await sa.walletInfo(c.evalWallet))]).to.deep.equal([hunter.address, claimId]);
        expect(c.prepayWei).to.equal(FEE);
        expect(c.failedAt).to.equal(failedAt);
        expect(c.revealedAt).to.equal(first.at); // the reveal stands
        // The same request as the reveal's: listing, claim and priors, and the disclosure line.
        expect([...(await aggregator.getRequestCids(c.requestId))]).to.deep.equal([...(await aggregator.getRequestCids(first.requestId))]);
        expect((await aggregator.requestParams(c.requestId)).addendum).to.equal((await aggregator.requestParams(first.requestId)).addendum);

        await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
        await afterDisputeWindow(sa, claimId);
        await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, AWARDS[2] + BOND);
        await restore(snap);
      }
    });

    it("after a refused submission: the held prepay goes into the re-triggered request and msg.value tops it up to the live fee (erratum E3)", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await failedClaim(sa, aggregator, hunter, id, "refused");
      let c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.RoundFailed);
      expect(c.roundStarted).to.equal(false);
      expect(c.prepayWei).to.equal(FEE); // held
      expect(await sa.retriggerTopUp(claimId)).to.equal(0n);
      await aggregator.setFeeMultiplier(4n); // the live fee rose
      const topUp = ORACLE.maxOracleFee * 4n - FEE;
      expect(await sa.retriggerTopUp(claimId)).to.equal(topUp);
      await expect(sa.connect(hunter).retrigger(claimId, { value: topUp - 1n })).to.be.revertedWith("prepay below fee");
      const tx = sa.connect(hunter).retrigger(claimId, { value: topUp });
      await expect(tx).to.changeEtherBalances([hunter, sa, aggregator], [-topUp, -FEE, FEE + topUp]);
      c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Revealed);
      expect(c.roundStarted).to.equal(true);
      expect(c.prepayWei).to.equal(FEE + topUp);
      expect(await aggregator.ethReceived(c.requestId)).to.equal(FEE + topUp);
      expect(await sa.retriggerTopUp(claimId)).to.equal(0n); // not failed
    });

    it("a refused re-trigger holds its prepay again; the window keeps running from the first failure", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, failedAt } = await failedClaim(sa, aggregator, hunter, id, "timeout");
      await time.increase(86_400);
      await aggregator.setPaused(true);
      const tx = sa.connect(hunter).retrigger(claimId, { value: FEE });
      await expect(tx).to.emit(sa, "SubmissionFailed");
      await expect(tx).to.changeEtherBalances([hunter, sa], [-FEE, FEE]);
      let c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.RoundFailed);
      expect(c.requestId).to.equal(ZeroHash);
      expect(c.prepayWei).to.equal(FEE);
      expect(c.roundStarted).to.equal(true); // a round ran before
      expect(c.failedAt).to.equal(failedAt);
      await aggregator.setPaused(false);
      expect(await sa.retriggerTopUp(claimId)).to.equal(0n);
      await retriggerAs(sa, hunter, claimId);
      await failAgain(sa, claimId);
      c = await sa.getClaim(claimId);
      expect(c.failedAt).to.equal(failedAt); // a failed re-trigger does not extend the window
      expect(await sa.retriggerDeadline(claimId)).to.equal(failedAt + REVEAL);
      await time.setNextBlockTimestamp(failedAt + REVEAL);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("retrigger window over");
    });

    it("the re-triggered request gets exactly SUBMISSION_GAS: too little gas reverts the re-trigger instead of leaving it refused", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await failedClaim(sa, aggregator, hunter, id, "timeout");
      await aggregator.setRequestGasCost(3_000_000n);
      await expect(sa.connect(hunter).retrigger(claimId, { value: FEE, gasLimit: 3_300_000n }))
        .to.be.revertedWith("gas below SUBMISSION_GAS_NEEDED");
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
      const estimate = await sa.connect(hunter).retrigger.estimateGas(claimId, { value: FEE });
      await retriggerAs(sa, hunter, claimId, { value: FEE, gasLimit: estimate });
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Revealed);
    });

    it("payment-round-timeout-retrigger (erratum E6, superseding the catalogue's 'bond returned'): too few reveals before the aggregator timeout; the hunter may re-trigger with a fresh prepay inside the window; with no settled round by expiry the bond goes to the maker, and comes back only when every attempt was refused", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);

      // 1. Re-triggered, and the new round settles: the claim proceeds as any judged claim.
      let snap = await snapshot();
      let f = await failedClaim(sa, aggregator, hunter, id, "timeout");
      await retriggerAs(sa, hunter, f.claimId, { value: FEE });
      await judgeAs(sa, aggregator, hunter, f.claimId, V.HIGH);
      await afterDisputeWindow(sa, f.claimId);
      await expect(sa.settle(f.claimId)).to.changeEtherBalances([hunter, maker], [AWARDS[2] + BOND, 0n]);
      await restore(snap);

      // 2. Never re-triggered: anyone expires it at the window's end; the bond goes to the
      //    maker; the round's prepay was spent, so nothing else moves.
      snap = await snapshot();
      f = await failedClaim(sa, aggregator, hunter, id, "timeout");
      await time.setNextBlockTimestamp(f.failedAt + REVEAL);
      let tx = sa.connect(other).expire(f.claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, other, sa], [BOND, 0n, 0n, -BOND]);
      await expect(tx).to.emit(sa, "Expired").withArgs(f.claimId, id, Expiry.RoundsFailed);
      let c = await sa.getClaim(f.claimId);
      expect(c.state).to.equal(ClaimState.Expired);
      expect(c.expiry).to.equal(Expiry.RoundsFailed);
      let l = await sa.getListing(id);
      expect(l.noVerdictClaims).to.equal(1n);
      expect(l.pendingClaims).to.equal(0n);
      expect(l.headClaim).to.equal(0n);
      expect(await aggregator.ethReceived(f.requestId)).to.equal(FEE); // the oracles' (no refund set)
      await restore(snap);

      // 3. Re-triggered and the new round fails too: a round ran, so the bond goes to the maker.
      snap = await snapshot();
      f = await failedClaim(sa, aggregator, hunter, id, "malformed");
      await retriggerAs(sa, hunter, f.claimId, { value: FEE });
      await failAgain(sa, f.claimId);
      await time.setNextBlockTimestamp(f.failedAt + REVEAL);
      tx = sa.connect(other).expire(f.claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, sa], [BOND, 0n, -BOND]);
      await expect(tx).to.emit(sa, "Expired").withArgs(f.claimId, id, Expiry.RoundsFailed);
      await restore(snap);

      // 4. A round ran, then the re-trigger was refused: the bond goes to the maker and the
      //    refused attempt's held prepay back to the hunter.
      snap = await snapshot();
      f = await failedClaim(sa, aggregator, hunter, id, "timeout");
      await aggregator.setPaused(true);
      await sa.connect(hunter).retrigger(f.claimId, { value: FEE + 5n });
      await time.setNextBlockTimestamp(f.failedAt + REVEAL);
      tx = sa.connect(other).expire(f.claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, sa], [BOND, FEE + 5n, -(BOND + FEE + 5n)]);
      await expect(tx).to.emit(sa, "Expired").withArgs(f.claimId, id, Expiry.RoundsFailed);
      await aggregator.setPaused(false);
      await restore(snap);

      // 5. Every attempt refused (the reveal's and a re-trigger's): no round ran, so the bond
      //    and the held prepay go back to the hunter.
      f = await failedClaim(sa, aggregator, hunter, id, "refused");
      await aggregator.setPaused(true);
      await sa.connect(hunter).retrigger(f.claimId, { value: 0n });
      await time.setNextBlockTimestamp(f.failedAt + REVEAL);
      tx = sa.connect(other).expire(f.claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, other, sa], [0n, BOND + FEE, 0n, -(BOND + FEE)]);
      await expect(tx).to.emit(sa, "Expired").withArgs(f.claimId, id, Expiry.SubmissionsRefused);
      c = await sa.getClaim(f.claimId);
      expect(c.expiry).to.equal(Expiry.SubmissionsRefused);
      l = await sa.getListing(id);
      expect(l.noVerdictClaims).to.equal(1n);
      expect(l.unrevealedClaims).to.equal(0n);
    });

    it("who may expire a failed round: anyone, from failedAt + revealWindow, never while the hunter may still re-trigger", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      for (const how of ["timeout", "refused"]) {
        const snap = await snapshot();
        const { claimId, failedAt } = await failedClaim(sa, aggregator, hunter, id, how);
        for (const who of [other, maker, hunter]) {
          await expect(sa.connect(who).expire(claimId), how).to.be.revertedWith("retrigger window open");
        }
        await time.setNextBlockTimestamp(failedAt + REVEAL - 1n);
        await expect(sa.connect(maker).expire(claimId)).to.be.revertedWith("retrigger window open");
        // At the boundary the window is over for both: no second in which both are possible.
        await time.setNextBlockTimestamp(failedAt + REVEAL);
        await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("retrigger window over");
        await time.setNextBlockTimestamp(failedAt + REVEAL);
        await expect(sa.connect(other).expire(claimId)).to.emit(sa, "Expired");
        await expect(sa.connect(other).expire(claimId)).to.be.revertedWith("not committed");
        await restore(snap);
      }
    });

    it("a failed claim keeps its place: the next claim waits until it is re-triggered and settles, or expires; close is refused meanwhile", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId);
      await time.increase(300);
      const rc = await (await sa.finalize(a.claimId)).wait();
      const failedAt = await blockTime(rc);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, CK, EK)).to.be.revertedWith("earlier claim unresolved");
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      expect((await sa.claimTimes(b.claimId)).revealDeadline).to.equal(0n); // its clock waits
      await time.setNextBlockTimestamp(failedAt + REVEAL);
      await sa.expire(a.claimId);
      const l = await sa.getListing(id);
      expect(l.headClaim).to.equal(b.claimId);
      expect(l.headSince).to.equal(failedAt + REVEAL);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, CK, EK, { value: 0n })).to.emit(sa, "Revealed");
    });
  });

  // ------------------------------------------------------------------ leftover recovery
  describe("leftover recovery: each wallet's ethOwed goes to its funder", function () {
    it("inline at finalize: the claim round's to the hunter, the dispute round's to the maker", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const r = FEE / 3n;
      await aggregator.setRefundAmount(r);
      const { claimId, requestId } = await overpaidClaim(sa, hunter, id, 1234n); // prepay FEE + 1234
      await aggregator.scriptResult(requestId, V.HIGH, JUSTIFICATION);
      let tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.changeEtherBalances([hunter, maker, other, sa], [r + 1234n, 0n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, r + 1234n);

      const d = await disputeAs(sa, maker, claimId, { value: DISPUTE_FEE + 777n });
      await aggregator.setRefundAmount(5n);
      await aggregator.scriptResult(d.requestId, V.HIGH, JUSTIFICATION_2);
      tx = sa.connect(other).finalize(claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, other, sa], [5n + 777n, 0n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, maker.address, 5n + 777n);
      expect(await aggregator.ethOwed(d.wallet)).to.equal(0n);
      expect(await balanceOf(d.wallet)).to.equal(0n);
    });

    it("recoverLeftoverEth: anyone, for a wallet whose inline recovery was deferred; pays its funder; refuses an unknown wallet, an open round and nothing to recover; does not swallow the wallet's revert", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const hunter = hunters[0];
      const r = FEE / 2n;
      await aggregator.setRefundAmount(r);
      const { claimId, requestId } = await revealedClaim(sa, hunter, id);
      const wallet = (await sa.getClaim(claimId)).evalWallet;
      await expect(sa.connect(other).recoverLeftoverEth(wallet)).to.be.revertedWith("round open");
      await aggregator.scriptResult(requestId, V.HIGH, JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      await expect(sa.finalize(claimId)).to.emit(sa, "RefundDeferred").withArgs(claimId, wallet);
      expect(await aggregator.ethOwed(wallet)).to.equal(r);
      await expect(sa.connect(other).recoverLeftoverEth(wallet)).to.be.revertedWith("aggregator withdraw disabled");
      await aggregator.setWithdrawBroken(false);
      const tx = sa.connect(other).recoverLeftoverEth(wallet);
      await expect(tx).to.changeEtherBalances([hunter, other, maker, sa], [r, 0n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, r);
      await expect(sa.recoverLeftoverEth(wallet)).to.be.revertedWith("nothing to recover");
      await expect(sa.recoverLeftoverEth(other.address)).to.be.revertedWith("unknown wallet");
      await expect(sa.recoverLeftoverEth(ZeroAddress)).to.be.revertedWith("unknown wallet");
      await expect(sa.recoverLeftoverEth(await sa.walletImplementation())).to.be.revertedWith("unknown wallet");

      // A dispute round's wallet is open until its round is read.
      const d = await disputeAs(sa, maker, claimId);
      await expect(sa.recoverLeftoverEth(d.wallet)).to.be.revertedWith("round open");
      await aggregator.setWithdrawBroken(true);
      await aggregator.scriptResult(d.requestId, V.MEDIUM, JUSTIFICATION_2);
      await expect(sa.finalize(claimId)).to.emit(sa, "RefundDeferred").withArgs(claimId, d.wallet);
      await aggregator.setWithdrawBroken(false);
      await expect(sa.connect(hunters[1]).recoverLeftoverEth(d.wallet)).to.changeEtherBalances([maker, hunter, sa], [r, 0n, 0n]);

      // A refused submission's wallet never held anything.
      await sa.settle(claimId);
      const f = await failedClaim(sa, aggregator, hunters[2], id, "refused");
      await expect(sa.recoverLeftoverEth((await sa.getClaim(f.claimId)).evalWallet)).to.be.revertedWith("nothing to recover");
    });

    it("payment-leftover-recovery: the evaluation cost less than the prepay; the unused part comes back to the hunter through the wallet's ethOwed credit, inline at finalize, or by recoverLeftoverEth when that was deferred", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const unspent = FEE / 3n;
      await aggregator.setRefundAmount(unspent);

      // Inline, as BountyEscrow passes it today: wallet -> withdrawEth -> wallet -> contract -> hunter.
      const a = await overpaidClaim(sa, hunters[0], id, 1000n, { bcid: cidOf(1) });
      const walletA = (await sa.getClaim(a.claimId)).evalWallet;
      await aggregator.scriptResult(a.requestId, V.DUPLICATE, JUSTIFICATION);
      await expect(sa.finalize(a.claimId)).to.changeEtherBalance(hunters[0], unspent + 1000n);
      expect(await aggregator.ethOwed(walletA)).to.equal(0n);
      expect(await balanceOf(walletA)).to.equal(0n);
      await sa.settle(a.claimId);

      // Deferred (a broken aggregator withdrawal), then recovered by anyone.
      const b = await revealedClaim(sa, hunters[1], id, { bcid: cidOf(2) });
      const walletB = (await sa.getClaim(b.claimId)).evalWallet;
      await aggregator.scriptResult(b.requestId, V.HIGH, JUSTIFICATION);
      await aggregator.setWithdrawBurnsGas(true);
      await expect(sa.finalize(b.claimId)).to.emit(sa, "RefundDeferred").withArgs(b.claimId, walletB);
      await aggregator.setWithdrawBurnsGas(false);
      expect(await aggregator.ethOwed(walletB)).to.equal(unspent);
      await expect(sa.connect(other).recoverLeftoverEth(walletB)).to.changeEtherBalance(hunters[1], unspent);
      expect(await aggregator.ethOwed(walletB)).to.equal(0n);

      // ETH that reaches a wallet after its round goes to the same funder.
      await other.sendTransaction({ to: walletB, value: 777n });
      await expect(sa.connect(other).recoverLeftoverEth(walletB)).to.changeEtherBalance(hunters[1], 777n);

      // A funder that refuses ETH is credited on the pull ledger instead.
      await afterDisputeWindow(sa, b.claimId);
      await sa.settle(b.claimId);
      const rejecting = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      const act = (fn, args, value = 0n) => rejecting.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
      await act("commit", [id, ARCHIVE, CT], await sa.commitPrice(id));
      const c = await sa.claimCount();
      await act("disclose", [c, CT_CID]);
      await act("reveal", [c, cidOf(3), CK, EK]);
      await rejecting.setRejecting(true);
      await aggregator.scriptResult((await sa.getClaim(c)).requestId, V.INVALID, JUSTIFICATION);
      await expect(sa.finalize(c)).to.emit(sa, "PaymentDeferred").withArgs(rejecting.target, unspent);
      expect(await sa.withdrawable(rejecting.target)).to.equal(unspent);
    });

    it("two claims' refunds and a dispute's, interleaved: each wallet's leftover reaches its own funder and no one else", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const [hunterA, hunterB] = hunters;
      const l1 = await openListing(sa, maker);
      const l2 = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      // Each round overpays by its own amount, and settles under its own refund setting, so
      // every leftover is distinct: a misrouted one shows.
      const A = await overpaidClaim(sa, hunterA, l1, 1_000n);
      const walletA1 = (await sa.getClaim(A.claimId)).evalWallet;
      const B = await overpaidClaim(sa, hunterB, l2, 2_000n);
      const walletB1 = (await sa.getClaim(B.claimId)).evalWallet;

      await aggregator.setWithdrawBroken(true); // both claim rounds' inline recoveries defer
      await aggregator.setRefundAmount(10n);
      await aggregator.scriptResult(A.requestId, V.HIGH, JUSTIFICATION);
      await expect(sa.finalize(A.claimId)).to.emit(sa, "RefundDeferred").withArgs(A.claimId, walletA1);
      await aggregator.setRefundAmount(20n);
      await time.increase(300);
      await expect(sa.finalize(B.claimId)).to.emit(sa, "RefundDeferred").withArgs(B.claimId, walletB1);
      await aggregator.setWithdrawBroken(false);

      const B2 = await retriggerAs(sa, hunterB, B.claimId, { value: FEE + 3_000n });
      const D = await disputeAs(sa, maker, A.claimId, { value: DISPUTE_FEE + 4_000n });
      expect(new Set([walletA1, walletB1, B2.wallet, D.wallet]).size).to.equal(4);

      const watched = [maker, hunterA, hunterB, other, sa];
      // The dispute round settles first and pays the maker inline.
      await aggregator.setRefundAmount(30n);
      await aggregator.scriptResult(D.requestId, V.HIGH, JUSTIFICATION_2);
      let tx = sa.connect(other).finalize(A.claimId);
      await expect(tx).to.changeEtherBalances(watched, [4_030n, 0n, 0n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(A.claimId, maker.address, 4_030n);
      // B's first wallet, recovered by a third party, pays B.
      tx = sa.connect(other).recoverLeftoverEth(walletB1);
      await expect(tx).to.changeEtherBalances(watched, [0n, 0n, 2_020n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(B.claimId, hunterB.address, 2_020n);
      // B's re-triggered round settles and pays B inline.
      await aggregator.setRefundAmount(40n);
      await aggregator.scriptResult(B2.requestId, V.MEDIUM, JUSTIFICATION);
      tx = sa.connect(other).finalize(B.claimId);
      await expect(tx).to.changeEtherBalances(watched, [0n, 0n, 3_040n, 0n, 0n]);
      // A's first wallet, recovered last, pays A.
      tx = sa.connect(other).recoverLeftoverEth(walletA1);
      await expect(tx).to.changeEtherBalances(watched, [0n, 1_010n, 0n, 0n, 0n]);
      await expect(tx).to.emit(sa, "LeftoverRefunded").withArgs(A.claimId, hunterA.address, 1_010n);

      for (const w of [walletA1, walletB1, B2.wallet, D.wallet]) {
        expect(await aggregator.ethOwed(w)).to.equal(0n);
        expect(await balanceOf(w)).to.equal(0n);
        await expect(sa.recoverLeftoverEth(w)).to.be.revertedWith("nothing to recover");
      }
      expect([...(await sa.walletInfo(walletA1))]).to.deep.equal([hunterA.address, A.claimId]);
      expect([...(await sa.walletInfo(D.wallet))]).to.deep.equal([maker.address, A.claimId]);
      expect([...(await sa.walletInfo(walletB1))]).to.deep.equal([hunterB.address, B.claimId]);
      expect([...(await sa.walletInfo(B2.wallet))]).to.deep.equal([hunterB.address, B.claimId]);
      // The contract holds exactly the two escrows, the two bonds and the fee recipient's fees.
      expect(await balanceOf(sa)).to.equal(2n * TOP + 2n * BOND + 2n * H.LISTING_FEE);
    });

    for (const entry of ["recoverLeftoverEth", "dispute", "retrigger", "finalize"]) {
      it(`re-entering ${entry}() from a leftover refund is refused and the refund lands`, async function () {
        const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
        const reentrant = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
        const act = (fn, args, value = 0n) => reentrant.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
        // The reentrant contract is the maker; its dispute round's leftover is the refund.
        await act("list", [params(), LISTING_CID, DISPUTE_CID, []]);
        const id = await sa.listingCount();
        const fee = await sa.feeDue(id);
        await act("fund", [id, fee], fee + TOP);
        const { claimId } = await judgedClaim(sa, aggregator, hunter, id, V.HIGH);
        await act("dispute", [claimId, STATEMENT_CID], DISPUTE_FEE + 50n);
        const { disputeRequestId, disputeWallet } = await sa.getClaim(claimId);
        await aggregator.scriptResult(disputeRequestId, V.HIGH, JUSTIFICATION_2);
        const args = {
          recoverLeftoverEth: [disputeWallet], dispute: [claimId, STATEMENT_CID], retrigger: [claimId], finalize: [claimId],
        }[entry];
        await reentrant.setAttack(sa.target, sa.interface.encodeFunctionData(entry, args));
        await expect(sa.finalize(claimId)).to.changeEtherBalance(reentrant, 50n);
        expect(await reentrant.attempted()).to.equal(true);
        expect(await reentrant.attackOk()).to.equal(false);
        expect(await reentrant.attackReasonHash()).to.equal(
          ethers.keccak256(sa.interface.encodeErrorResult("Error(string)", ["reentrant"]))
        );
      });
    }
  });

  // ------------------------------------------------------------------ views and events
  describe("views and events", function () {
    it("disputeFee, disputeDeadline, retriggerDeadline, retriggerTopUp and settleableAt (the lens) follow the claim", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      expect(await lens.disputeFee(id)).to.equal(DISPUTE_FEE);
      const { claimId } = await claimAs(sa, hunters[0], id);
      for (const v of ["disputeDeadline", "retriggerDeadline", "retriggerTopUp", "settleableAt"]) {
        expect(await sa[v](claimId), v).to.equal(0n);
      }
      await revealAs(sa, hunters[0], claimId);
      const { at: judgedAt } = await judgeAs(sa, aggregator, hunters[0], claimId, V.HIGH);
      expect(await sa.disputeDeadline(claimId)).to.equal(judgedAt + DISPUTE);
      expect(await lens.disputeDeadline(claimId)).to.equal(judgedAt + DISPUTE);
      expect(await sa.settleableAt(claimId)).to.equal(judgedAt + DISPUTE);
      await disputeAs(sa, maker, claimId);
      expect(await sa.disputeDeadline(claimId)).to.equal(0n);
      expect(await sa.settleableAt(claimId)).to.equal(0n);
      const { at } = await judgeDisputeAs(sa, aggregator, maker, claimId, V.HIGH);
      expect(await sa.disputeDeadline(claimId)).to.equal(0n); // once
      expect(await sa.settleableAt(claimId)).to.equal(at);
      await sa.settle(claimId);

      // An INVALID verdict has no dispute deadline.
      const j = await judgedClaim(sa, aggregator, hunters[1], id, V.INVALID);
      expect(await sa.disputeDeadline(j.claimId)).to.equal(0n);
      await sa.settle(j.claimId);

      const f = await failedClaim(sa, aggregator, hunters[2], id, "refused");
      expect(await sa.retriggerDeadline(f.claimId)).to.equal(f.failedAt + REVEAL);
      expect(await lens.retriggerDeadline(f.claimId)).to.equal(f.failedAt + REVEAL);
      expect(await sa.retriggerTopUp(f.claimId)).to.equal(0n);
      await aggregator.setFeeMultiplier(5n);
      expect(await sa.retriggerTopUp(f.claimId)).to.equal(ORACLE.maxOracleFee * 5n - FEE);
      expect(await lens.retriggerTopUp(f.claimId)).to.equal(ORACLE.maxOracleFee * 5n - FEE);
    });

    it("declares an event for every state change this node adds", async function () {
      const { sa } = await loadFixture(deploy);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of ["Disputed", "DisputeJudged", "DisputeFailed", "Retriggered", "LeftoverRefunded", "RefundDeferred", "Expired"]) {
        expect(events, name).to.include(name);
      }
      expect(sa.interface.getEvent("RefundDeferred").inputs.map((i) => i.name)).to.deep.equal(["claimId", "wallet"]);
      expect(sa.interface.getEvent("LeftoverRefunded").inputs.map((i) => i.name)).to.deep.equal(["claimId", "funder", "amountWei"]);
    });

    it("the listing's state is untouched by disputes and failed rounds; close succeeds once they resolve", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await judgedClaim(sa, aggregator, hunters[0], id, V.CRITICAL);
      await disputeAs(sa, maker, claimId);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await judgeDisputeAs(sa, aggregator, maker, claimId, V.INVALID);
      await sa.settle(claimId);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Open);
      const f = await failedClaim(sa, aggregator, hunters[1], id, "timeout");
      await time.setNextBlockTimestamp(f.failedAt + REVEAL);
      await sa.expire(f.claimId);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed").withArgs(id, maker.address, TOP);
    });
  });
});
