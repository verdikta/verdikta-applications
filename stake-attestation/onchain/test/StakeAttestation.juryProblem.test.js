// StakeAttestation: juryProblem (review 2026-11-26 #19, an accepted limitation). setOracle checks only
// the jury's structure; the aggregator's live, owner-set limits are checked by each request. A hunter
// checks the listing's terms BEFORE committing (disclosure follows the commit), and this lens view is
// how; the tool and the site refuse to commit while it names a problem.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

describe("StakeAttestation: juryProblem (review #19)", function () {
  const listWith = async (f, jury) =>
    H.openListing(f.sa, f.maker, H.params({ artifact: H.atCommit(H.freshCommit()), oracle: { ...H.ORACLE, jury } }));

  it("is empty for the default jury", async function () {
    const f = await loadFixture(H.deploy);
    expect(await f.sa.juryProblem(await listWith(f, H.ORACLE.jury))).to.equal("");
  });

  for (const [label, jury, reason] of [
    ["timeout at T+", { ...H.ORACLE.jury, timeout: 155 }, "timeout at or below tPlus"],
    ["timeout above maxTimeout", { ...H.ORACLE.jury, timeout: 7200 }, "timeout above maxTimeout"],
    ["K above maxJury", { K: 60, M: 40, N: 40, P: 3, timeout: 300 }, "K above maxJury"],
  ]) {
    it(`${label}: listed, and named`, async function () {
      const f = await loadFixture(H.deploy);
      expect(await f.sa.juryProblem(await listWith(f, jury))).to.equal(reason);
    });
  }

  it("the owner's limitImpact script reads Open listings with their jury from the committed ABI", async function () {
    const LI = require("../../../example-bounty-program/server/scripts/limitImpact.js");
    const f = await loadFixture(H.deploy);
    const id = await listWith(f, H.ORACLE.jury);
    const live = await LI.liveListings(ethers.provider, f.sa.target);
    const mine = live.find((x) => x.id === Number(id));
    expect(mine.jury).to.deep.equal({ K: H.ORACLE.jury.K, timeout: H.ORACLE.jury.timeout });
    const cur = { maxJury: 50, maxTimeout: 3600, tPlus: 155, shortlist: 60 };
    expect(LI.impactOf(cur, { ...cur, shortlist: 5 }, [mine]).stranded.map((x) => x.reason)).to.deep.equal(["K above the keeper's shortlist"]);
  });

  it("follows a limit tightened after listing, and answers the same directly at the lens", async function () {
    const f = await loadFixture(H.deploy);
    const id = await listWith(f, H.ORACLE.jury);
    await f.aggregator.setLimits(5, 3600);                                   // maxJury below K = 6
    expect(await f.sa.juryProblem(id)).to.equal("K above maxJury");
    const lens = await ethers.getContractAt("StakeAttestationLens", await f.sa.lens());
    expect(await lens.juryProblem(id)).to.equal("K above maxJury");
  });
});
