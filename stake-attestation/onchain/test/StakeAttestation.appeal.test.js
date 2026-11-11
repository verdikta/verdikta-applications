// StakeAttestation, the hunter's appeal of an INVALID outcome (build node P16). Design:
// verdikta-arbiter docs/development/stake-attestation-design.md §13.2, "Errata, 2026-11-10 (Q70)"
// (E7 whole, and E8 and E9 where they meet the appeal: "How the three fit together", "What
// changes in the contract") and §18's "Erratum, 2026-11-10 (Q70): contract fixtures", whose E7
// fixtures, E8's appeal fixtures and E9's "the hunter's appeal refused" each have a test here
// named after them. The owner decided the mechanics (Q72) and that an appeal carries no
// statement (2026-11-10): the panel reads the claim as revealed, and its report.md is the
// hunter's argument.
//
//   - appeal(claimId), payable, the hunter's alone, on a claim its claim round left Judged
//     INVALID with no dispute-panel round (dispute None), before judgedAt + disputeWindow. Late
//     claims may appeal. The prepay is at least the live disputeFee, all of it through a fresh
//     EvaluationWallet clone the hunter funds: the hunter bears what the round spends, and gets
//     the rest back. Nothing comes from the escrow or the bond.
//   - The request is the dispute's without the dispute line (the E1 line alone), sent with
//     exactly SUBMISSION_GAS and not caught. Judged -> Disputed (Pending), DisputeKind.Appeal.
//   - The second finalize is final. Held: the bond to the maker, unless the panel's vector is a
//     narrow INVALID (E8). Overturned: the panel's outcome settles at once, a counted class with
//     its award and no confirmation (E9).
//   - A claim round's INVALID waits out the appeal window (the dispute window) before anyone but
//     the hunter may settle it; the hunter settling it waives the appeal. It heads the
//     commit-order queue meanwhile.
//   - An appeal round with no verdict gets one re-trigger, the hunter's, through retrigger, until
//     revealWindow after that round ended, with a fresh full prepay, sent as the appeal is. Until
//     then only the hunter may settle; a second round with no verdict leaves the INVALID standing.
//   - One dispute-panel verdict per claim.
//
// These tests start from deployDefaults (floor THRESHOLD, size 0: every counted award a claim
// round produces waits for a confirmation, so an appeal overturned to one shows it does not).
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");

const {
  ListingState, Outcome, ClaimState, DisputeResult, DisputeKind, DISPUTE, REVEAL, SCALE, T,
  LISTING_CID, DISPUTE_CID, CT_CID, BCID, JUSTIFICATION, ARCHIVE, CT, CK, EK, TOP, AWARDS, BOND,
  ORACLE, DISPUTE_FEE, V, params, freshCommit, atCommit, deployDefaults, eventsOf, blockTime,
  openListing, claimAs, revealAs, revealedClaim, judgeAs, disputeAs, judgeDisputeAs, confirmAs, appealAs,
  lateClaimAs, recordOf, listingIn, outcomesOf, lateOutcomesOf, findingIds,
} = H;

const THRESHOLD = BigInt(T);
const FLOOR = 350_000n;
const DF = DISPUTE_FEE; // what one dispute-panel round costs on the default listing
const MALFORMED = [1n, 2n, 3n]; // a completed result that is no verdict
const cidOf = (i) => `Qm${"A".repeat(42)}${String(i).padStart(2, "0")}`;
// LOW has an award but MEDIUM is the lowest counted, so a LOW finding is published, pays
// nothing and needs no confirmation.
const AWARDS_WITH_LOW = [ethers.parseEther("0.05"), ...AWARDS.slice(1)];

// INVALID with exactly `mass` of valid mass, on MEDIUM (order INVALID, DUPLICATE, LOW..CRITICAL).
const invalidWith = (mass) => [SCALE - Number(mass), 0, 0, Number(mass), 0, 0];

async function snapshot() {
  return network.provider.send("evm_snapshot");
}
async function restore(id) {
  await network.provider.send("evm_revert", [id]);
}
const bigintJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const balanceOf = (a) => ethers.provider.getBalance(a.target ?? a.address ?? a);

// One claim revealed and judged `vector` on `listingId`.
async function judged(sa, aggregator, hunter, listingId, vector, opts = {}) {
  const { claimId, requestId } = await revealedClaim(sa, hunter, listingId, opts);
  const { at } = await judgeAs(sa, aggregator, hunter, claimId, vector);
  return { claimId, requestId, judgedAt: at };
}

// A dispute-panel round (here mostly an appeal's) that settles no verdict: timed out (the mock's
// response timeout) or malformed.
async function failPanelRound(sa, aggregator, claimId, how = "timeout") {
  const { disputeRequestId } = await sa.getClaim(claimId);
  if (how === "timeout") await time.increase(300);
  else await aggregator.scriptResult(disputeRequestId, MALFORMED, JUSTIFICATION);
  const rc = await (await sa.finalize(claimId)).wait();
  expect(eventsOf(sa, rc, "DisputeFailed").map((e) => [e.args.requestId, e.args.malformed]))
    .to.deep.equal([[disputeRequestId, how !== "timeout"]]);
  return { rc, endedAt: await blockTime(rc) };
}

describe("StakeAttestation: the hunter's appeal of an INVALID outcome, erratum E7 (P16)", function () {
  // ------------------------------------------------------------------ appeal()
  describe("appeal(): who, when and what it costs", function () {
    it("is the claim's hunter's, payable, on a claim its claim round left Judged INVALID with no dispute-panel round, before judgedAt + disputeWindow; Judged -> Disputed (Pending), of the Appeal kind", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const hunter = hunters[0];
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.INVALID);
      expect(sa.interface.getFunction("appeal").payable).to.equal(true);
      expect(sa.interface.getFunction("appeal").inputs.map((i) => i.type)).to.deep.equal(["uint256"]); // no statement
      for (const who of [maker, other, hunters[1]]) {
        await expect(sa.connect(who).appeal(claimId, { value: DF }), who.address).to.be.revertedWith("not hunter");
      }
      const snap = await snapshot();
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("appeal window over");
      await restore(snap);

      await time.setNextBlockTimestamp(judgedAt + DISPUTE - 1n);
      const ap = await appealAs(sa, hunter, claimId);
      const ev = eventsOf(sa, ap.rc, "Appealed")[0];
      expect([...ev.args]).to.deep.equal([claimId, id, ap.wallet, ap.requestId, DF]);
      const c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.disputeKind, c.disputedOutcome, c.outcome]).to.deep.equal(
        [ClaimState.Disputed, DisputeResult.Pending, DisputeKind.Appeal, Outcome.INVALID, Outcome.INVALID],
      );
      expect([c.disputeWallet, c.disputeRequestId, c.disputedAt, c.disputeEndedAt]).to.deep.equal([ap.wallet, ap.requestId, ap.at, 0n]);
      expect(c.appealRetriggered).to.equal(false);
      const l = await sa.getListing(id);
      expect([l.appealsFiled, l.disputesFiled, l.confirmationRounds, l.lateAppealsFiled]).to.deep.equal([1n, 0n, 0n, 0n]);
      // Its round is open: settle waits for its finalize, and no second appeal.
      await expect(sa.connect(hunter).settle(claimId)).to.be.revertedWith("not judged");
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("not judged");
    });

    it("refused on a claim that is not Judged (committed, revealed, settled), and on an unknown claim", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("not judged");
      await revealAs(sa, hunter, claimId);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("not judged");
      await judgeAs(sa, aggregator, hunter, claimId, V.INVALID);
      await sa.connect(hunter).settle(claimId); // the waiver
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("not judged");
      await expect(sa.connect(hunter).appeal(99n, { value: DF })).to.be.revertedWith("bad claimId");
    });

    it("msg.value is at least the live disputeFee, and all of it goes through a fresh EvaluationWallet clone whose funder is the hunter; nothing comes from the escrow or the bond", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId, requestId: roundId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const roundWallet = (await sa.getClaim(claimId)).evalWallet;
      await expect(sa.connect(hunter).appeal(claimId, { value: DF - 1n })).to.be.revertedWith("prepay below fee");
      // The fee is live: it follows the aggregator's multiplier, as disputeFee quotes it.
      await aggregator.setFeeMultiplier(5n);
      const live = await sa.disputeFee(id);
      expect(live).to.equal(ORACLE.disputeMaxOracleFee * 5n);
      await expect(sa.connect(hunter).appeal(claimId, { value: live - 1n })).to.be.revertedWith("prepay below fee");
      const snap = await snapshot();
      await aggregator.setFeeMultiplier(0n);
      await expect(sa.connect(hunter).appeal(claimId, { value: live })).to.be.revertedWith("bad budget");
      await restore(snap);

      const escrow = (await sa.getListing(id)).escrowWei;
      const value = live + 1234n;
      const tx = sa.connect(hunter).appeal(claimId, { value });
      // The contract keeps none of it: the whole msg.value goes to the request.
      await expect(tx).to.changeEtherBalances([hunter, sa], [-value, 0n]);
      const ev = eventsOf(sa, await (await tx).wait(), "Appealed")[0];
      expect(ev.args.prepayWei).to.equal(value);
      expect(await aggregator.ethReceived(ev.args.requestId)).to.equal(value);
      expect(ev.args.wallet).to.not.equal(roundWallet);
      expect(ev.args.requestId).to.not.equal(roundId);
      expect([...(await sa.walletInfo(ev.args.wallet))]).to.deep.equal([hunter.address, claimId]);
      const c = await sa.getClaim(claimId);
      expect([c.bondWei, c.evalWallet]).to.deep.equal([BOND, roundWallet]); // the bond is held, the round's wallet kept
      expect((await sa.getListing(id)).escrowWei).to.equal(escrow);
      expect(await balanceOf(sa)).to.equal(escrow + BOND + H.LISTING_FEE);
    });

    it("the round's unspent prepay comes back to the hunter at finalize, or by recoverLeftoverEth when that was deferred; recovery is refused while the round is open", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      // Inline at finalize.
      const a = await judged(sa, aggregator, hunters[0], id, V.INVALID);
      const leftover = DF / 3n;
      await aggregator.setRefundAmount(leftover);
      const apA = await appealAs(sa, hunters[0], a.claimId, { value: DF + 7n });
      await expect(sa.connect(other).recoverLeftoverEth(apA.wallet)).to.be.revertedWith("round open");
      await aggregator.scriptResult(apA.requestId, V.INVALID, JUSTIFICATION);
      const fin = sa.connect(other).finalize(a.claimId);
      await expect(fin).to.emit(sa, "LeftoverRefunded").withArgs(a.claimId, hunters[0].address, leftover + 7n);
      await expect(fin).to.changeEtherBalances([hunters[0], maker, other], [leftover + 7n, 0n, 0n]);
      await sa.connect(other).settle(a.claimId);

      // Deferred, then recovered by anyone, to the hunter.
      const b = await judged(sa, aggregator, hunters[1], id, V.INVALID);
      const apB = await appealAs(sa, hunters[1], b.claimId);
      await aggregator.scriptResult(apB.requestId, V.HIGH, JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      await expect(sa.connect(other).finalize(b.claimId)).to.emit(sa, "RefundDeferred").withArgs(b.claimId, apB.wallet);
      await aggregator.setWithdrawBroken(false);
      const rec = sa.connect(other).recoverLeftoverEth(apB.wallet);
      await expect(rec).to.emit(sa, "LeftoverRefunded").withArgs(b.claimId, hunters[1].address, leftover);
      await expect(rec).to.changeEtherBalances([hunters[1], maker, other], [leftover, 0n, 0n]);
      await expect(rec).to.not.emit(sa, "ConfirmationRefunded");
      await expect(sa.recoverLeftoverEth(apB.wallet)).to.be.revertedWith("nothing to recover");
    });

    it("the request is the dispute's without the dispute line: cids = [disputeCid, the claim's bcid, the prior findings its round carried], the E1 line alone (no statement), the dispute panel's fee and settings", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params({ awards: AWARDS_WITH_LOW }), { escrow: 2n * TOP });
      // A prior valid finding: LOW, published, below the counted class.
      const prior = await judged(sa, aggregator, hunters[0], id, V.LOW, { bcid: cidOf(1) });
      await time.setNextBlockTimestamp(prior.judgedAt + DISPUTE);
      await sa.settle(prior.claimId);
      const { claimId, requestId: roundId } = await judged(sa, aggregator, hunters[1], id, V.INVALID, { bcid: cidOf(2) });
      const { requestId } = await appealAs(sa, hunters[1], claimId);
      expect([...(await aggregator.getRequestCids(requestId))]).to.deep.equal([DISPUTE_CID, cidOf(2), cidOf(1)]);
      expect([...(await aggregator.getRequestCids(roundId))]).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
      const p = await aggregator.requestParams(requestId);
      const round = await aggregator.requestParams(roundId);
      const disclosure = { archiveSha256: ARCHIVE, ciphertextSha256: CT, ciphertextCid: CT_CID, contentKey: CK, ephemeralKey: EK };
      expect(p.addendum).to.equal(round.addendum); // the claim round's E1 line, byte for byte
      expect(p.addendum).to.equal(codeReview.formatDisclosureLine(disclosure));
      expect(p.addendum).to.not.include("\n");
      expect(p.addendum).to.not.include("verdikta-dispute");
      const parsed = codeReview.parseAddendum(p.addendum);
      expect(parsed.ok).to.equal(true);
      expect(parsed.disclosure).to.deep.equal(disclosure);
      expect(parsed.dispute ?? null).to.equal(null);
      expect([p.maxFee, p.requestedClass, p.alpha, p.estimatedBaseCost, p.maxFeeBasedScaling])
        .to.deep.equal([ORACLE.disputeMaxOracleFee, ORACLE.requestedClass, ORACLE.alpha, ORACLE.estimatedBaseCost, ORACLE.maxFeeBasedScaling]);
      expect(await aggregator.ethReceived(requestId)).to.equal(DF);
    });

    it("a submission the aggregator refuses: appeal reverts, nothing recorded, and a second attempt inside the window goes through; exactly SUBMISSION_GAS, not caught", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const claimBefore = bigintJson(await sa.getClaim(claimId));
      const listingBefore = bigintJson(await sa.getListing(id));
      const balance = await balanceOf(sa);
      await aggregator.setPaused(true);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWithCustomError(aggregator, "EnforcedPause");
      await aggregator.setPaused(false);
      // A request that needs more than SUBMISSION_GAS fails for every caller, as a refusal does.
      await aggregator.setRequestGasCost(11_000_000n);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF, gasLimit: 25_000_000n })).to.be.reverted;
      await aggregator.setRequestGasCost(0n);
      // Too little gas to forward SUBMISSION_GAS reverts before anything is sent.
      await expect(sa.connect(hunter).appeal(claimId, { value: DF, gasLimit: 5_000_000n })).to.be.revertedWith("gas below SUBMISSION_GAS_NEEDED");
      expect(bigintJson(await sa.getClaim(claimId))).to.equal(claimBefore);
      expect(bigintJson(await sa.getListing(id))).to.equal(listingBefore);
      expect(await balanceOf(sa)).to.equal(balance);
      expect(await sa.appealDeadline(claimId)).to.equal(judgedAt + DISPUTE);
      await time.setNextBlockTimestamp(judgedAt + DISPUTE - 1n);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.emit(sa, "Appealed");
      expect((await sa.getListing(id)).appealsFiled).to.equal(1n);
    });

    it("refused: an appeal after judgedAt + disputeWindow; one by anyone but the hunter; one on a DUPLICATE or a valid outcome; a second appeal; an appeal of an INVALID produced by a maker's dispute or a confirmation; a maker's dispute of a valid outcome produced by an appeal; a prepay below disputeFee", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      // After the window, by anyone else, below the fee.
      const a = await judged(sa, aggregator, hunters[0], id, V.INVALID);
      await expect(sa.connect(maker).appeal(a.claimId, { value: DF })).to.be.revertedWith("not hunter");
      await expect(sa.connect(other).appeal(a.claimId, { value: DF })).to.be.revertedWith("not hunter");
      await expect(sa.connect(hunters[0]).appeal(a.claimId, { value: DF - 1n })).to.be.revertedWith("prepay below fee");
      await time.setNextBlockTimestamp(a.judgedAt + DISPUTE);
      await expect(sa.connect(hunters[0]).appeal(a.claimId, { value: DF })).to.be.revertedWith("appeal window over");
      await sa.connect(other).settle(a.claimId);

      // A DUPLICATE (settles at once, as today) and a valid outcome.
      for (const v of [V.DUPLICATE, V.HIGH]) {
        const k = await judged(sa, aggregator, hunters[1], id, v);
        await expect(sa.connect(hunters[1]).appeal(k.claimId, { value: DF }), `${v}`).to.be.revertedWith("not INVALID");
        if (v === V.DUPLICATE) {
          expect(await sa.settleableAt(k.claimId)).to.equal(k.judgedAt);
          await expect(sa.connect(other).settle(k.claimId)).to.emit(sa, "Settled"); // at once, by anyone
        } else {
          // A claim round's valid outcome: the maker's to dispute (here, a flip to INVALID).
          await disputeAs(sa, maker, k.claimId);
          await judgeDisputeAs(sa, aggregator, other, k.claimId, V.INVALID);
          // An INVALID a maker's dispute produced: not appealable, settles at once.
          await expect(sa.connect(hunters[1]).appeal(k.claimId, { value: DF })).to.be.revertedWith("already disputed");
          expect(await sa.appealDeadline(k.claimId)).to.equal(0n);
          await expect(sa.connect(other).settle(k.claimId)).to.changeEtherBalances([hunters[1], maker], [0n, BOND]);
        }
      }

      // An INVALID a confirmation produced (erratum E9's own fixture is below).
      const c = await judged(sa, aggregator, hunters[2], id, V.HIGH);
      await time.setNextBlockTimestamp(c.judgedAt + DISPUTE);
      await confirmAs(sa, other, c.claimId);
      await judgeDisputeAs(sa, aggregator, other, c.claimId, V.INVALID);
      await expect(sa.connect(hunters[2]).appeal(c.claimId, { value: DF })).to.be.revertedWith("already disputed");
      await sa.connect(other).settle(c.claimId);

      // A second appeal, after one held and after one overturned; and the maker's dispute of
      // the valid outcome an appeal produced.
      for (const [panel, result] of [[V.INVALID, DisputeResult.Held], [V.MEDIUM, DisputeResult.Overturned]]) {
        const k = await judged(sa, aggregator, hunters[3], id, V.INVALID);
        await appealAs(sa, hunters[3], k.claimId);
        await judgeDisputeAs(sa, aggregator, other, k.claimId, panel);
        expect((await sa.getClaim(k.claimId)).dispute).to.equal(result);
        await expect(sa.connect(hunters[3]).appeal(k.claimId, { value: DF })).to.be.revertedWith("already disputed");
        await expect(sa.connect(hunters[3]).retrigger(k.claimId, { value: DF })).to.be.revertedWith("not failed");
        if (result === DisputeResult.Overturned) {
          await expect(sa.connect(maker).dispute(k.claimId, H.STATEMENT_CID, { value: DF })).to.be.revertedWith("already disputed");
          expect(await sa.disputeDeadline(k.claimId)).to.equal(0n);
          await expect(sa.connect(other).confirm(k.claimId)).to.be.revertedWith("no confirmation due");
        }
        await sa.connect(other).settle(k.claimId);
      }
      const l = await sa.getListing(id);
      expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal([2n, 1n, 1n, 0n]);
      expect([l.disputesFiled, l.confirmationRounds]).to.deep.equal([1n, 1n]);
    });

    it("re-entering appeal() from a leftover refund is refused and the refund lands", async function () {
      const { sa, aggregator, maker } = await loadFixture(deployDefaults);
      const reentrant = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
      const act = (fn, args, value = 0n) => reentrant.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
      // The reentrant contract is the hunter; its claim round's leftover is the refund.
      const id = await openListing(sa, maker);
      await act("commit", [id, ARCHIVE, CT], (await sa.commitPrice(id)) + 50n);
      const claimId = await sa.claimCount();
      await act("disclose", [claimId, CT_CID]);
      await act("reveal", [claimId, BCID, CK, EK]);
      const { requestId } = await sa.getClaim(claimId);
      await aggregator.scriptResult(requestId, V.INVALID, JUSTIFICATION);
      await reentrant.setAttack(sa.target, sa.interface.encodeFunctionData("appeal", [claimId]));
      await expect(sa.finalize(claimId)).to.changeEtherBalance(reentrant, 50n);
      expect(await reentrant.attempted()).to.equal(true);
      expect(await reentrant.attackOk()).to.equal(false);
      expect(await reentrant.attackReasonHash()).to.equal(
        ethers.keccak256(sa.interface.encodeErrorResult("Error(string)", ["reentrant"])),
      );
      expect((await sa.getClaim(claimId)).dispute).to.equal(DisputeResult.None);
    });
  });

  // ------------------------------------------------------------------ the INVALID wait
  describe("a claim round's INVALID waits out the appeal window (decision D5 as E7 amends it)", function () {
    it("settle of a claim-round INVALID before the window ends: refused for the maker and a third party, accepted from the hunter (the waiver); the next claim's reveal waits until it settles, and close is refused meanwhile", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId);
      const { at: judgedAt } = await judgeAs(sa, aggregator, other, a.claimId, V.INVALID);
      expect(await sa.settleableAt(a.claimId)).to.equal(judgedAt + DISPUTE);
      expect(await sa.appealDeadline(a.claimId)).to.equal(judgedAt + DISPUTE);
      for (const who of [maker, other, hunters[1]]) {
        await expect(sa.connect(who).settle(a.claimId), who.address).to.be.revertedWith("appeal window open");
      }
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, CK, EK)).to.be.revertedWith("earlier claim unresolved");
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await time.setNextBlockTimestamp(judgedAt + DISPUTE - 2n);
      await expect(sa.connect(other).settle(a.claimId)).to.be.revertedWith("appeal window open");

      // The waiver: the hunter settles inside the window, and the appeal is gone with it.
      const snap = await snapshot();
      const waiver = sa.connect(hunters[0]).settle(a.claimId);
      await expect(waiver).to.emit(sa, "Settled").withArgs(a.claimId, id, hunters[0].address, Outcome.INVALID, 0n, 0n);
      await expect(waiver).to.changeEtherBalances([hunters[0], maker], [0n, BOND]);
      await expect(sa.connect(hunters[0]).appeal(a.claimId, { value: DF })).to.be.revertedWith("not judged");
      await revealAs(sa, hunters[1], b.claimId);
      await restore(snap);

      // From the window's end, anyone.
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(a.claimId)).to.changeEtherBalances([hunters[0], maker], [0n, BOND]);
      await revealAs(sa, hunters[1], b.claimId);
      expect(await sa.settleableAt(a.claimId)).to.equal(0n);
    });

    it("a DUPLICATE is not appealable and settles at once, as today", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.DUPLICATE);
      expect(await sa.appealDeadline(claimId)).to.equal(0n);
      expect(await sa.settleableAt(claimId)).to.equal(judgedAt);
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("not INVALID");
      await expect(sa.connect(other).settle(claimId)).to.changeEtherBalances([hunter, maker], [BOND, 0n]);
    });
  });

  // ------------------------------------------------------------------ upheld or overturned
  describe("the second finalize is final: held or overturned", function () {
    it("an INVALID appealed and held: bond to the maker, the appeal's prepay spent and its leftover back to the hunter; overturned to a counted class: the spent prepay is not refunded from the escrow or the bond", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const leftover = DF / 4n;
      await aggregator.setRefundAmount(leftover);
      const ap = await appealAs(sa, hunter, claimId);
      const escrow = (await sa.getListing(id)).escrowWei;

      // Held.
      const snap = await snapshot();
      await aggregator.scriptResult(ap.requestId, V.INVALID.map(BigInt), JUSTIFICATION);
      const fin = sa.connect(other).finalize(claimId);
      await expect(fin).to.emit(sa, "DisputeJudged").withArgs(claimId, id, DisputeResult.Held, Outcome.INVALID, V.INVALID, JUSTIFICATION);
      await expect(fin).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, leftover);
      await expect(fin).to.changeEtherBalances([hunter, maker], [leftover, 0n]);
      let c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.outcome, c.disputeKind]).to.deep.equal([ClaimState.Judged, DisputeResult.Held, Outcome.INVALID, DisputeKind.Appeal]);
      // Final: settle at once, by anyone; the bond to the maker, nothing from the escrow.
      const held = sa.connect(other).settle(claimId);
      await expect(held).to.changeEtherBalances([hunter, maker], [0n, BOND]);
      await expect(held).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
      expect((await sa.getListing(id)).escrowWei).to.equal(escrow);
      let l = await sa.getListing(id);
      expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
      await restore(snap);

      // Overturned to HIGH: the award and the bond, and no more.
      await aggregator.scriptResult(ap.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await expect(sa.connect(other).finalize(claimId)).to.emit(sa, "DisputeJudged").withArgs(claimId, id, DisputeResult.Overturned, Outcome.HIGH, V.HIGH, JUSTIFICATION);
      const won = sa.connect(other).settle(claimId);
      await expect(won).to.changeEtherBalances([hunter, maker], [AWARDS[2] + BOND, 0n]);
      await expect(won).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, AWARDS[2], 0n);
      l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(escrow - AWARDS[2]);
      expect([l.appealsHeld, l.appealsOverturned]).to.deep.equal([0n, 1n]);
      expect(await sa.withdrawable(hunter.address)).to.equal(0n);
      c = await sa.getClaim(claimId);
      expect([c.paidWei, c.owedWei]).to.deep.equal([AWARDS[2], 0n]);
    });

    it("overturned to a counted class: award from the escrow and bond back, with no confirmation, even above the size; overturned to DUPLICATE: bond back, no award; overturned to a class below lowestClassCounted: bond back, no award, published", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params({ awards: AWARDS_WITH_LOW }), { escrow: 2n * TOP });
      expect((await sa.getListing(id)).confirmAboveWei).to.equal(0n); // every counted award is above the size
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const ap = await appealAs(sa, hunter, claimId);
      const escrow = (await sa.getListing(id)).escrowWei;
      const cases = [
        { panel: V.CRITICAL, outcome: Outcome.CRITICAL, paid: TOP, published: true },
        { panel: V.DUPLICATE, outcome: Outcome.DUPLICATE, paid: 0n, published: false },
        { panel: V.LOW, outcome: Outcome.LOW, paid: 0n, published: true },
      ];
      for (const k of cases) {
        const snap = await snapshot();
        await aggregator.scriptResult(ap.requestId, k.panel.map(BigInt), JUSTIFICATION);
        await sa.connect(other).finalize(claimId);
        const c = await sa.getClaim(claimId);
        expect([c.dispute, c.outcome], `panel ${k.panel}`).to.deep.equal([DisputeResult.Overturned, k.outcome]);
        // The dispute panel has just judged it: no confirmation, no dispute window, settle at once.
        expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
        expect(await sa.settleableAt(claimId)).to.equal(c.disputeEndedAt);
        await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("no confirmation due");
        const tx = sa.connect(other).settle(claimId);
        await expect(tx).to.changeEtherBalances([hunter, maker], [k.paid + BOND, 0n]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, k.outcome, k.paid, 0n);
        await expect(tx).to.not.emit(sa, "ConfirmationNoVerdict");
        expect(await sa.validFindings(id)).to.deep.equal(k.published ? [claimId] : []);
        const l = await sa.getListing(id);
        expect([l.escrowWei, l.confirmationRounds, l.confirmationsNoVerdict]).to.deep.equal([escrow - k.paid, 0n, 0n]);
        await restore(snap);
      }
    });

    it("an overturned appeal pays under settle's escrow rules: an escrow of exactly the award pays it in full and leaves the listing Depleted, as any payout does", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const ap = await appealAs(sa, hunter, claimId);
      await aggregator.scriptResult(ap.requestId, V.CRITICAL.map(BigInt), JUSTIFICATION);
      await sa.connect(other).finalize(claimId);
      const tx = sa.connect(other).settle(claimId);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.CRITICAL, TOP, 0n);
      await expect(tx).to.emit(sa, "Depleted").withArgs(id, 0n);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Depleted);
    });

    it("an overturned appeal after an earlier award left the escrow short: min(award, escrowWei) now, the rest owed and paid by the maker's next fund", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await sa.connect(owner).setConfirmAboveWei(TOP); // the first claim's CRITICAL pays without a confirmation
      const id = await openListing(sa, maker, params(), { escrow: TOP + AWARDS[1] });
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId);
      const { at } = await judgeAs(sa, aggregator, other, a.claimId, V.CRITICAL);
      await time.setNextBlockTimestamp(at + DISPUTE);
      await sa.connect(other).settle(a.claimId); // escrow now AWARDS[1]: Depleted
      await revealAs(sa, hunters[1], b.claimId);
      await judgeAs(sa, aggregator, other, b.claimId, V.INVALID);
      const ap = await appealAs(sa, hunters[1], b.claimId);
      await aggregator.scriptResult(ap.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await sa.connect(other).finalize(b.claimId);
      const tx = sa.connect(other).settle(b.claimId);
      await expect(tx).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.HIGH, AWARDS[1], AWARDS[2] - AWARDS[1]);
      await expect(tx).to.changeEtherBalance(hunters[1], AWARDS[1] + BOND);
      expect((await sa.getListing(id)).owedWei).to.equal(AWARDS[2] - AWARDS[1]);
      await expect(sa.connect(maker).fund(id, 0n, { value: AWARDS[2] }))
        .to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[2] - AWARDS[1], 0n);
    });

    it("a first claim INVALID, appealed and overturned valid, then a second claim with the same root cause: the second request carries the first as a prior finding, and the second settles DUPLICATE", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId, { bcid: cidOf(1) });
      await judgeAs(sa, aggregator, other, a.claimId, V.INVALID);
      // The second claim waits: the first heads the queue through its appeal.
      await expect(sa.connect(hunters[1]).reveal(b.claimId, cidOf(2), CK, EK)).to.be.revertedWith("earlier claim unresolved");
      const ap = await appealAs(sa, hunters[0], a.claimId);
      expect([...(await aggregator.getRequestCids(ap.requestId))]).to.deep.equal([DISPUTE_CID, cidOf(1)]);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, cidOf(2), CK, EK)).to.be.revertedWith("earlier claim unresolved");
      await judgeDisputeAs(sa, aggregator, other, a.claimId, V.HIGH);
      await sa.connect(other).settle(a.claimId);
      expect(await sa.validFindings(id)).to.deep.equal([a.claimId]);

      const { requestId } = await revealAs(sa, hunters[1], b.claimId, { bcid: cidOf(2) });
      expect([...(await aggregator.getRequestCids(requestId))]).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
      const { at } = await judgeAs(sa, aggregator, other, b.claimId, V.DUPLICATE);
      expect(await sa.settleableAt(b.claimId)).to.equal(at);
      const tx = sa.connect(other).settle(b.claimId);
      await expect(tx).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.DUPLICATE, 0n, 0n);
      await expect(tx).to.changeEtherBalance(hunters[1], BOND);
      expect(await sa.validFindings(id)).to.deep.equal([a.claimId]);
    });
  });

  // ------------------------------------------------------------------ a failed appeal round
  describe("an appeal round with no verdict: one re-trigger, the hunter's (through retrigger)", function () {
    it("an appeal round that times out, re-triggered by the hunter with a fresh prepay, whose round then gives a verdict: that verdict settles (held: bond to the maker; overturned: by the panel's outcome); both rounds' spent prepay is the hunter's", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      const leftover = DF / 5n;
      await aggregator.setRefundAmount(leftover);
      const first = await appealAs(sa, hunter, claimId);
      const { rc, endedAt } = await failPanelRound(sa, aggregator, claimId, "timeout");
      expect(eventsOf(sa, rc, "LeftoverRefunded").map((e) => [e.args.funder, e.args.amountWei])).to.deep.equal([[hunter.address, leftover]]);
      let c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.disputeKind, c.outcome, c.appealRetriggered]).to.deep.equal(
        [ClaimState.Judged, DisputeResult.NoVerdict, DisputeKind.Appeal, Outcome.INVALID, false],
      );
      expect(await sa.retriggerDeadline(claimId)).to.equal(endedAt + REVEAL);
      expect(await sa.retriggerTopUp(claimId)).to.equal(DF); // a fresh prepay, in full
      expect(await sa.settleableAt(claimId)).to.equal(endedAt + REVEAL);
      expect(await sa.appealDeadline(claimId)).to.equal(0n);

      const escrow = (await sa.getListing(id)).escrowWei;
      const tx = sa.connect(hunter).retrigger(claimId, { value: DF });
      await expect(tx).to.changeEtherBalances([hunter, sa], [-DF, 0n]);
      const rc2 = await (await tx).wait();
      expect(eventsOf(sa, rc2, "Retriggered").map((e) => [...e.args])).to.deep.equal([[claimId, id]]);
      const second = eventsOf(sa, rc2, "Appealed")[0].args;
      expect([second.claimId, second.listingId, second.prepayWei]).to.deep.equal([claimId, id, DF]);
      expect(second.wallet).to.not.equal(first.wallet);
      expect(second.requestId).to.not.equal(first.requestId);
      expect([...(await sa.walletInfo(second.wallet))]).to.deep.equal([hunter.address, claimId]);
      expect(await aggregator.ethReceived(second.requestId)).to.equal(DF);
      expect([...(await aggregator.getRequestCids(second.requestId))]).to.deep.equal([...(await aggregator.getRequestCids(first.requestId))]);
      expect((await aggregator.requestParams(second.requestId)).addendum).to.equal((await aggregator.requestParams(first.requestId)).addendum);
      c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.disputeKind, c.appealRetriggered, c.disputeWallet]).to.deep.equal(
        [ClaimState.Disputed, DisputeResult.Pending, DisputeKind.Appeal, true, second.wallet],
      );
      expect(await sa.retriggerDeadline(claimId)).to.equal(0n);
      expect(await sa.retriggerTopUp(claimId)).to.equal(0n);
      // The first round's wallet is over: its recovery is allowed (nothing left in it).
      await expect(sa.recoverLeftoverEth(first.wallet)).to.be.revertedWith("nothing to recover");

      for (const [panel, result, outcome, hunterGets, makerGets, paid] of [
        [V.INVALID, DisputeResult.Held, Outcome.INVALID, 0n, BOND, 0n],
        [V.MEDIUM, DisputeResult.Overturned, Outcome.MEDIUM, AWARDS[1] + BOND, 0n, AWARDS[1]],
      ]) {
        const snap = await snapshot();
        await aggregator.scriptResult(second.requestId, panel.map(BigInt), JUSTIFICATION);
        const fin = sa.connect(other).finalize(claimId);
        await expect(fin).to.emit(sa, "DisputeJudged").withArgs(claimId, id, result, outcome, panel, JUSTIFICATION);
        await expect(fin).to.emit(sa, "LeftoverRefunded").withArgs(claimId, hunter.address, leftover);
        const settle = sa.connect(other).settle(claimId);
        await expect(settle).to.changeEtherBalances([hunter, maker], [hunterGets, makerGets]);
        await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, outcome, paid, 0n);
        // Neither round's spent prepay came from the escrow or the bond.
        expect((await sa.getListing(id)).escrowWei).to.equal(escrow - paid);
        const l = await sa.getListing(id);
        expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal(
          [1n, result === DisputeResult.Held ? 1n : 0n, result === DisputeResult.Overturned ? 1n : 0n, 0n],
        );
        await restore(snap);
      }
    });

    it("an appeal round with a malformed vector, re-triggered, whose round also settles no verdict: the INVALID stands and settles at once; a second re-trigger is refused", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.INVALID);
      await appealAs(sa, hunter, claimId);
      await failPanelRound(sa, aggregator, claimId, "malformed");
      await appealAs(sa, hunter, claimId, { retrigger: true });
      const { endedAt } = await failPanelRound(sa, aggregator, claimId, "timeout");
      const c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.outcome, c.appealRetriggered, c.vector.map(Number)]).to.deep.equal(
        [ClaimState.Judged, DisputeResult.NoVerdict, Outcome.INVALID, true, V.INVALID],
      );
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("already retriggered");
      await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("already disputed");
      expect(await sa.retriggerDeadline(claimId)).to.equal(0n);
      expect(await sa.retriggerTopUp(claimId)).to.equal(0n);
      expect(await sa.settleableAt(claimId)).to.equal(endedAt);
      expect(endedAt < judgedAt + DISPUTE).to.equal(true); // inside what was the appeal window
      const tx = sa.connect(other).settle(claimId); // at once, by anyone
      await expect(tx).to.changeEtherBalances([hunter, maker], [0n, BOND]);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
      const l = await sa.getListing(id);
      expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal([1n, 0n, 0n, 1n]);
      expect(l.disputesNoVerdict).to.equal(0n); // counted apart from the maker's disputes
    });

    it("an appeal with no verdict that the hunter does not re-trigger: settle refused until revealWindow after the failure, except from the hunter (the waiver); then the INVALID stands; the next claim's reveal waits meanwhile", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId);
      await judgeAs(sa, aggregator, other, a.claimId, V.INVALID);
      await appealAs(sa, hunters[0], a.claimId);
      const { endedAt } = await failPanelRound(sa, aggregator, a.claimId, "timeout");
      const deadline = endedAt + REVEAL;
      expect(await sa.settleableAt(a.claimId)).to.equal(deadline);
      for (const who of [maker, other, hunters[1]]) {
        await expect(sa.connect(who).settle(a.claimId), who.address).to.be.revertedWith("retrigger window open");
      }
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, CK, EK)).to.be.revertedWith("earlier claim unresolved");
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await time.setNextBlockTimestamp(deadline - 2n);
      await expect(sa.connect(other).settle(a.claimId)).to.be.revertedWith("retrigger window open");

      // The waiver: the hunter settles inside the re-trigger window.
      const snap = await snapshot();
      await expect(sa.connect(hunters[0]).settle(a.claimId)).to.changeEtherBalances([hunters[0], maker], [0n, BOND]);
      await expect(sa.connect(hunters[0]).retrigger(a.claimId, { value: DF })).to.be.revertedWith("not failed");
      await revealAs(sa, hunters[1], b.claimId);
      await restore(snap);

      // From the deadline: no re-trigger, and anyone may settle; the INVALID stands.
      await time.setNextBlockTimestamp(deadline);
      await expect(sa.connect(hunters[0]).retrigger(a.claimId, { value: DF })).to.be.revertedWith("retrigger window over");
      expect(await sa.retriggerDeadline(a.claimId)).to.equal(deadline); // reported until it is used or settled
      const tx = sa.connect(other).settle(a.claimId);
      await expect(tx).to.changeEtherBalances([hunters[0], maker], [0n, BOND]);
      await expect(tx).to.emit(sa, "Settled").withArgs(a.claimId, id, hunters[0].address, Outcome.INVALID, 0n, 0n);
      await revealAs(sa, hunters[1], b.claimId);
      const l = await sa.getListing(id);
      expect([l.appealsFiled, l.appealsNoVerdict]).to.deep.equal([1n, 1n]);
    });

    it("a re-trigger after its window, by anyone but the hunter, or with a prepay below disputeFee: refused; a re-trigger the aggregator refuses: reverts, nothing recorded, the re-trigger still available", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const hunter = hunters[0];
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      await appealAs(sa, hunter, claimId);
      const { endedAt } = await failPanelRound(sa, aggregator, claimId, "timeout");
      for (const who of [maker, other, hunters[1]]) {
        await expect(sa.connect(who).retrigger(claimId, { value: DF }), who.address).to.be.revertedWith("not hunter");
      }
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF - 1n })).to.be.revertedWith("prepay below fee");
      await aggregator.setFeeMultiplier(4n);
      const live = await sa.disputeFee(id);
      expect(await sa.retriggerTopUp(claimId)).to.equal(live);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live - 1n })).to.be.revertedWith("prepay below fee");

      const claimBefore = bigintJson(await sa.getClaim(claimId));
      const listingBefore = bigintJson(await sa.getListing(id));
      const balance = await balanceOf(sa);
      await aggregator.setPaused(true);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live })).to.be.revertedWithCustomError(aggregator, "EnforcedPause");
      await aggregator.setPaused(false);
      await aggregator.setRequestGasCost(11_000_000n);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live, gasLimit: 25_000_000n })).to.be.reverted;
      await aggregator.setRequestGasCost(0n);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live, gasLimit: 5_000_000n })).to.be.revertedWith("gas below SUBMISSION_GAS_NEEDED");
      expect(bigintJson(await sa.getClaim(claimId))).to.equal(claimBefore);
      expect(bigintJson(await sa.getListing(id))).to.equal(listingBefore);
      expect(await balanceOf(sa)).to.equal(balance);

      const snap = await snapshot();
      await time.setNextBlockTimestamp(endedAt + REVEAL);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live })).to.be.revertedWith("retrigger window over");
      await restore(snap);
      await time.setNextBlockTimestamp(endedAt + REVEAL - 1n);
      await expect(sa.connect(hunter).retrigger(claimId, { value: live })).to.emit(sa, "Appealed");
      expect((await sa.getClaim(claimId)).appealRetriggered).to.equal(true);
    });

    it("retrigger serves a claim round's failure as before, and an appeal's only while the claim is Judged with that appeal's round failed", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const { claimId } = await judged(sa, aggregator, hunter, id, V.INVALID);
      // Judged with no appeal: nothing to re-trigger.
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("not failed");
      await appealAs(sa, hunter, claimId);
      // Its round open: not failed yet.
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("not failed");
      await failPanelRound(sa, aggregator, claimId, "timeout");
      await appealAs(sa, hunter, claimId, { retrigger: true });
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("not failed");
      await failPanelRound(sa, aggregator, claimId, "malformed");
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("already retriggered");
      await sa.connect(other).settle(claimId);
      await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("not failed");
    });
  });

  // ------------------------------------------------------------------ E8 and E9 with the appeal
  describe("with the narrow INVALID (E8) and the confirmation (E9)", function () {
    it("a narrow first round appealed and held with a vector below the floor: bond to the maker; held with a narrow vector: bond back; an appeal whose round and re-trigger both settle no verdict, after a narrow first round: bond back", async function () {
      const { sa, aggregator, owner, maker, other, hunter } = await loadFixture(deployDefaults);
      await sa.connect(owner).setNarrowInvalidFloor(FLOOR);
      const id = await openListing(sa, maker);
      const { claimId } = await judged(sa, aggregator, hunter, id, invalidWith(400_000));
      expect((await sa.judgeVector(id, invalidWith(400_000))).narrow).to.equal(true);
      // A narrow INVALID may still be appealed: the appeal can win the award.
      const ap = await appealAs(sa, hunter, claimId);
      const cases = [
        { name: "held below the floor", panel: invalidWith(FLOOR - 1n), hunterGets: 0n, makerGets: BOND, narrow: null },
        { name: "held narrow", panel: invalidWith(360_000), hunterGets: BOND, makerGets: 0n, narrow: 360_000n },
        { name: "no verdict twice", panel: null, hunterGets: BOND, makerGets: 0n, narrow: 400_000n },
      ];
      for (const k of cases) {
        const snap = await snapshot();
        if (k.panel) {
          await aggregator.scriptResult(ap.requestId, k.panel.map(BigInt), JUSTIFICATION);
          await sa.connect(other).finalize(claimId);
          expect((await sa.getClaim(claimId)).dispute, k.name).to.equal(DisputeResult.Held);
        } else {
          await failPanelRound(sa, aggregator, claimId, "timeout");
          await appealAs(sa, hunter, claimId, { retrigger: true });
          await failPanelRound(sa, aggregator, claimId, "malformed");
          expect((await sa.getClaim(claimId)).vector.map(Number), k.name).to.deep.equal(invalidWith(400_000));
        }
        const tx = sa.connect(other).settle(claimId);
        await expect(tx, k.name).to.changeEtherBalances([hunter, maker], [k.hunterGets, k.makerGets]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
        if (k.narrow === null) await expect(tx).to.not.emit(sa, "NarrowInvalid");
        else await expect(tx).to.emit(sa, "NarrowInvalid").withArgs(claimId, id, k.narrow);
        await restore(snap);
      }
    });

    it("overturned to INVALID by a confirmation: bond to the maker, or back when narrow; the hunter's appeal refused", async function () {
      const { sa, aggregator, owner, maker, other, hunter } = await loadFixture(deployDefaults);
      await sa.connect(owner).setNarrowInvalidFloor(FLOOR);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.CRITICAL);
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      const conf = await confirmAs(sa, other, claimId);
      for (const [panel, hunterGets, makerGets] of [[V.INVALID, 0n, BOND], [invalidWith(400_000), BOND, 0n]]) {
        const snap = await snapshot();
        await aggregator.scriptResult(conf.requestId, panel.map(BigInt), JUSTIFICATION);
        await sa.connect(other).finalize(claimId);
        const c = await sa.getClaim(claimId);
        expect([c.dispute, c.outcome, c.disputeKind]).to.deep.equal([DisputeResult.Overturned, Outcome.INVALID, DisputeKind.Confirmation]);
        // The claim's one dispute-panel verdict is in: no appeal, and settle at once.
        expect(await sa.appealDeadline(claimId)).to.equal(0n);
        await expect(sa.connect(hunter).appeal(claimId, { value: DF })).to.be.revertedWith("already disputed");
        await expect(sa.connect(hunter).retrigger(claimId, { value: DF })).to.be.revertedWith("not failed");
        expect(await sa.settleableAt(claimId)).to.equal(c.disputeEndedAt);
        await expect(sa.connect(other).settle(claimId)).to.changeEtherBalances([hunter, maker], [hunterGets, makerGets]);
        const l = await sa.getListing(id);
        expect([l.appealsFiled, l.confirmationsOverturned]).to.deep.equal([0n, 1n]);
        await restore(snap);
      }
    });

    it("a confirmation with no verdict leaves a valid outcome, which the hunter may not appeal; an appeal overturned to a counted class is never confirmed", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const a = await judged(sa, aggregator, hunters[0], id, V.HIGH);
      await time.setNextBlockTimestamp(a.judgedAt + DISPUTE);
      await confirmAs(sa, other, a.claimId);
      await failPanelRound(sa, aggregator, a.claimId, "timeout");
      await expect(sa.connect(hunters[0]).appeal(a.claimId, { value: DF })).to.be.revertedWith("already disputed");
      await expect(sa.connect(hunters[0]).retrigger(a.claimId, { value: DF })).to.be.revertedWith("not failed");
      await time.setNextBlockTimestamp(a.judgedAt + DISPUTE + REVEAL); // the confirmation deadline
      await sa.connect(other).settle(a.claimId);

      const b = await judged(sa, aggregator, hunters[1], id, V.INVALID);
      await appealAs(sa, hunters[1], b.claimId);
      await judgeDisputeAs(sa, aggregator, other, b.claimId, V.CRITICAL);
      expect([...(await sa.confirmWindow(b.claimId))]).to.deep.equal([0n, 0n]);
      await expect(sa.connect(other).settle(b.claimId)).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.CRITICAL, TOP, 0n);
      expect((await sa.getListing(id)).confirmationRounds).to.equal(1n); // a's only
    });
  });

  // ------------------------------------------------------------------ late claims
  describe("late claims (decision D6)", function () {
    it("a late claim's appeal: judged and counted under later, with no award; its INVALID waits out the window too", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      await sa.connect(maker).close(id);
      const escrowBefore = (await sa.getListing(id)).escrowWei;
      const plan = [
        { panel: V.HIGH, result: DisputeResult.Overturned, outcome: Outcome.HIGH, hunterGets: BOND, makerGets: 0n },
        { panel: V.INVALID, result: DisputeResult.Held, outcome: Outcome.INVALID, hunterGets: 0n, makerGets: BOND },
        { panel: null, result: DisputeResult.NoVerdict, outcome: Outcome.INVALID, hunterGets: 0n, makerGets: BOND },
      ];
      const ids = [];
      for (const [i, k] of plan.entries()) {
        const hunter = hunters[i];
        const { claimId } = await lateClaimAs(sa, hunter, id);
        await revealAs(sa, hunter, claimId);
        const { at } = await judgeAs(sa, aggregator, other, claimId, V.INVALID);
        expect(await sa.appealDeadline(claimId)).to.equal(at + DISPUTE);
        await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("appeal window open");
        const ap = await appealAs(sa, hunter, claimId);
        if (k.panel) {
          await aggregator.scriptResult(ap.requestId, k.panel.map(BigInt), JUSTIFICATION);
          await sa.connect(other).finalize(claimId);
        } else {
          await failPanelRound(sa, aggregator, claimId, "timeout");
          await appealAs(sa, hunter, claimId, { retrigger: true });
          await failPanelRound(sa, aggregator, claimId, "timeout");
        }
        const c = await sa.getClaim(claimId);
        expect([c.dispute, c.outcome, c.late]).to.deep.equal([k.result, k.outcome, true]);
        const tx = sa.connect(other).settle(claimId);
        await expect(tx).to.changeEtherBalances([hunter, maker], [k.hunterGets, k.makerGets]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, k.outcome, 0n, 0n);
        ids.push(claimId);
      }
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(escrowBefore);
      expect([l.lateAppealsFiled, l.lateAppealsHeld, l.lateAppealsOverturned, l.lateAppealsNoVerdict]).to.deep.equal([3n, 1n, 1n, 1n]);
      expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal([0n, 0n, 0n, 0n]);
      const r = await recordOf(sa, id);
      for (const h of [r.history, listingIn(r, id).history]) {
        expect([h.lateAppeals, h.lateAppealsHeld, h.lateAppealsOverturned, h.lateAppealsNoVerdict]).to.deep.equal([3n, 1n, 1n, 1n]);
        expect([h.appeals, h.appealsHeld, h.appealsOverturned, h.appealsNoVerdict]).to.deep.equal([0n, 0n, 0n, 0n]);
        expect(lateOutcomesOf(h)).to.deep.equal([2n, 0n, 0n, 0n, 1n, 0n]);
        expect(outcomesOf(h)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]);
      }
      expect([...r.findings].map((f) => [f.claimId, f.late, f.outcome, f.paidWei, f.dispute, f.disputeKind])).to.deep.equal([
        [ids[0], true, Outcome.HIGH, 0n, DisputeResult.Overturned, DisputeKind.Appeal],
      ]);
    });
  });

  // ------------------------------------------------------------------ the record and the views
  describe("the record, the views and the ABI", function () {
    it("the record counts appeals by final result, apart from the maker's disputes and the confirmations; a finding carries the Appeal kind", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 4n * TOP });
      const settleNow = async (claimId) => {
        const at = await sa.settleableAt(claimId);
        if (BigInt(await time.latest()) < at) await time.setNextBlockTimestamp(at);
        await sa.connect(other).settle(claimId);
      };
      // A: appealed, held.
      const a = await judged(sa, aggregator, hunters[0], id, V.INVALID, { bcid: cidOf(1) });
      await appealAs(sa, hunters[0], a.claimId);
      await judgeDisputeAs(sa, aggregator, other, a.claimId, V.INVALID);
      await settleNow(a.claimId);
      // B: appealed, overturned to HIGH.
      const b = await judged(sa, aggregator, hunters[1], id, V.INVALID, { bcid: cidOf(2) });
      await appealAs(sa, hunters[1], b.claimId);
      await judgeDisputeAs(sa, aggregator, other, b.claimId, V.HIGH);
      await settleNow(b.claimId);
      // C: appealed with no verdict, not re-triggered: the window passes.
      const c = await judged(sa, aggregator, hunters[2], id, V.INVALID, { bcid: cidOf(3) });
      await appealAs(sa, hunters[2], c.claimId);
      await failPanelRound(sa, aggregator, c.claimId, "timeout");
      await settleNow(c.claimId);
      // D: appealed with no verdict, re-triggered, overturned to MEDIUM.
      const d = await judged(sa, aggregator, hunters[3], id, V.INVALID, { bcid: cidOf(4) });
      await appealAs(sa, hunters[3], d.claimId);
      await failPanelRound(sa, aggregator, d.claimId, "malformed");
      await appealAs(sa, hunters[3], d.claimId, { retrigger: true });
      await judgeDisputeAs(sa, aggregator, other, d.claimId, V.MEDIUM);
      await settleNow(d.claimId);
      // E: an INVALID not appealed, settled after the window; F: the maker's dispute, held;
      // G: a confirmation, held.
      const e = await judged(sa, aggregator, hunters[4], id, V.INVALID, { bcid: cidOf(5) });
      await settleNow(e.claimId);
      const f = await judged(sa, aggregator, hunters[5], id, V.HIGH, { bcid: cidOf(6) });
      await disputeAs(sa, maker, f.claimId);
      await judgeDisputeAs(sa, aggregator, other, f.claimId, V.HIGH);
      await settleNow(f.claimId);
      const g = await judged(sa, aggregator, hunters[6], id, V.MEDIUM, { bcid: cidOf(7) });
      await time.setNextBlockTimestamp(g.judgedAt + DISPUTE);
      await confirmAs(sa, other, g.claimId);
      await judgeDisputeAs(sa, aggregator, other, g.claimId, V.MEDIUM);
      await settleNow(g.claimId);

      const l = await sa.getListing(id);
      expect([l.appealsFiled, l.appealsHeld, l.appealsOverturned, l.appealsNoVerdict]).to.deep.equal([4n, 1n, 2n, 1n]);
      expect([l.disputesFiled, l.disputesHeld, l.disputesOverturned, l.disputesNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
      expect([l.confirmationRounds, l.confirmationsHeld, l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
      const r = await recordOf(sa, id);
      for (const h of [r.history, listingIn(r, id).history]) {
        expect([h.appeals, h.appealsHeld, h.appealsOverturned, h.appealsNoVerdict]).to.deep.equal([4n, 1n, 2n, 1n]);
        expect([h.disputes, h.disputesHeld, h.disputesOverturned, h.disputesNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
        expect([h.confirmationRounds, h.confirmationsHeld]).to.deep.equal([1n, 1n]);
        expect([h.lateAppeals, h.lateAppealsHeld, h.lateAppealsOverturned, h.lateAppealsNoVerdict]).to.deep.equal([0n, 0n, 0n, 0n]);
        expect(outcomesOf(h)).to.deep.equal([3n, 0n, 0n, 2n, 2n, 0n]);
      }
      expect(findingIds(r)).to.deep.equal([b.claimId, d.claimId, f.claimId, g.claimId]);
      expect([...r.findings].map((x) => [x.outcome, x.dispute, x.disputeKind])).to.deep.equal([
        [Outcome.HIGH, DisputeResult.Overturned, DisputeKind.Appeal],
        [Outcome.MEDIUM, DisputeResult.Overturned, DisputeKind.Appeal],
        [Outcome.HIGH, DisputeResult.Held, DisputeKind.Maker],
        [Outcome.MEDIUM, DisputeResult.Held, DisputeKind.Confirmation],
      ]);
    });

    it("the lens reports the appeal window (appealDeadline), an appeal's re-trigger deadline and fee (retriggerDeadline, retriggerTopUp), and when settle may run (settleableAt); the appeal costs disputeFee", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      const views = async (claimId) => {
        const out = [];
        for (const c of [sa, lens]) {
          out.push([await c.appealDeadline(claimId), await c.retriggerDeadline(claimId), await c.retriggerTopUp(claimId), await c.settleableAt(claimId)]);
        }
        expect(out[0], "the lens at the contract's address and directly").to.deep.equal(out[1]);
        return out[0];
      };
      expect(await lens.disputeFee(id)).to.equal(DF);
      const { claimId } = await claimAs(sa, hunter, id);
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, 0n]);
      await revealAs(sa, hunter, claimId);
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, 0n]);
      const { at: judgedAt } = await judgeAs(sa, aggregator, hunter, claimId, V.INVALID);
      expect(await views(claimId)).to.deep.equal([judgedAt + DISPUTE, 0n, 0n, judgedAt + DISPUTE]);
      expect(await sa.disputeDeadline(claimId)).to.equal(0n); // the maker disputes only a valid outcome
      await appealAs(sa, hunter, claimId);
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, 0n]);
      const { endedAt } = await failPanelRound(sa, aggregator, claimId, "timeout");
      expect(await views(claimId)).to.deep.equal([0n, endedAt + REVEAL, DF, endedAt + REVEAL]);
      await aggregator.setFeeMultiplier(6n);
      expect((await views(claimId))[2]).to.equal(ORACLE.disputeMaxOracleFee * 6n);
      await aggregator.setFeeMultiplier(3n);
      await appealAs(sa, hunter, claimId, { retrigger: true });
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, 0n]);
      const { endedAt: second } = await failPanelRound(sa, aggregator, claimId, "timeout");
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, second]);
      await sa.settle(claimId);
      expect(await views(claimId)).to.deep.equal([0n, 0n, 0n, 0n]);
    });

    it("ClaimState, DisputeResult and DisputeKind keep their values (Appeal appended); the new fields are appended to Listing, Claim and History", async function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "StakeAttestation.sol"), "utf8");
      const enumOf = (name) => src.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))[1].split(",").map((s) => s.trim());
      expect(enumOf("ClaimState")).to.deep.equal(["Committed", "Revealable", "Revealed", "Judged", "Disputed", "Settled", "Expired", "RoundFailed"]);
      expect(enumOf("DisputeResult")).to.deep.equal(["None", "Pending", "Held", "Overturned", "NoVerdict"]);
      expect(enumOf("DisputeKind")).to.deep.equal(["None", "Maker", "Confirmation", "Appeal"]);

      const { sa } = await loadFixture(deployDefaults);
      const names = (fn) => sa.interface.getFunction(fn).outputs[0].components.map((c) => c.name);
      const listing = names("getListing");
      const claim = names("getClaim");
      // P17's last fields, then this node's.
      expect(listing.slice(listing.indexOf("confirmationsNoVerdict"))).to.deep.equal([
        "confirmationsNoVerdict", "appealsFiled", "appealsHeld", "appealsOverturned", "appealsNoVerdict",
        "lateAppealsFiled", "lateAppealsHeld", "lateAppealsOverturned", "lateAppealsNoVerdict",
      ]);
      expect(claim.slice(claim.indexOf("disputeKind"))).to.deep.equal(["disputeKind", "appealRetriggered"]);
      const record = sa.interface.getFunction("recordByHash").outputs[0].components;
      const history = record.find((c) => c.name === "history").components.map((c) => c.name);
      expect(history.slice(history.indexOf("lateNarrowInvalid"))).to.deep.equal([
        "lateNarrowInvalid", "appeals", "appealsHeld", "appealsOverturned", "appealsNoVerdict",
        "lateAppeals", "lateAppealsHeld", "lateAppealsOverturned", "lateAppealsNoVerdict",
      ]);
    });

    it("declares an event for the appeal: Appealed(claimId, listingId, wallet, requestId, prepayWei)", async function () {
      const { sa } = await loadFixture(deployDefaults);
      expect(sa.interface.getEvent("Appealed").inputs.map((i) => i.name)).to.deep.equal(["claimId", "listingId", "wallet", "requestId", "prepayWei"]);
    });
  });
});
