// Review 2026-11-27, item 2: one re-trigger after a claim round that ran.
// The hunter pins the claim and its ciphertext; a jury that cannot fetch them does not commit, and
// such a round costs only its base fees. With unlimited re-triggers inside the window every failed
// round was another jury to choose from. Now: a claim gets at most two juries, and once the
// re-trigger is spent and its round has failed too, anyone may expire the claim at once.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const { ClaimState, Expiry, REVEAL, BOND, FEE, V, deploy, openListing, revealedClaim, drawAs, expireRound, judgeAs } = H;

async function fixture() {
  const f = await deploy();
  const listingId = await openListing(f.sa, f.maker);
  return { ...f, listingId };
}

// reveal, then a round that is drawn and gets no commits (what withheld content looks like)
async function failedOnce(f) {
  const { sa, aggregator, hunter, listingId } = f;
  const { claimId } = await revealedClaim(sa, hunter, listingId);
  await expireRound(sa, aggregator, claimId);
  await sa.finalize(claimId);
  expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
  return claimId;
}

describe("StakeAttestation: one re-trigger per claim round (review 2026-11-27, item 2)", function () {
  it("a second failed round cannot be re-triggered: 'already retriggered'", async function () {
    const f = await loadFixture(fixture);
    const { sa, aggregator, hunter } = f;
    const claimId = await failedOnce(f);
    expect(await sa.claimRetriggered(claimId)).to.equal(false);
    expect(await sa.retriggerTopUp(claimId)).to.equal(FEE);
    await sa.connect(hunter).retrigger(claimId, { value: FEE });
    expect(await sa.claimRetriggered(claimId)).to.equal(true);
    await expireRound(sa, aggregator, claimId);
    await sa.finalize(claimId);
    expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
    await expect(sa.connect(hunter).retrigger(claimId, { value: FEE })).to.be.revertedWith("already retriggered");
    // the lens: nothing to pay, and the deadline is the time it first failed (expirable now)
    expect(await sa.retriggerTopUp(claimId)).to.equal(0n);
    expect(await sa.retriggerDeadline(claimId)).to.equal((await sa.getClaim(claimId)).failedAt);
  });

  it("once the re-trigger is spent, anyone may expire at once (the queue is not held for revealWindow)", async function () {
    const f = await loadFixture(fixture);
    const { sa, aggregator, hunter, maker, listingId } = f;
    const claimId = await failedOnce(f);
    // before the re-trigger is used the window still protects the hunter
    await expect(sa.expire(claimId)).to.be.revertedWith("retrigger window open");
    await sa.connect(hunter).retrigger(claimId, { value: FEE });
    await expireRound(sa, aggregator, claimId);
    await sa.finalize(claimId);
    const { failedAt } = await sa.getClaim(claimId);
    expect(BigInt(await time.latest())).to.be.lessThan(failedAt + REVEAL);
    const tx = sa.connect(maker).expire(claimId);
    await expect(tx).to.changeEtherBalances([maker, hunter], [0n, BOND]);   // no jury answered: bond back
    await expect(tx).to.emit(sa, "Expired").withArgs(claimId, listingId, Expiry.RoundsUnanswered);
  });

  it("the second jury still judges: a re-triggered round that answers is the verdict", async function () {
    const f = await loadFixture(fixture);
    const { sa, aggregator, hunter } = f;
    const claimId = await failedOnce(f);
    await sa.connect(hunter).retrigger(claimId, { value: FEE });
    await judgeAs(sa, aggregator, hunter, claimId, V.HIGH);
    expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
  });

  it("the flag is per claim", async function () {
    const f = await loadFixture(fixture);
    const { sa, hunter } = f;
    const a = await failedOnce(f);
    await sa.connect(hunter).retrigger(a, { value: FEE });
    expect(await sa.claimRetriggered(a)).to.equal(true);
    expect(await sa.claimRetriggered(a + 1n)).to.equal(false);
    // read at the lens's own address it answers through the host, the same
    const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
    expect(await lens.claimRetriggered(a)).to.equal(true);
  });
});
