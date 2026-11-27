// StakeAttestation: an exact copy of an earlier valid finding settles DUPLICATE (review
// 2026-11-26 finding 9). Requests carry at most MAX_PRIOR_FINDINGS (8) priors, so before this an
// exact repeat of an older finding reached a jury that had never seen the original, and was paid
// again. ClaimLogic.settle now keeps, per listing, the archive hash of every valid finding it
// publishes; a later claim with the same hash settles DUPLICATE (bond back, no award, not
// published) whatever its verdict. Checked at settle, so a bare commit reserves nothing.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const { Outcome, V, BOND, AWARDS, eventsOf, openListing, claimAs, revealAs, judgeAs, afterDisputeWindow, recordOf, findingIds } = H;
const { parseEther, sha256, toUtf8Bytes } = ethers;

const bcidN = (i) => "bafkrei" + String.fromCharCode(97 + (i % 26)).repeat(52); // 59 chars, distinct
const archN = (i) => sha256(toUtf8Bytes("archive " + i));

describe("StakeAttestation: exact duplicates of earlier valid findings (review #9)", function () {
  async function fixture() {
    const f = await H.deploy();
    const p = H.params({ fixWindow: 0n });
    const listingId = await openListing(f.sa, f.maker, p, { escrow: parseEther("10") });
    return { ...f, p, listingId };
  }

  // One claim through commit, disclose, reveal, judgement and settle.
  async function settled(f, hunter, archive, bcid, vector = V.MEDIUM, listingId = f.listingId) {
    const { claimId } = await claimAs(f.sa, hunter, listingId, { archive });
    const { requestId } = await revealAs(f.sa, hunter, claimId, { bcid });
    const cids = [...(await f.aggregator.getRequestCids(requestId))];
    await judgeAs(f.sa, f.aggregator, hunter, claimId, vector);
    await afterDisputeWindow(f.sa, claimId);
    const tx = f.sa.settle(claimId);
    const rc = await (await tx).wait();
    return { claimId, cids, tx, rc, settledEv: eventsOf(f.sa, rc, "Settled")[0] };
  }

  it("the oldest finding repeated after nine distinct ones: out of the priors, yet DUPLICATE, nothing paid", async function () {
    const f = await loadFixture(fixture);
    const first = [];
    for (let i = 0; i < 9; i++) first.push(await settled(f, f.hunters[i % 3], archN(i), bcidN(i)));
    expect(first[0].settledEv.args.paidWei).to.equal(AWARDS[1]);           // MEDIUM's award

    const copier = f.hunters[5];
    const before = await ethers.provider.getBalance(copier.address);
    const r = await settled(f, copier, archN(0), bcidN(0));
    expect(r.cids.slice(2)).to.not.include(bcidN(0));                      // the jury never saw it
    await expect(r.tx).to.emit(f.sa, "ExactDuplicate").withArgs(r.claimId, f.listingId, first[0].claimId);
    await expect(r.tx).to.emit(f.sa, "Settled").withArgs(r.claimId, f.listingId, copier.address, Outcome.DUPLICATE, 0n, 0n);
    expect((await f.sa.getClaim(r.claimId)).outcome).to.equal(Outcome.DUPLICATE);
    const rec = await recordOf(f.sa, f.listingId);
    expect(findingIds(rec)).to.not.include(r.claimId);                     // not published
    expect(findingIds(rec)).to.have.length(9);
    expect([...rec.history.outcomes][1]).to.equal(1n);
    // the copier got its bond back (less gas), not an award
    const after = await ethers.provider.getBalance(copier.address);
    expect(after - before).to.be.lessThan(BOND);
  });

  it("the same archive under another CID is the same finding", async function () {
    const f = await loadFixture(fixture);
    const a = await settled(f, f.hunters[0], archN(0), bcidN(0));
    const b = await settled(f, f.hunters[1], archN(0), bcidN(7));
    await expect(b.tx).to.emit(f.sa, "ExactDuplicate").withArgs(b.claimId, f.listingId, a.claimId);
  });

  it("only a VALID finding holds its archive: after an INVALID claim, the same archive judged valid is paid", async function () {
    const f = await loadFixture(fixture);
    await settled(f, f.hunters[0], archN(0), bcidN(0), V.INVALID);
    const b = await settled(f, f.hunters[1], archN(0), bcidN(0));
    await expect(b.tx).to.not.emit(f.sa, "ExactDuplicate");
    expect(b.settledEv.args.paidWei).to.equal(AWARDS[1]);
  });

  it("a jury's own DUPLICATE verdict does not take the archive", async function () {
    const f = await loadFixture(fixture);
    await settled(f, f.hunters[0], archN(0), bcidN(0), V.DUPLICATE);
    expect(await f.sa.validFindingOf(f.listingId, archN(0))).to.equal(0n);
  });

  it("per listing: the same archive on another listing is judged on its own", async function () {
    const f = await loadFixture(fixture);
    await settled(f, f.hunters[0], archN(0), bcidN(0));
    const other = await openListing(f.sa, f.maker, H.params({ fixWindow: 0n, artifact: H.atCommit(H.freshCommit()) }), { escrow: parseEther("10") }); // another artifact
    const b = await settled(f, f.hunters[1], archN(0), bcidN(0), V.MEDIUM, other);
    await expect(b.tx).to.not.emit(f.sa, "ExactDuplicate");
    expect(b.settledEv.args.paidWei).to.equal(AWARDS[1]);
  });

  it("validFindingOf names the original at the StakeAttestation address, and refuses to answer directly at the lens", async function () {
    const f = await loadFixture(fixture);
    expect(await f.sa.validFindingOf(f.listingId, archN(0))).to.equal(0n);
    const a = await settled(f, f.hunters[0], archN(0), bcidN(0));
    expect(await f.sa.validFindingOf(f.listingId, archN(0))).to.equal(a.claimId);
    expect(await f.sa.validFindingOf(f.listingId, archN(1))).to.equal(0n);
    const lens = await ethers.getContractAt("StakeAttestationLens", await f.sa.lens());
    await expect(lens.validFindingOf(f.listingId, archN(0))).to.be.revertedWith("call at the StakeAttestation address");
  });
});
