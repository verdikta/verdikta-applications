// StakeAttestation, the settlement safeguards of 2026-11-10 (build node P17). Design:
// verdikta-arbiter docs/development/stake-attestation-design.md §13.2, "Errata, 2026-11-10 (Q70)"
// (E8, E9, "Where the floor and the size are set", "What changes in the contract") and §18's
// "Erratum, 2026-11-10 (Q70): contract fixtures", whose E8 and E9 fixtures each have a test here
// named after them (the appeal's, E7, are node P16's). The owner decided the mechanics (Q72).
//
//   - E8, the narrow INVALID: an INVALID whose valid mass (LOW..CRITICAL of the vector settle
//     applies) is at least the listing's narrowInvalidFloor returns the bond, with no award and
//     nothing published. A gate failure or tamper flag (all mass on INVALID) is never narrow.
//   - E9, the confirmation: a claim round's verdict whose table award is above the listing's
//     confirmAboveWei waits for a dispute-panel verdict before it pays. A maker's dispute inside
//     the dispute window is the confirmation; otherwise anyone calls confirm(claimId) from the end
//     of the window until the confirmation deadline (judgedAt + disputeWindow + revealWindow), and
//     the listing's escrow pays the round. From the deadline, with no round open and no verdict,
//     the first verdict pays.
//   - The floor and the size are two program values the contract owner sets within bounds; list()
//     copies both onto the listing, so a change reaches only listings made after it.
//
// These tests start from deployDefaults (floor THRESHOLD, size 0) and set what they need; the
// tests written before the erratum run on helpers' deploy(), which sets the size to the top award.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const {
  ListingState, Outcome, ClaimState, DisputeResult, DisputeKind, DISPUTE, REVEAL, SCALE, T,
  LISTING_CID, DISPUTE_CID, BCID, JUSTIFICATION, TOP, AWARDS, BOND, DISPUTE_FEE, ORACLE, V,
  params, freshCommit, atCommit, deployDefaults, eventsOf, blockTime,
  listAs, openListing, claimAs, revealAs, revealedClaim, judgeAs, disputeAs, judgeDisputeAs, confirmAs,
  lateClaimAs, recordOf, listingIn, outcomesOf,
} = H;
const { MaxUint256 } = ethers;

const THRESHOLD = BigInt(T);
const FLOOR = 350_000n;
const MIN_FLOOR = 250_000n;
const DF = DISPUTE_FEE; // what one dispute-panel round costs on the default listing
const cidOf = (i) => `Qm${"S".repeat(42)}${String(i).padStart(2, "0")}`;

// INVALID with exactly `mass` of valid mass, on MEDIUM (order INVALID, DUPLICATE, LOW..CRITICAL).
const invalidWith = (mass) => [SCALE - Number(mass), 0, 0, Number(mass), 0, 0];
const SPLIT_50_50 = [500_000, 0, 125_000, 125_000, 125_000, 125_000]; // valid mass 500,000: INVALID

async function snapshot() {
  return network.provider.send("evm_snapshot");
}
async function restore(id) {
  await network.provider.send("evm_revert", [id]);
}
const bigintJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

// The owner's two program values (errata E8, E9), as the next list() will copy them.
async function setProgram(sa, owner, { floor, size } = {}) {
  if (floor !== undefined) await sa.connect(owner).setNarrowInvalidFloor(floor);
  if (size !== undefined) await sa.connect(owner).setConfirmAboveWei(size);
}

// One claim revealed and judged `vector` on `listingId`.
async function judged(sa, aggregator, hunter, listingId, vector, opts = {}) {
  const { claimId, requestId } = await revealedClaim(sa, hunter, listingId, opts);
  const { at } = await judgeAs(sa, aggregator, hunter, claimId, vector);
  return { claimId, requestId, judgedAt: at };
}

// The confirmation window of a judged claim: [opensAt, deadline).
async function windowOf(sa, claimId) {
  const c = await sa.getClaim(claimId);
  const l = await sa.getListing(c.listingId);
  const opensAt = c.judgedAt + l.disputeWindow;
  return { opensAt, deadline: opensAt + l.revealWindow };
}

async function atConfirmWindow(sa, claimId) {
  const { opensAt } = await windowOf(sa, claimId);
  if (BigInt(await time.latest()) < opensAt) await time.setNextBlockTimestamp(opensAt);
}

describe("StakeAttestation: settlement safeguards, errata E8 and E9 (P17)", function () {
  // ------------------------------------------------------------------ program values
  describe("the floor and the size: program values the owner sets, copied onto each listing", function () {
    it("defaults: the floor is THRESHOLD (an empty band) and the size 0 (every counted award confirmed); the constructor announces both", async function () {
      const { sa } = await loadFixture(deployDefaults);
      expect(await sa.narrowInvalidFloor()).to.equal(THRESHOLD);
      expect(await sa.confirmAboveWei()).to.equal(0n);
      expect(await sa.MIN_NARROW_INVALID_FLOOR()).to.equal(MIN_FLOOR);
      const floors = await sa.queryFilter(sa.filters.NarrowInvalidFloorSet());
      const sizes = await sa.queryFilter(sa.filters.ConfirmAboveWeiSet());
      expect(floors.map((e) => [...e.args])).to.deep.equal([[0n, THRESHOLD]]);
      expect(sizes.map((e) => [...e.args])).to.deep.equal([[0n, 0n]]);
    });

    it("each setter is the owner's alone, emits an event and is bounded: the floor from 250,000 to THRESHOLD, the size any wei; out of bounds reverts", async function () {
      const { sa, owner, maker } = await loadFixture(deployDefaults);
      await expect(sa.connect(maker).setNarrowInvalidFloor(FLOOR)).to.be.revertedWithCustomError(sa, "OwnableUnauthorizedAccount");
      await expect(sa.connect(maker).setConfirmAboveWei(1n)).to.be.revertedWithCustomError(sa, "OwnableUnauthorizedAccount");
      await expect(sa.connect(owner).setNarrowInvalidFloor(MIN_FLOOR - 1n)).to.be.revertedWith("floor out of bounds");
      await expect(sa.connect(owner).setNarrowInvalidFloor(THRESHOLD + 1n)).to.be.revertedWith("floor out of bounds");
      await expect(sa.connect(owner).setNarrowInvalidFloor(0n)).to.be.revertedWith("floor out of bounds");
      expect(await sa.narrowInvalidFloor()).to.equal(THRESHOLD);
      let prev = THRESHOLD;
      for (const floor of [MIN_FLOOR, FLOOR, THRESHOLD - 1n, THRESHOLD]) {
        await expect(sa.connect(owner).setNarrowInvalidFloor(floor)).to.emit(sa, "NarrowInvalidFloorSet").withArgs(prev, floor);
        expect(await sa.narrowInvalidFloor()).to.equal(floor);
        prev = floor;
      }
      prev = 0n;
      for (const size of [1n, AWARDS[2], MaxUint256, 0n]) {
        await expect(sa.connect(owner).setConfirmAboveWei(size)).to.emit(sa, "ConfirmAboveWeiSet").withArgs(prev, size);
        expect(await sa.confirmAboveWei()).to.equal(size);
        prev = size;
      }
    });

    it("list() copies both onto the listing; getListing and the record show the listing's values", async function () {
      const { sa, owner, maker } = await loadFixture(deployDefaults);
      const a = await openListing(sa, maker);
      await setProgram(sa, owner, { floor: FLOOR, size: AWARDS[2] });
      const b = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const la = await sa.getListing(a);
      const lb = await sa.getListing(b);
      expect([la.narrowInvalidFloor, la.confirmAboveWei]).to.deep.equal([THRESHOLD, 0n]);
      expect([lb.narrowInvalidFloor, lb.confirmAboveWei]).to.deep.equal([FLOOR, AWARDS[2]]);
      const ra = listingIn(await recordOf(sa, a), a);
      const rb = listingIn(await recordOf(sa, b), b);
      expect([ra.narrowInvalidFloor, ra.confirmAboveWei]).to.deep.equal([THRESHOLD, 0n]);
      expect([rb.narrowInvalidFloor, rb.confirmAboveWei]).to.deep.equal([FLOOR, AWARDS[2]]);
    });

    it("the owner changes the floor after a listing: the listing and its pending claims keep the old floor, and a listing made after the change takes the new one; a setter call outside the bounds reverts", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR, size: MaxUint256 });
      const old = await openListing(sa, maker);
      const pending = await claimAs(sa, hunters[0], old); // committed under the old floor
      const before = bigintJson(await sa.getListing(old));
      const claimBefore = bigintJson(await sa.getClaim(pending.claimId));
      const balance = await ethers.provider.getBalance(sa.target);
      await setProgram(sa, owner, { floor: THRESHOLD });
      await expect(sa.connect(owner).setNarrowInvalidFloor(MIN_FLOOR - 1n)).to.be.revertedWith("floor out of bounds");
      // The setter reached nothing live: the listing, its claim, the contract's balance.
      expect(bigintJson(await sa.getListing(old))).to.equal(before);
      expect(bigintJson(await sa.getClaim(pending.claimId))).to.equal(claimBefore);
      expect(await ethers.provider.getBalance(sa.target)).to.equal(balance);
      const later = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      expect((await sa.getListing(later)).narrowInvalidFloor).to.equal(THRESHOLD);

      // The old listing's pending claim: a narrow INVALID under its floor, bond back.
      await revealAs(sa, hunters[0], pending.claimId);
      await judgeAs(sa, aggregator, hunters[0], pending.claimId, invalidWith(FLOOR));
      await expect(sa.connect(other).settle(pending.claimId)).to.changeEtherBalances([hunters[0], maker], [BOND, 0n]);
      // The same vector on the later listing forfeits: its band is empty.
      const { claimId } = await judged(sa, aggregator, hunters[1], later, invalidWith(FLOOR));
      await expect(sa.connect(other).settle(claimId)).to.changeEtherBalances([hunters[1], maker], [0n, BOND]);
    });

    it("the owner changes the size after a listing: the listing and its pending claims keep the old size", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      // Listed at size TOP: no claim of it is ever confirmed, whatever the owner sets later.
      await setProgram(sa, owner, { size: TOP });
      const atTop = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      await setProgram(sa, owner, { size: 0n });
      const atZero = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }), { escrow: 2n * TOP });
      await setProgram(sa, owner, { size: MaxUint256 }); // reaches neither
      expect((await sa.getListing(atTop)).confirmAboveWei).to.equal(TOP);
      expect((await sa.getListing(atZero)).confirmAboveWei).to.equal(0n);

      const a = await judged(sa, aggregator, hunters[0], atTop, V.CRITICAL);
      await time.setNextBlockTimestamp(a.judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(a.claimId)).to.emit(sa, "Settled").withArgs(a.claimId, atTop, hunters[0].address, Outcome.CRITICAL, TOP, 0n);

      const b = await judged(sa, aggregator, hunters[1], atZero, V.MEDIUM);
      await time.setNextBlockTimestamp(b.judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(b.claimId)).to.be.revertedWith("awaiting confirmation");
      await expect(sa.connect(other).confirm(b.claimId)).to.emit(sa, "ConfirmationRequested");
    });
  });

  // ------------------------------------------------------------------ E8
  describe("E8: a narrow INVALID returns the bond", function () {
    it("with the floor at 350,000: an INVALID with valid mass 350,000 returns the bond, one with 349,999 forfeits it, and a 500,000 / 500,000 split between INVALID and the valid classes is narrow; no award, nothing published", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker);
      const escrow = (await sa.getListing(id)).escrowWei;
      const cases = [
        { vector: invalidWith(FLOOR), mass: FLOOR, narrow: true },
        { vector: invalidWith(FLOOR - 1n), mass: FLOOR - 1n, narrow: false },
        { vector: SPLIT_50_50, mass: 500_000n, narrow: true },
      ];
      for (const [i, k] of cases.entries()) {
        const hunter = hunters[i];
        const { claimId } = await judged(sa, aggregator, hunter, id, k.vector);
        expect((await sa.getClaim(claimId)).outcome, `case ${i}`).to.equal(Outcome.INVALID);
        const [hunterGets, makerGets] = k.narrow ? [BOND, 0n] : [0n, BOND];
        const tx = sa.connect(other).settle(claimId); // at once: INVALID waits for no window
        await expect(tx).to.changeEtherBalances([hunter, maker], [hunterGets, makerGets]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
        if (k.narrow) await expect(tx).to.emit(sa, "NarrowInvalid").withArgs(claimId, id, k.mass);
        else await expect(tx).to.not.emit(sa, "NarrowInvalid");
        const c = await sa.getClaim(claimId);
        expect([c.paidWei, c.owedWei]).to.deep.equal([0n, 0n]);
      }
      expect(await sa.validFindings(id)).to.deep.equal([]);
      expect((await sa.getListing(id)).escrowWei).to.equal(escrow);
    });

    it("a gate failure (all the mass on INVALID): bond to the maker at every floor", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      for (const [i, floor] of [MIN_FLOOR, FLOOR, THRESHOLD - 1n, THRESHOLD].entries()) {
        await setProgram(sa, owner, { floor });
        const id = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
        const { claimId } = await judged(sa, aggregator, hunters[i], id, V.INVALID);
        const tx = sa.connect(other).settle(claimId);
        await expect(tx, `floor ${floor}`).to.changeEtherBalances([hunters[i], maker], [0n, BOND]);
        await expect(tx).to.not.emit(sa, "NarrowInvalid");
        expect((await sa.getListing(id)).narrowInvalidClaims).to.equal(0n);
      }
    });

    it("a DUPLICATE whose valid mass is inside the band: DUPLICATE, bond back, not counted as narrow", async function () {
      const { sa, aggregator, owner, maker, other, hunter } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker);
      const { claimId } = await judged(sa, aggregator, hunter, id, [0, 600_000, 0, 400_000, 0, 0]);
      expect((await sa.getClaim(claimId)).outcome).to.equal(Outcome.DUPLICATE);
      const tx = sa.connect(other).settle(claimId);
      await expect(tx).to.changeEtherBalances([hunter, maker], [BOND, 0n]);
      await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.DUPLICATE, 0n, 0n);
      await expect(tx).to.not.emit(sa, "NarrowInvalid");
      const l = await sa.getListing(id);
      expect(l.narrowInvalidClaims).to.equal(0n);
      expect([...l.outcomeCounts].map(BigInt)).to.deep.equal([0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("with the band unset (floor THRESHOLD): every INVALID forfeits, so the existing fixtures keep their results", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      expect((await sa.getListing(id)).narrowInvalidFloor).to.equal(THRESHOLD);
      // The largest valid mass an INVALID can have (500,000), the floor's minimum, and a gate failure.
      for (const [i, vector] of [SPLIT_50_50, invalidWith(MIN_FLOOR), invalidWith(THRESHOLD - 1n), V.INVALID].entries()) {
        const { claimId } = await judged(sa, aggregator, hunters[i], id, vector);
        const tx = sa.connect(other).settle(claimId);
        await expect(tx, `vector ${vector}`).to.changeEtherBalances([hunters[i], maker], [0n, BOND]);
        await expect(tx).to.not.emit(sa, "NarrowInvalid");
      }
      expect((await sa.getListing(id)).narrowInvalidClaims).to.equal(0n);
    });

    it("a maker's dispute that turns a valid outcome into a narrow INVALID: bond back to the hunter, the maker's spent prepay not refunded", async function () {
      const { sa, aggregator, owner, maker, other, hunter } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker);
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      await disputeAs(sa, maker, claimId); // the maker pays DF for the round
      expect((await sa.getClaim(claimId)).disputeKind).to.equal(DisputeKind.Maker);
      const leftover = DF / 3n;
      await aggregator.setRefundAmount(leftover);
      // The second finalize: the maker gets back only what the round did not spend.
      const { rc } = await judgeDisputeAs(sa, aggregator, other, claimId, invalidWith(400_000));
      expect(eventsOf(sa, rc, "LeftoverRefunded").map((e) => [e.args.funder, e.args.amountWei])).to.deep.equal([[maker.address, leftover]]);
      const c = await sa.getClaim(claimId);
      expect([c.dispute, c.outcome, c.state]).to.deep.equal([DisputeResult.Overturned, Outcome.INVALID, ClaimState.Judged]);
      // Settled at once (the panel's verdict is final): the bond back, nothing from the escrow
      // or the bond for the maker's spent prepay.
      const escrow = (await sa.getListing(id)).escrowWei;
      const tx = sa.connect(other).settle(claimId);
      await expect(tx).to.changeEtherBalances([hunter, maker], [BOND, 0n]);
      await expect(tx).to.emit(sa, "NarrowInvalid").withArgs(claimId, id, 400_000n);
      expect((await sa.getListing(id)).escrowWei).to.equal(escrow);
      expect(await sa.withdrawable(maker.address)).to.equal(0n);
    });

    it("the record counts a narrow INVALID under INVALID and as narrow", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker);
      for (const [i, vector] of [invalidWith(FLOOR), V.INVALID, invalidWith(420_000)].entries()) {
        const { claimId } = await judged(sa, aggregator, hunters[i], id, vector);
        await sa.connect(other).settle(claimId);
      }
      const l = await sa.getListing(id);
      expect([...l.outcomeCounts].map(BigInt)).to.deep.equal([3n, 0n, 0n, 0n, 0n, 0n]);
      expect(l.narrowInvalidClaims).to.equal(2n);
      const r = await recordOf(sa, id);
      for (const h of [r.history, listingIn(r, id).history]) {
        expect(outcomesOf(h)).to.deep.equal([3n, 0n, 0n, 0n, 0n, 0n]);
        expect(h.narrowInvalid).to.equal(2n);
        expect(h.lateNarrowInvalid).to.equal(0n);
      }
      expect(r.findingCount).to.equal(0n);
    });

    it("a late claim's narrow INVALID returns its bond, counted under later; one below the floor forfeits it", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker);
      await sa.connect(maker).close(id);
      for (const [i, k] of [{ v: invalidWith(450_000), narrow: true }, { v: invalidWith(100_000), narrow: false }].entries()) {
        const { claimId } = await lateClaimAs(sa, hunters[i], id);
        await revealAs(sa, hunters[i], claimId);
        await judgeAs(sa, aggregator, hunters[i], claimId, k.v);
        const tx = sa.connect(other).settle(claimId);
        await expect(tx).to.changeEtherBalances([hunters[i], maker], k.narrow ? [BOND, 0n] : [0n, BOND]);
      }
      const l = await sa.getListing(id);
      expect([l.lateNarrowInvalid, l.narrowInvalidClaims]).to.deep.equal([1n, 0n]);
      expect([...l.lateOutcomeCounts].map(BigInt)).to.deep.equal([2n, 0n, 0n, 0n, 0n, 0n]);
      const h = (await recordOf(sa, id)).history;
      expect([h.lateNarrowInvalid, h.narrowInvalid]).to.deep.equal([1n, 0n]);
    });

    it("the lens reports whether a vector is a narrow INVALID under the listing's floor (judgeVector)", async function () {
      const { sa, owner, maker } = await loadFixture(deployDefaults);
      const unset = await openListing(sa, maker);
      await setProgram(sa, owner, { floor: FLOOR });
      const set = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const lens = new ethers.Contract(await sa.lens(), H.mergedAbi("StakeAttestationLens"), maker);
      const at = async (c, id, v) => {
        const r = await c.judgeVector(id, v);
        return [r.wellFormed, r.outcome, r.awardWei, r.narrow];
      };
      for (const c of [sa, lens]) {
        expect(await at(c, set, invalidWith(FLOOR))).to.deep.equal([true, Outcome.INVALID, 0n, true]);
        expect(await at(c, set, invalidWith(FLOOR - 1n))).to.deep.equal([true, Outcome.INVALID, 0n, false]);
        expect(await at(c, set, SPLIT_50_50)).to.deep.equal([true, Outcome.INVALID, 0n, true]);
        expect(await at(c, set, V.INVALID)).to.deep.equal([true, Outcome.INVALID, 0n, false]);
        expect(await at(c, set, [0, 600_000, 0, 400_000, 0, 0])).to.deep.equal([true, Outcome.DUPLICATE, 0n, false]);
        expect(await at(c, set, V.HIGH)).to.deep.equal([true, Outcome.HIGH, AWARDS[2], false]);
        expect(await at(c, set, [1, 2, 3])).to.deep.equal([false, Outcome.INVALID, 0n, false]);
        expect(await at(c, unset, SPLIT_50_50)).to.deep.equal([true, Outcome.INVALID, 0n, false]);
      }
    });
  });

  // ------------------------------------------------------------------ E9
  describe("E9: above the size, the dispute panel confirms a valid outcome before it pays", function () {
    it("an award above the size, undisputed: settle refused after the dispute window until the confirmation's verdict; confirm takes the prepay from escrowWei and the leftover returns to escrowWei at finalize; held: award and bond paid", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.HIGH);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("dispute window open");
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("awaiting confirmation");
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("awaiting confirmation");

      const leftover = DF / 4n;
      await aggregator.setRefundAmount(leftover);
      const conf = await confirmAs(sa, other, claimId);
      expect(conf.prepayWei).to.equal(DF);
      expect(eventsOf(sa, conf.rc, "ConfirmationRequested")[0].args.slice(0, 2)).to.deep.equal([claimId, id]);
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - DF);
      expect(await aggregator.ethReceived(conf.requestId)).to.equal(DF);
      const c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.disputeKind, c.disputedOutcome]).to.deep.equal([ClaimState.Disputed, DisputeResult.Pending, DisputeKind.Confirmation, Outcome.HIGH]);
      expect([c.disputeWallet, c.disputeRequestId, c.disputedAt]).to.deep.equal([conf.wallet, conf.requestId, conf.at]);
      // The escrow funded the round: the wallet's funder is the contract itself.
      expect([...(await sa.walletInfo(conf.wallet))]).to.deep.equal([sa.target, claimId]);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("not judged");

      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      const fin = sa.connect(other).finalize(claimId);
      await expect(fin).to.emit(sa, "DisputeJudged").withArgs(claimId, id, DisputeResult.Held, Outcome.HIGH, V.HIGH, JUSTIFICATION);
      await expect(fin).to.emit(sa, "LeftoverRefunded").withArgs(claimId, sa.target, leftover);
      await expect(fin).to.emit(sa, "ConfirmationRefunded").withArgs(claimId, id, 0n, leftover, 0n);
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - DF + leftover);

      const settle = sa.connect(other).settle(claimId);
      await expect(settle).to.changeEtherBalances([hunter, maker], [AWARDS[2] + BOND, 0n]);
      await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, AWARDS[2], 0n);
      await expect(settle).to.not.emit(sa, "ConfirmationNoVerdict");
      const l = await sa.getListing(id);
      expect(l.escrowWei).to.equal(2n * TOP - DF + leftover - AWARDS[2]);
      expect([l.confirmationRounds, l.confirmationsHeld, l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([1n, 1n, 0n, 0n]);
      expect([l.disputesFiled, l.disputesHeld]).to.deep.equal([0n, 0n]); // counted apart from the maker's disputes
    });

    it("an award exactly at the size, and one below it: no confirmation; they settle as today", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { size: AWARDS[2] }); // HIGH's award
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      for (const [i, k] of [{ v: V.HIGH, o: Outcome.HIGH, award: AWARDS[2] }, { v: V.MEDIUM, o: Outcome.MEDIUM, award: AWARDS[1] }].entries()) {
        const { claimId, judgedAt } = await judged(sa, aggregator, hunters[i], id, k.v);
        expect(await sa.settleableAt(claimId)).to.equal(judgedAt + DISPUTE);
        expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
        await time.setNextBlockTimestamp(judgedAt + DISPUTE);
        await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("no confirmation due");
        const tx = sa.connect(other).settle(claimId);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunters[i].address, k.o, k.award, 0n);
        await expect(tx).to.changeEtherBalance(hunters[i], k.award + BOND);
      }
      // And CRITICAL, above it, waits.
      const { claimId, judgedAt } = await judged(sa, aggregator, hunters[2], id, V.CRITICAL);
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("awaiting confirmation");
      expect((await sa.getListing(id)).confirmationRounds).to.equal(0n);
    });

    it("overturned to a lower class: that class's award, with no second confirmation; overturned to DUPLICATE: bond back; overturned to INVALID: bond to the maker, or back when narrow", async function () {
      const { sa, aggregator, owner, maker, other, hunter } = await loadFixture(deployDefaults);
      await setProgram(sa, owner, { floor: FLOOR });
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.CRITICAL);
      await atConfirmWindow(sa, claimId);
      await confirmAs(sa, other, claimId);
      const cases = [
        { panel: V.MEDIUM, outcome: Outcome.MEDIUM, hunterGets: AWARDS[1] + BOND, makerGets: 0n, paid: AWARDS[1] },
        { panel: V.DUPLICATE, outcome: Outcome.DUPLICATE, hunterGets: BOND, makerGets: 0n, paid: 0n },
        { panel: V.INVALID, outcome: Outcome.INVALID, hunterGets: 0n, makerGets: BOND, paid: 0n },
        { panel: invalidWith(400_000), outcome: Outcome.INVALID, hunterGets: BOND, makerGets: 0n, paid: 0n },
      ];
      for (const k of cases) {
        const snap = await snapshot();
        await judgeDisputeAs(sa, aggregator, other, claimId, k.panel);
        const c = await sa.getClaim(claimId);
        expect([c.dispute, c.outcome, c.disputeKind]).to.deep.equal([DisputeResult.Overturned, k.outcome, DisputeKind.Confirmation]);
        // The panel's verdict is final: no second confirmation, and settle at once.
        await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("no confirmation due");
        expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
        const tx = sa.connect(other).settle(claimId);
        await expect(tx, `panel ${k.panel}`).to.changeEtherBalances([hunter, maker], [k.hunterGets, k.makerGets]);
        await expect(tx).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, k.outcome, k.paid, 0n);
        const l = await sa.getListing(id);
        expect([l.confirmationsHeld, l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([0n, 1n, 0n]);
        await restore(snap);
      }
    });

    it("a maker's dispute inside the window on a claim above the size: no automatic round; held: the award is paid; with no verdict minutes into the window: confirm refused until the window ends, then available", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      // Held: the maker's dispute was the confirmation.
      const a = await judged(sa, aggregator, hunters[0], id, V.HIGH);
      await disputeAs(sa, maker, a.claimId);
      await judgeDisputeAs(sa, aggregator, other, a.claimId, V.HIGH);
      await expect(sa.connect(other).confirm(a.claimId)).to.be.revertedWith("no confirmation due");
      await expect(sa.connect(other).settle(a.claimId)).to.emit(sa, "Settled").withArgs(a.claimId, id, hunters[0].address, Outcome.HIGH, AWARDS[2], 0n);
      let l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.confirmationRounds]).to.deep.equal([1n, 1n, 0n]);
      expect(l.escrowWei).to.equal(2n * TOP - AWARDS[2]); // the maker paid the round, not the escrow

      // No verdict minutes into the window: the claim waits for the window's end, then confirm.
      const b = await judged(sa, aggregator, hunters[1], id, V.HIGH);
      await disputeAs(sa, maker, b.claimId);
      await time.increase(300); // the mock's response timeout
      await expect(sa.connect(other).finalize(b.claimId)).to.emit(sa, "DisputeFailed");
      expect((await sa.getClaim(b.claimId)).dispute).to.equal(DisputeResult.NoVerdict);
      await expect(sa.connect(other).confirm(b.claimId)).to.be.revertedWith("dispute window open");
      await expect(sa.connect(other).settle(b.claimId)).to.be.revertedWith("awaiting confirmation");
      await time.setNextBlockTimestamp(b.judgedAt + DISPUTE - 1n);
      await expect(sa.connect(other).confirm(b.claimId)).to.be.revertedWith("dispute window open");
      await time.setNextBlockTimestamp(b.judgedAt + DISPUTE);
      const conf = await confirmAs(sa, other, b.claimId);
      expect((await sa.getClaim(b.claimId)).disputeKind).to.equal(DisputeKind.Confirmation);
      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await sa.finalize(b.claimId);
      await expect(sa.connect(other).settle(b.claimId)).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.HIGH, AWARDS[2], 0n);
      l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.disputesNoVerdict]).to.deep.equal([2n, 1n, 1n]);
      expect([l.confirmationRounds, l.confirmationsHeld]).to.deep.equal([1n, 1n]);
    });

    it("confirm before the dispute window ends, or after the confirmation deadline: refused; anyone may call it inside those times", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId, judgedAt } = await judged(sa, aggregator, hunter, id, V.HIGH);
      const opensAt = judgedAt + DISPUTE;
      const deadline = opensAt + REVEAL;
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([opensAt, deadline]);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("dispute window open");
      await time.setNextBlockTimestamp(opensAt - 1n);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("dispute window open");
      for (const [at, who] of [[opensAt, maker], [opensAt, hunter], [opensAt, other], [deadline - 1n, other]]) {
        const snap = await snapshot();
        await time.setNextBlockTimestamp(at);
        await expect(sa.connect(who).confirm(claimId)).to.emit(sa, "ConfirmationRequested");
        await restore(snap);
      }
      await time.setNextBlockTimestamp(deadline);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("confirmation deadline over");
      await expect(sa.connect(other).settle(claimId)).to.emit(sa, "Settled"); // the first verdict stands
    });

    it("a confirmation round that times out: confirm again before the deadline starts a fresh round; no verdict by the deadline and no round open: the first verdict settles and pays, recorded as a confirmation with no verdict", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      const { deadline } = await windowOf(sa, claimId);
      await atConfirmWindow(sa, claimId);
      const first = await confirmAs(sa, other, claimId);
      await time.increase(300);
      await expect(sa.connect(other).finalize(claimId)).to.emit(sa, "DisputeFailed").withArgs(claimId, id, first.requestId, false);
      let c = await sa.getClaim(claimId);
      expect([c.state, c.dispute, c.outcome]).to.deep.equal([ClaimState.Judged, DisputeResult.NoVerdict, Outcome.HIGH]);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("awaiting confirmation");
      expect(await sa.settleableAt(claimId)).to.equal(deadline);

      const second = await confirmAs(sa, hunter, claimId); // a fresh round, a fresh wallet, a fresh prepay
      expect(second.wallet).to.not.equal(first.wallet);
      expect(second.requestId).to.not.equal(first.requestId);
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - 2n * DF);
      // A malformed result is a round with no verdict too.
      await aggregator.scriptResult(second.requestId, [1n, 2n, 3n], JUSTIFICATION);
      await expect(sa.connect(other).finalize(claimId)).to.emit(sa, "DisputeFailed").withArgs(claimId, id, second.requestId, true);

      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("awaiting confirmation");
      await time.setNextBlockTimestamp(deadline);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("confirmation deadline over");
      const settle = sa.connect(other).settle(claimId);
      await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.HIGH, AWARDS[2], 0n);
      await expect(settle).to.emit(sa, "ConfirmationNoVerdict").withArgs(claimId, id);
      await expect(settle).to.changeEtherBalance(hunter, AWARDS[2] + BOND);
      const l = await sa.getListing(id);
      expect([l.confirmationRounds, l.confirmationsHeld, l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([2n, 0n, 0n, 1n]);
      const r = await recordOf(sa, id);
      expect([r.history.confirmationRounds, r.history.confirmationsNoVerdict]).to.deep.equal([2n, 1n]);
      c = await sa.getClaim(claimId);
      expect([c.dispute, c.disputeKind]).to.deep.equal([DisputeResult.NoVerdict, DisputeKind.Confirmation]);
    });

    it("a confirmation started just before the deadline and judged after it: settle refused while it is open, then applies its verdict (an overturn to INVALID forfeits the bond)", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      const { deadline } = await windowOf(sa, claimId);
      await time.setNextBlockTimestamp(deadline - 1n);
      const conf = await confirmAs(sa, other, claimId);
      await time.increaseTo(deadline + 100n);
      await expect(sa.connect(other).settle(claimId)).to.be.revertedWith("not judged");
      expect(await sa.settleableAt(claimId)).to.equal(0n);
      await aggregator.scriptResult(conf.requestId, V.INVALID.map(BigInt), JUSTIFICATION);
      await expect(sa.connect(other).finalize(claimId)).to.emit(sa, "DisputeJudged").withArgs(claimId, id, DisputeResult.Overturned, Outcome.INVALID, V.INVALID, JUSTIFICATION);
      const settle = sa.connect(other).settle(claimId);
      await expect(settle).to.changeEtherBalances([hunter, maker], [0n, BOND]);
      await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.INVALID, 0n, 0n);
      await expect(settle).to.not.emit(sa, "ConfirmationNoVerdict");
      const l = await sa.getListing(id);
      expect([l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([1n, 0n]);
    });

    it("a confirmation whose inline refund was deferred, recovered by recoverLeftoverEth after settle left part of the award owed: the leftover pays that owed award first and only the rest reaches escrowWei; recovered after the listing closed: credited to the maker's pull balance", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      // Part 1: the escrow holds the CRITICAL award plus half a round.
      const id = await openListing(sa, maker, params(), { escrow: TOP + DF / 2n });
      const a = await judged(sa, aggregator, hunters[0], id, V.CRITICAL);
      await atConfirmWindow(sa, a.claimId);
      const conf = await confirmAs(sa, other, a.claimId);
      expect((await sa.getListing(id)).escrowWei).to.equal(TOP - DF / 2n);
      await aggregator.setRefundAmount(DF); // the round spent nothing: all of it comes back
      await aggregator.scriptResult(conf.requestId, V.CRITICAL.map(BigInt), JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      await expect(sa.connect(other).finalize(a.claimId)).to.emit(sa, "RefundDeferred").withArgs(a.claimId, conf.wallet);
      await aggregator.setWithdrawBroken(false);
      await expect(sa.connect(other).settle(a.claimId)).to.emit(sa, "Settled").withArgs(a.claimId, id, hunters[0].address, Outcome.CRITICAL, TOP - DF / 2n, DF / 2n);
      expect((await sa.getListing(id)).owedWei).to.equal(DF / 2n);
      const rec = sa.connect(other).recoverLeftoverEth(conf.wallet);
      await expect(rec).to.emit(sa, "LeftoverRefunded").withArgs(a.claimId, sa.target, DF);
      await expect(rec).to.emit(sa, "OwedPaid").withArgs(a.claimId, id, hunters[0].address, DF / 2n, 0n);
      await expect(rec).to.emit(sa, "ConfirmationRefunded").withArgs(a.claimId, id, DF / 2n, DF / 2n, 0n);
      await expect(rec).to.changeEtherBalances([other, maker], [0n, 0n]); // nothing is pushed; the owed part is a pull credit
      let l = await sa.getListing(id);
      expect([l.owedWei, l.escrowWei, l.state]).to.deep.equal([0n, DF / 2n, ListingState.Depleted]);
      const c = await sa.getClaim(a.claimId);
      expect([c.paidWei, c.owedWei]).to.deep.equal([TOP, 0n]);
      expect(await sa.withdrawable(hunters[0].address)).to.equal(DF / 2n);
      await expect(sa.recoverLeftoverEth(conf.wallet)).to.be.revertedWith("nothing to recover");

      // Part 2: recovered once the listing has closed: the maker's pull balance.
      const id2 = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }), { escrow: 2n * TOP });
      const b = await judged(sa, aggregator, hunters[1], id2, V.HIGH);
      await atConfirmWindow(sa, b.claimId);
      const conf2 = await confirmAs(sa, other, b.claimId);
      await aggregator.setRefundAmount(DF / 5n);
      await aggregator.scriptResult(conf2.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      await sa.connect(other).finalize(b.claimId);
      await aggregator.setWithdrawBroken(false);
      await sa.connect(other).settle(b.claimId);
      await expect(sa.connect(maker).close(id2)).to.emit(sa, "Closed").withArgs(id2, maker.address, 2n * TOP - DF - AWARDS[2]);
      const rec2 = sa.connect(other).recoverLeftoverEth(conf2.wallet);
      await expect(rec2).to.emit(sa, "ConfirmationRefunded").withArgs(b.claimId, id2, 0n, 0n, DF / 5n);
      await expect(rec2).to.not.emit(sa, "OwedPaid");
      l = await sa.getListing(id2);
      expect([l.escrowWei, l.state]).to.deep.equal([0n, ListingState.Closed]);
      expect(await sa.withdrawable(maker.address)).to.equal(DF / 5n);
      await expect(sa.connect(maker).withdraw()).to.changeEtherBalance(maker, DF / 5n, { includeFee: false });
    });

    it("a confirmation submission the aggregator refuses: confirm reverts and nothing changes", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      await atConfirmWindow(sa, claimId);
      const claimBefore = bigintJson(await sa.getClaim(claimId));
      const listingBefore = bigintJson(await sa.getListing(id));
      const balance = await ethers.provider.getBalance(sa.target);
      await aggregator.setPaused(true);
      await expect(sa.connect(other).confirm(claimId)).to.be.reverted;
      await aggregator.setPaused(false);
      // A request that needs more than SUBMISSION_GAS fails as a refusal does: reverted, not caught.
      await aggregator.setRequestGasCost(11_000_000n);
      await expect(sa.connect(other).confirm(claimId, { gasLimit: 15_000_000n })).to.be.reverted;
      await aggregator.setRequestGasCost(0n);
      // Too little gas to forward SUBMISSION_GAS reverts before anything is sent.
      await expect(sa.connect(other).confirm(claimId, { gasLimit: 5_000_000n })).to.be.revertedWith("gas below SUBMISSION_GAS_NEEDED");
      expect(bigintJson(await sa.getClaim(claimId))).to.equal(claimBefore);
      expect(bigintJson(await sa.getListing(id))).to.equal(listingBefore);
      expect(await ethers.provider.getBalance(sa.target)).to.equal(balance);
      await expect(sa.connect(other).confirm(claimId)).to.emit(sa, "ConfirmationRequested"); // and it may be called again
    });

    it("escrowWei below the prepay: confirm refused; a top-up by fund then lets it start; with no top-up, the first verdict settles at the deadline and the award is owed", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker); // escrow exactly the top award
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id); // committed while the listing is Open
      // A takes the whole escrow: its confirmation's prepay first, then its award, the rest owed.
      await revealAs(sa, hunters[0], a.claimId);
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.CRITICAL);
      await atConfirmWindow(sa, a.claimId);
      const ca = await confirmAs(sa, other, a.claimId);
      await aggregator.scriptResult(ca.requestId, V.CRITICAL.map(BigInt), JUSTIFICATION);
      await sa.finalize(a.claimId);
      await sa.settle(a.claimId);
      await sa.connect(maker).fund(id, 0n, { value: DF }); // pays A's owed part: the escrow is empty, nothing owed
      let l = await sa.getListing(id);
      expect([l.escrowWei, l.owedWei, l.state]).to.deep.equal([0n, 0n, ListingState.Depleted]);

      await revealAs(sa, hunters[1], b.claimId);
      const { at: judgedAt } = await judgeAs(sa, aggregator, hunters[1], b.claimId, V.HIGH);
      await time.setNextBlockTimestamp(judgedAt + DISPUTE);
      await expect(sa.connect(other).confirm(b.claimId)).to.be.revertedWith("escrow below fee");

      const snap = await snapshot();
      await sa.connect(maker).fund(id, 0n, { value: DF - 1n });
      await expect(sa.connect(other).confirm(b.claimId)).to.be.revertedWith("escrow below fee");
      await sa.connect(maker).fund(id, 0n, { value: 1n });
      await expect(sa.connect(other).confirm(b.claimId)).to.emit(sa, "ConfirmationRequested");
      expect((await sa.getListing(id)).escrowWei).to.equal(0n);
      await restore(snap);

      // No top-up: the deadline passes with no round, and the first verdict pays what it can.
      await time.setNextBlockTimestamp(judgedAt + DISPUTE + REVEAL);
      const settle = sa.connect(other).settle(b.claimId);
      await expect(settle).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.HIGH, 0n, AWARDS[2]);
      await expect(settle).to.emit(sa, "ConfirmationNoVerdict").withArgs(b.claimId, id);
      l = await sa.getListing(id);
      expect([l.owedWei, l.confirmationRounds, l.confirmationsNoVerdict]).to.deep.equal([AWARDS[2], 1n, 1n]);
    });

    it("a prepay that takes an Open listing's escrow below the top award: the listing is Depleted and refuses commits; an escrow of exactly the award: paid short by what the round spent, that part owed until fund", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker); // escrow exactly awards[CRITICAL]
      const { claimId } = await judged(sa, aggregator, hunters[0], id, V.CRITICAL);
      await atConfirmWindow(sa, claimId);
      await expect(sa.connect(other).confirm(claimId)).to.emit(sa, "Depleted").withArgs(id, TOP - DF);
      const requestId = (await sa.getClaim(claimId)).disputeRequestId;
      expect((await sa.getListing(id)).state).to.equal(ListingState.Depleted);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(hunters[1]).commit(id, H.ARCHIVE, H.CT, { value: await sa.commitPrice(id) })).to.be.revertedWith("not accepting commits");

      const spentPart = DF - DF / 4n;
      await aggregator.setRefundAmount(DF / 4n);
      await aggregator.scriptResult(requestId, V.CRITICAL.map(BigInt), JUSTIFICATION);
      await sa.finalize(claimId);
      expect((await sa.getListing(id)).escrowWei).to.equal(TOP - spentPart);
      await expect(sa.connect(other).settle(claimId)).to.emit(sa, "Settled").withArgs(claimId, id, hunters[0].address, Outcome.CRITICAL, TOP - spentPart, spentPart);
      expect((await sa.getListing(id)).owedWei).to.equal(spentPart);
      const top = sa.connect(maker).fund(id, 0n, { value: spentPart });
      await expect(top).to.emit(sa, "OwedPaid").withArgs(claimId, id, hunters[0].address, spentPart, 0n);
      const c = await sa.getClaim(claimId);
      expect([c.paidWei, c.owedWei]).to.deep.equal([TOP, 0n]);
    });

    it("a leftover that brings a Depleted listing back to the top award reopens it, as fund does", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: TOP + DF / 2n });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      await atConfirmWindow(sa, claimId);
      const conf = await confirmAs(sa, other, claimId);
      expect((await sa.getListing(id)).state).to.equal(ListingState.Depleted);
      await aggregator.setRefundAmount(DF);
      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      const fin = sa.connect(other).finalize(claimId);
      await expect(fin).to.emit(sa, "Reopened").withArgs(id, TOP + DF / 2n);
      await expect(fin).to.emit(sa, "ConfirmationRefunded").withArgs(claimId, id, 0n, DF, 0n);
      await expect(fin).to.not.emit(sa, "Funded");
      expect((await sa.getListing(id)).state).to.equal(ListingState.Open);
    });

    it("earlier awards owed on the listing: confirm refused (the escrow is empty) until fund has paid them, in commit order, before any confirmation prepay", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      const c = await claimAs(sa, hunters[2], id);
      // A: confirmed, paid short by its round's prepay (owed DF).
      await revealAs(sa, hunters[0], a.claimId);
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.CRITICAL);
      await atConfirmWindow(sa, a.claimId);
      const ca = await confirmAs(sa, other, a.claimId);
      await aggregator.scriptResult(ca.requestId, V.CRITICAL.map(BigInt), JUSTIFICATION);
      await sa.finalize(a.claimId);
      await sa.settle(a.claimId);
      // B: its confirmation is refused while A is owed; at its deadline it settles unconfirmed, all owed.
      await revealAs(sa, hunters[1], b.claimId);
      const { at: bAt } = await judgeAs(sa, aggregator, hunters[1], b.claimId, V.MEDIUM);
      await time.setNextBlockTimestamp(bAt + DISPUTE);
      await expect(sa.connect(other).confirm(b.claimId)).to.be.revertedWith("awards owed");
      await time.setNextBlockTimestamp(bAt + DISPUTE + REVEAL);
      await expect(sa.settle(b.claimId)).to.emit(sa, "Settled").withArgs(b.claimId, id, hunters[1].address, Outcome.MEDIUM, 0n, AWARDS[1]);
      expect((await sa.getListing(id)).owedWei).to.equal(DF + AWARDS[1]);
      // C: refused until A's and B's owed awards are paid, in commit order, and the escrow holds a round.
      await revealAs(sa, hunters[2], c.claimId);
      const { at: cAt } = await judgeAs(sa, aggregator, hunters[2], c.claimId, V.HIGH);
      await time.setNextBlockTimestamp(cAt + DISPUTE);
      await expect(sa.connect(other).confirm(c.claimId)).to.be.revertedWith("awards owed");
      const t1 = sa.connect(maker).fund(id, 0n, { value: DF + AWARDS[1] / 2n });
      await expect(t1).to.emit(sa, "OwedPaid").withArgs(a.claimId, id, hunters[0].address, DF, 0n);
      await expect(t1).to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[1] / 2n, AWARDS[1] / 2n);
      await expect(sa.connect(other).confirm(c.claimId)).to.be.revertedWith("awards owed");
      const t2 = sa.connect(maker).fund(id, 0n, { value: AWARDS[1] / 2n + DF });
      await expect(t2).to.emit(sa, "OwedPaid").withArgs(b.claimId, id, hunters[1].address, AWARDS[1] / 2n, 0n);
      await expect(t2).to.emit(sa, "Funded").withArgs(id, maker.address, DF, DF);
      await expect(sa.connect(other).confirm(c.claimId)).to.emit(sa, "ConfirmationRequested");
      const l = await sa.getListing(id);
      expect([l.owedWei, l.escrowWei]).to.deep.equal([0n, 0n]);
    });

    it("a late claim's valid outcome: no confirmation", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await sa.connect(maker).rollForward(id, successor);
      const { claimId } = await lateClaimAs(sa, hunter, id);
      await revealAs(sa, hunter, claimId);
      const { at } = await judgeAs(sa, aggregator, hunter, claimId, V.CRITICAL);
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
      expect(await sa.settleableAt(claimId)).to.equal(at + DISPUTE);
      await time.setNextBlockTimestamp(at + DISPUTE);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("no confirmation due");
      const settle = sa.connect(other).settle(claimId);
      await expect(settle).to.emit(sa, "Settled").withArgs(claimId, id, hunter.address, Outcome.CRITICAL, 0n, 0n);
      await expect(settle).to.changeEtherBalance(hunter, BOND);
    });

    it("with the size unset (0): every counted award is confirmed, and a class below lowestClassCounted never is", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const awards = [ethers.parseEther("0.05"), ...AWARDS.slice(1)]; // LOW has an award, but MEDIUM is the lowest counted
      const id = await openListing(sa, maker, params({ awards }), { escrow: 2n * TOP });
      expect((await sa.getListing(id)).confirmAboveWei).to.equal(0n);
      const low = await judged(sa, aggregator, hunters[0], id, V.LOW);
      expect([...(await sa.confirmWindow(low.claimId))]).to.deep.equal([0n, 0n]);
      await time.setNextBlockTimestamp(low.judgedAt + DISPUTE);
      await expect(sa.connect(other).confirm(low.claimId)).to.be.revertedWith("no confirmation due");
      await expect(sa.connect(other).settle(low.claimId)).to.emit(sa, "Settled").withArgs(low.claimId, id, hunters[0].address, Outcome.LOW, 0n, 0n);
      // Every counted class, each the claim round's verdict of the next claim on the listing.
      for (const [i, [vector, outcome]] of [[V.MEDIUM, Outcome.MEDIUM], [V.HIGH, Outcome.HIGH], [V.CRITICAL, Outcome.CRITICAL]].entries()) {
        const snap = await snapshot();
        const j = await judged(sa, aggregator, hunters[1 + i], id, vector);
        await time.setNextBlockTimestamp(j.judgedAt + DISPUTE);
        await expect(sa.connect(other).settle(j.claimId), `${outcome}`).to.be.revertedWith("awaiting confirmation");
        await expect(sa.connect(other).confirm(j.claimId)).to.emit(sa, "ConfirmationRequested");
        await restore(snap);
      }
    });

    it("the next claim's reveal waits while a claim awaits its confirmation, and close is refused meanwhile", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await revealAs(sa, hunters[0], a.claimId);
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.HIGH);
      const { opensAt, deadline } = await windowOf(sa, a.claimId);
      await time.setNextBlockTimestamp(opensAt + 1n);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, H.CK, H.EK)).to.be.revertedWith("earlier claim unresolved");
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, H.CK, H.EK)).to.be.revertedWith("earlier claim unresolved");
      const conf = await confirmAs(sa, other, a.claimId);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await sa.finalize(a.claimId);
      await sa.settle(a.claimId);
      await expect(sa.connect(hunters[1]).reveal(b.claimId, BCID, H.CK, H.EK, { value: await sa.revealTopUp(b.claimId) })).to.emit(sa, "Revealed");
    });

    it("the request is the dispute's without the dispute line: cids = [disputeCid, the claim's bcid, the prior findings its round carried], the E1 line alone, the dispute panel's fee, exactly SUBMISSION_GAS", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const awards = [ethers.parseEther("0.05"), ...AWARDS.slice(1)];
      const id = await openListing(sa, maker, params({ awards }), { escrow: 2n * TOP });
      // A prior valid finding that needs no confirmation: LOW, below the counted class.
      const prior = await judged(sa, aggregator, hunters[0], id, V.LOW, { bcid: cidOf(1) });
      await time.setNextBlockTimestamp(prior.judgedAt + DISPUTE);
      await sa.settle(prior.claimId);
      const { claimId, requestId: roundId } = await judged(sa, aggregator, hunters[1], id, V.HIGH, { bcid: cidOf(2) });
      await atConfirmWindow(sa, claimId);
      const { requestId } = await confirmAs(sa, other, claimId);
      expect(await aggregator.getRequestCids(requestId)).to.deep.equal([DISPUTE_CID, cidOf(2), cidOf(1)]);
      expect(await aggregator.getRequestCids(roundId)).to.deep.equal([LISTING_CID, cidOf(2), cidOf(1)]);
      const p = await aggregator.requestParams(requestId);
      const round = await aggregator.requestParams(roundId);
      expect(p.addendum).to.equal(round.addendum); // the claim round's E1 line, and nothing else
      expect(p.addendum).to.match(/^verdikta-disclosure: 0x[0-9a-f]{64} 0x[0-9a-f]{64} \S+ 0x[0-9a-f]{32} 0x[0-9a-f]{64}$/);
      expect(p.addendum).to.not.include("verdikta-dispute");
      expect([p.maxFee, p.requestedClass, p.alpha, p.estimatedBaseCost, p.maxFeeBasedScaling])
        .to.deep.equal([ORACLE.disputeMaxOracleFee, ORACLE.requestedClass, ORACLE.alpha, ORACLE.estimatedBaseCost, ORACLE.maxFeeBasedScaling]);
      expect(await aggregator.ethReceived(requestId)).to.equal(DF);
    });

    it("the fee is live: it follows the aggregator's multiplier and ceiling, as the lens's disputeFee quotes it; refused when the aggregator quotes no budget", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const { claimId } = await judged(sa, aggregator, hunter, id, V.HIGH);
      await atConfirmWindow(sa, claimId);
      const snap = await snapshot();
      await aggregator.setFeeMultiplier(0n);
      await expect(sa.connect(other).confirm(claimId)).to.be.revertedWith("bad budget");
      await restore(snap);
      await aggregator.setFeeMultiplier(7n);
      const quoted = await sa.disputeFee(id);
      expect(quoted).to.equal(ORACLE.disputeMaxOracleFee * 7n);
      const { prepayWei } = await confirmAs(sa, other, claimId);
      expect(prepayWei).to.equal(quoted);
      expect((await sa.getListing(id)).escrowWei).to.equal(2n * TOP - quoted);
    });

    it("refused on a claim that is not Judged: committed, revealed, disputed or settled", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const a = await claimAs(sa, hunters[0], id);
      await expect(sa.connect(other).confirm(a.claimId)).to.be.revertedWith("not judged");
      await revealAs(sa, hunters[0], a.claimId);
      await expect(sa.connect(other).confirm(a.claimId)).to.be.revertedWith("not judged");
      await judgeAs(sa, aggregator, hunters[0], a.claimId, V.HIGH);
      await atConfirmWindow(sa, a.claimId);
      const conf = await confirmAs(sa, other, a.claimId);
      await expect(sa.connect(other).confirm(a.claimId)).to.be.revertedWith("not judged");
      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      await sa.finalize(a.claimId);
      await sa.settle(a.claimId);
      await expect(sa.connect(other).confirm(a.claimId)).to.be.revertedWith("not judged");
      await expect(sa.connect(other).confirm(99n)).to.be.revertedWith("bad claimId");
      // INVALID and DUPLICATE have no award to confirm.
      for (const v of [V.INVALID, V.DUPLICATE]) {
        const k = await judged(sa, aggregator, hunters[1], id, v);
        await expect(sa.connect(other).confirm(k.claimId)).to.be.revertedWith("no confirmation due");
        await sa.settle(k.claimId);
      }
    });
  });

  // ------------------------------------------------------------------ the record and the views
  describe("the record, the views and the ABI", function () {
    it("finalize counts maker's disputes and confirmations apart, by result; a finding carries its round's kind", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 3n * TOP });
      const settleAfter = async (claimId) => {
        const { deadline } = await windowOf(sa, claimId);
        const c = await sa.getClaim(claimId);
        if (c.dispute === DisputeResult.NoVerdict && BigInt(await time.latest()) < deadline) await time.setNextBlockTimestamp(deadline);
        await sa.connect(other).settle(claimId);
      };
      // A: the maker's dispute, held.
      const a = await judged(sa, aggregator, hunters[0], id, V.HIGH, { bcid: cidOf(1) });
      await disputeAs(sa, maker, a.claimId);
      await judgeDisputeAs(sa, aggregator, other, a.claimId, V.HIGH);
      await settleAfter(a.claimId);
      // B: a confirmation, held.
      const b = await judged(sa, aggregator, hunters[1], id, V.HIGH, { bcid: cidOf(2) });
      await atConfirmWindow(sa, b.claimId);
      await confirmAs(sa, other, b.claimId);
      await judgeDisputeAs(sa, aggregator, other, b.claimId, V.HIGH);
      await settleAfter(b.claimId);
      // C: a confirmation, overturned to MEDIUM.
      const c = await judged(sa, aggregator, hunters[2], id, V.HIGH, { bcid: cidOf(3) });
      await atConfirmWindow(sa, c.claimId);
      await confirmAs(sa, other, c.claimId);
      await judgeDisputeAs(sa, aggregator, other, c.claimId, V.MEDIUM);
      await settleAfter(c.claimId);
      // D: the maker's dispute with no verdict, then a confirmation with none, then the deadline.
      const d = await judged(sa, aggregator, hunters[3], id, V.HIGH, { bcid: cidOf(4) });
      await disputeAs(sa, maker, d.claimId);
      await time.increase(300);
      await sa.finalize(d.claimId);
      await atConfirmWindow(sa, d.claimId);
      await confirmAs(sa, other, d.claimId);
      await time.increase(300);
      await sa.finalize(d.claimId);
      await settleAfter(d.claimId);

      const l = await sa.getListing(id);
      expect([l.disputesFiled, l.disputesHeld, l.disputesOverturned, l.disputesNoVerdict]).to.deep.equal([2n, 1n, 0n, 1n]);
      expect([l.confirmationRounds, l.confirmationsHeld, l.confirmationsOverturned, l.confirmationsNoVerdict]).to.deep.equal([3n, 1n, 1n, 1n]);
      const r = await recordOf(sa, id);
      for (const h of [r.history, listingIn(r, id).history]) {
        expect([h.disputes, h.disputesHeld, h.disputesOverturned, h.disputesNoVerdict]).to.deep.equal([2n, 1n, 0n, 1n]);
        expect([h.confirmationRounds, h.confirmationsHeld, h.confirmationsOverturned, h.confirmationsNoVerdict]).to.deep.equal([3n, 1n, 1n, 1n]);
      }
      const findings = [...r.findings].map((f) => [f.claimId, f.outcome, f.dispute, f.disputeKind]);
      expect(findings).to.deep.equal([
        [a.claimId, Outcome.HIGH, DisputeResult.Held, DisputeKind.Maker],
        [b.claimId, Outcome.HIGH, DisputeResult.Held, DisputeKind.Confirmation],
        [c.claimId, Outcome.MEDIUM, DisputeResult.Overturned, DisputeKind.Confirmation],
        [d.claimId, Outcome.HIGH, DisputeResult.NoVerdict, DisputeKind.Confirmation],
      ]);
      // A late claim's dispute is on its finding and in no count, as before.
      expect(r.history.lateClaims).to.equal(0n);
    });

    it("settleableAt and confirmWindow (the lens) report a pending confirmation and its deadline", async function () {
      const { sa, aggregator, owner, maker, other, hunters } = await loadFixture(deployDefaults);
      const id = await openListing(sa, maker, params(), { escrow: 2n * TOP });
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      const { claimId } = await claimAs(sa, hunters[0], id);
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
      await revealAs(sa, hunters[0], claimId);
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
      const { at: judgedAt } = await judgeAs(sa, aggregator, hunters[0], claimId, V.HIGH);
      const opensAt = judgedAt + DISPUTE;
      const deadline = opensAt + REVEAL;
      for (const c of [sa, lens]) {
        expect([...(await c.confirmWindow(claimId))]).to.deep.equal([opensAt, deadline]);
        expect(await c.settleableAt(claimId)).to.equal(deadline);
      }
      await time.setNextBlockTimestamp(opensAt);
      const conf = await confirmAs(sa, other, claimId);
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([opensAt, deadline]); // in case it settles no verdict
      expect(await sa.settleableAt(claimId)).to.equal(0n);
      expect(await sa.disputeDeadline(claimId)).to.equal(0n);
      await aggregator.scriptResult(conf.requestId, V.HIGH.map(BigInt), JUSTIFICATION);
      const rc = await (await sa.finalize(claimId)).wait();
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
      expect(await sa.settleableAt(claimId)).to.equal(await blockTime(rc));
      await sa.settle(claimId);
      expect([...(await sa.confirmWindow(claimId))]).to.deep.equal([0n, 0n]);
      expect(await sa.settleableAt(claimId)).to.equal(0n);
      // The confirmation costs the dispute panel's fee, which disputeFee quotes.
      expect(await lens.disputeFee(id)).to.equal(DF);
      // A listing made after the owner raised the size: no window.
      await setProgram(sa, owner, { size: MaxUint256 });
      const id2 = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const k = await judged(sa, aggregator, hunters[1], id2, V.CRITICAL);
      expect([...(await sa.confirmWindow(k.claimId))]).to.deep.equal([0n, 0n]);
      expect(await sa.settleableAt(k.claimId)).to.equal(k.judgedAt + DISPUTE);
    });

    it("ClaimState and DisputeResult keep their values; DisputeKind is new; the new fields are appended to Listing and Claim", async function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "StakeAttestation.sol"), "utf8");
      const enumOf = (name) => src.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))[1].split(",").map((s) => s.trim());
      expect(enumOf("ClaimState")).to.deep.equal(["Committed", "Revealable", "Revealed", "Judged", "Disputed", "Settled", "Expired", "RoundFailed"]);
      expect(enumOf("DisputeResult")).to.deep.equal(["None", "Pending", "Held", "Overturned", "NoVerdict"]);
      expect(enumOf("DisputeKind")).to.deep.equal(["None", "Maker", "Confirmation"]);

      const { sa } = await loadFixture(deployDefaults);
      const names = (fn) => sa.interface.getFunction(fn).outputs[0].components.map((c) => c.name);
      // The fields as they were before this node (node P2e), in order: the new ones come after.
      const LISTING_BEFORE = [
        "maker", "state", "artifactKind", "lowestClassCounted", "listedAt", "openedAt", "fundedUntil", "fixWindow",
        "disputeWindow", "disclosureGrace", "revealWindow", "artifactAddress", "artifactChainId", "artifactHash",
        "disclosureKey", "listingCid", "disputeCid", "awards", "bondWei", "valueAtRiskUsd", "knownIssueIds", "allowlist",
        "oracle", "escrowWei", "owedWei", "pendingClaims", "predecessor", "successor", "rolledAt", "headClaim", "tailClaim",
        "headSince", "claimsCommitted", "undisclosedClaims", "unrevealedClaims", "outcomeCounts", "owedCursor",
        "noVerdictClaims", "disputesFiled", "disputesHeld", "disputesOverturned", "disputesNoVerdict", "closedAt",
        "releasedClaims", "lateClaims", "lateExpired", "lateOutcomeCounts",
      ];
      const CLAIM_BEFORE = [
        "hunter", "committedAt", "state", "expiry", "flaggedBadDisclosure", "released", "listingId", "disclosedAt",
        "fixWindowEnd", "revealedAt", "prevInOrder", "nextInOrder", "contentKey", "evalWallet", "disclosedAfterRoll",
        "bondWei", "prepayWei", "archiveHash", "ciphertextSha256", "ephemeralKey", "requestId", "ciphertextCid", "bcid",
        "vector", "judgedAt", "settledAt", "outcome", "paidWei", "owedWei", "failedAt", "roundStarted", "dispute",
        "disputedOutcome", "disputedAt", "disputeEndedAt", "late", "disputeWallet", "disputeRequestId",
      ];
      expect(names("getListing")).to.deep.equal([
        ...LISTING_BEFORE,
        "narrowInvalidFloor", "confirmAboveWei", "narrowInvalidClaims", "lateNarrowInvalid", "confirmationRounds",
        "confirmationsHeld", "confirmationsOverturned", "confirmationsNoVerdict",
      ]);
      expect(names("getClaim")).to.deep.equal([...CLAIM_BEFORE, "disputeKind"]);
    });

    it("declares an event for every state change this node adds", async function () {
      const { sa } = await loadFixture(deployDefaults);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of ["NarrowInvalidFloorSet", "ConfirmAboveWeiSet", "ConfirmationRequested", "ConfirmationRefunded", "ConfirmationNoVerdict", "NarrowInvalid"]) {
        expect(events, name).to.include(name);
      }
      expect(sa.interface.getEvent("ConfirmationRequested").inputs.map((i) => i.name)).to.deep.equal(["claimId", "listingId", "wallet", "requestId", "prepayWei"]);
      expect(sa.interface.getEvent("ConfirmationRefunded").inputs.map((i) => i.name)).to.deep.equal(["claimId", "listingId", "toOwedWei", "toEscrowWei", "toMakerWei"]);
    });
  });
});
