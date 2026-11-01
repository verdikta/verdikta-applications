// StakeAttestation, claim lifecycle (build node P2b): commit, disclose, flagBadDisclosure,
// release, rollForward, reveal and expire, the commit-order queue (decision D5) and the request
// composition (design §13.3 with errata E1-E3). Design: verdikta-arbiter
// docs/development/stake-attestation-design.md §13.1-§13.3, §7.1, §8.7, §14; the build plan's
// errata E1-E5 and decisions D5 and D8 override it where they differ
// (stake-attestation/docs/BUILD_PLAN.md).
//
// Settlement arrives in P2c. Where a test needs an earlier claim settled, or a prior valid
// finding on the listing, StakeAttestationHarness stands in for P2c through the same internal
// hooks P2c will call (_resolve, _validFindings); no public setter exists for either.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { time, loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { linkedFactory } = require("./helpers/linked");

const { parseEther, ZeroAddress, ZeroHash, sha256, toUtf8Bytes } = ethers;

// ---- enums, in declaration order ----
const ListingState = { Listed: 0n, Open: 1n, Depleted: 2n, Rolled: 3n, Closed: 4n };
const Outcome = { INVALID: 0n, DUPLICATE: 1n, LOW: 2n, MEDIUM: 3n, HIGH: 4n, CRITICAL: 5n };
const ClaimState = {
  Committed: 0n, Revealable: 1n, Revealed: 2n, Judged: 3n, Disputed: 4n, Settled: 5n, Expired: 6n, RoundFailed: 7n,
};
const Expiry = { None: 0n, Undisclosed: 1n, Unrevealed: 2n, RoundsFailed: 3n, SubmissionsRefused: 4n };

const HOUR = 3600n;
const DAY = 24n * HOUR;
const DISCLOSE_WINDOW = HOUR;
// The default listing of design §7.1.
const FIX = 14n * DAY;
const DISPUTE = 72n * HOUR;
const GRACE = 48n * HOUR;
const REVEAL = 7n * DAY;

const LISTING_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const DISPUTE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CT_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const BCID = "bafkreidivzimqfqtoqxkrpge6bjyhlvxqs3rhe73owtmdulaxr5do5in7u";
const REPO = "https://github.com/acme/vault";
const COMMIT = "9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f";
const COMMIT_FIXED = "1f2e3d4c5b6a79880716253443526170abcdef01";
const COMMIT_FIXED_2 = "0a0b0c0d0e0f1011121314151617181920212223";

const ARCHIVE = sha256(toUtf8Bytes("claim archive"));
const CT = sha256(toUtf8Bytes("claim archive, encrypted to the disclosure key"));
const CK = "0x" + "11".repeat(16); // age file key
const EK = "0x" + "22".repeat(32); // X25519 ephemeral secret

const LISTING_FEE = parseEther("0.01");
const AWARDS = [0n, parseEther("0.1"), parseEther("0.4"), parseEther("2")];
const TOP = AWARDS[3];
const BOND = parseEther("0.02");
const ORACLE = {
  requestedClass: 133n,
  maxOracleFee: parseEther("0.00012"),
  disputeMaxOracleFee: parseEther("0.0002"),
  estimatedBaseCost: parseEther("0.000001"),
  alpha: 500n,
  maxFeeBasedScaling: 1n,
};
// The mock quotes maxTotalFee = min(fee, its ceiling) * feeMultiplier (3 by default).
const FEE = ORACLE.maxOracleFee * 3n;

// A distinct, valid CIDv0-shaped string per prior finding.
const priorCid = (i) => `Qm${"P".repeat(42)}${String(i).padStart(2, "0")}`;

function params(overrides = {}) {
  return {
    artifact: { kind: 0n, repo: REPO, baseCommit: COMMIT, chainId: 0n, addr: ZeroAddress },
    disclosureKey: "0x" + "a1".repeat(32),
    awards: [...AWARDS],
    lowestClassCounted: Outcome.MEDIUM,
    bondWei: BOND,
    fixWindow: FIX,
    disputeWindow: DISPUTE,
    disclosureGrace: GRACE,
    revealWindow: REVEAL,
    allowlist: [],
    valueAtRiskUsd: 0n,
    oracle: { ...ORACLE },
    ...overrides,
  };
}

const atCommit = (commit) => ({ kind: 0n, repo: REPO, baseCommit: commit, chainId: 0n, addr: ZeroAddress });

// The views served at the StakeAttestation address by its lens (see StakeAttestation.fallback),
// merged into the contract's own ABI as a client would.
function mergedAbi(name) {
  const main = hre.artifacts.readArtifactSync(name).abi;
  const lens = hre.artifacts.readArtifactSync("StakeAttestationLens").abi;
  const key = (e) => `${e.type}:${e.name}`;
  const seen = new Set(main.map(key));
  return [
    ...main,
    ...lens.filter((e) => ["function", "event", "error"].includes(e.type) && !seen.has(key(e)) && e.name !== "host"),
  ];
}

async function deploy() {
  const [owner, maker, other, feeRecipient, ...hunters] = await ethers.getSigners();
  const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
  const args = [aggregator.target, owner.address, feeRecipient.address, LISTING_FEE];
  const saDeployed = await (await linkedFactory("StakeAttestation")).deploy(...args);
  const harnessDeployed = await (await linkedFactory("StakeAttestationHarness")).deploy(...args);
  const sa = new ethers.Contract(saDeployed.target, mergedAbi("StakeAttestation"), owner);
  const harness = new ethers.Contract(harnessDeployed.target, mergedAbi("StakeAttestationHarness"), owner);
  return { owner, maker, other, feeRecipient, hunters, hunter: hunters[0], aggregator, sa, harness };
}

function eventsOf(contract, receipt, name) {
  const address = contract.target.toLowerCase();
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.name === name);
}

async function blockTime(receipt) {
  return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
}

async function listAs(sa, maker, p = params()) {
  const rc = await (await sa.connect(maker).list(p, LISTING_CID, DISPUTE_CID, [])).wait();
  return eventsOf(sa, rc, "Listed")[0].args.listingId;
}

async function openListing(sa, maker, p = params()) {
  const id = await listAs(sa, maker, p);
  const fee = await sa.feeDue(id);
  await sa.connect(maker).fund(id, fee, { value: fee + TOP });
  return id;
}

async function commitAs(sa, hunter, listingId, { archive = ARCHIVE, ct = CT, value } = {}) {
  const v = value === undefined ? await sa.commitPrice(listingId) : value;
  const rc = await (await sa.connect(hunter).commit(listingId, archive, ct, { value: v })).wait();
  return { claimId: eventsOf(sa, rc, "Committed")[0].args.claimId, at: await blockTime(rc), rc };
}

async function discloseAs(sa, hunter, claimId, cid = CT_CID) {
  return blockTime(await (await sa.connect(hunter).disclose(claimId, cid)).wait());
}

// commit + disclose in two blocks; returns { claimId, committedAt, disclosedAt }
async function claimAs(sa, hunter, listingId, opts = {}) {
  const { claimId, at } = await commitAs(sa, hunter, listingId, opts);
  const disclosedAt = await discloseAs(sa, hunter, claimId, opts.cid);
  return { claimId, committedAt: at, disclosedAt };
}

async function revealTx(sa, hunter, claimId, { bcid = BCID, ck = CK, ek = EK, value, gasLimit } = {}) {
  const v = value === undefined ? await sa.revealTopUp(claimId) : value;
  const overrides = { value: v };
  if (gasLimit !== undefined) overrides.gasLimit = gasLimit;
  return sa.connect(hunter).reveal(claimId, bcid, ck, ek, overrides);
}

async function revealAs(sa, hunter, claimId, opts = {}) {
  const rc = await (await revealTx(sa, hunter, claimId, opts)).wait();
  const ev = eventsOf(sa, rc, "EvaluationRequested")[0];
  return { rc, requestId: ev ? ev.args.requestId : ZeroHash, at: await blockTime(rc) };
}

describe("StakeAttestation: claim lifecycle (P2b)", function () {
  // ------------------------------------------------------------------ commit
  describe("commit() (erratum E5: hashes only)", function () {
    it("stores both hashes, the bond, the prepay and committedAt; exposes no CID; emits Committed", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      expect(await sa.commitPrice(id)).to.equal(BOND + FEE);

      const tx = sa.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE });
      await expect(tx).to.changeEtherBalances([hunter, sa], [-(BOND + FEE), BOND + FEE]);
      const rc = await (await tx).wait();
      const committedAt = await blockTime(rc);
      await expect(tx).to.emit(sa, "Committed").withArgs(1n, id, hunter.address, ARCHIVE, CT, BOND, FEE);

      const c = await sa.getClaim(1n);
      expect(c.hunter).to.equal(hunter.address);
      expect(c.listingId).to.equal(id);
      expect(c.archiveHash).to.equal(ARCHIVE);
      expect(c.ciphertextSha256).to.equal(CT);
      expect(c.committedAt).to.equal(committedAt);
      expect(c.bondWei).to.equal(BOND);
      expect(c.prepayWei).to.equal(FEE);
      expect(c.state).to.equal(ClaimState.Committed);
      expect(c.ciphertextCid).to.equal("");
      expect(c.disclosedAt).to.equal(0n);
      expect(c.bcid).to.equal("");
      expect(await sa.claimCount()).to.equal(1n);
      expect(await sa.claimState(1n)).to.equal(ClaimState.Committed);

      // Nothing readable: commit takes (listingId, archiveHash, ciphertextSha256) and no string.
      const f = sa.interface.getFunction("commit");
      expect(f.inputs.map((i) => i.type)).to.deep.equal(["uint256", "bytes32", "bytes32"]);
      const committed = sa.interface.getEvent("Committed");
      expect(committed.inputs.some((i) => i.type === "string")).to.equal(false);
    });

    it("requires acceptsCommits(): Listed, lapsed, below the top award, Depleted, Rolled or Closed refuse", async function () {
      const { harness, maker, hunter } = await loadFixture(deploy);
      const listed = await listAs(harness, maker);
      await expect(harness.connect(hunter).commit(listed, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("not accepting commits");

      const id = await openListing(harness, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      for (const s of [ListingState.Depleted, ListingState.Rolled]) {
        await harness.harnessSetState(id, s);
        await expect(harness.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE }))
          .to.be.revertedWith("not accepting commits");
      }
      await harness.harnessSetState(id, ListingState.Open);
      await harness.harnessPayFromEscrow(id, maker.address, 1n); // Open, escrow one wei below the top award
      await expect(harness.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("not accepting commits");
      await harness.connect(maker).fund(id, 0n, { value: 1n });
      await expect(harness.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(harness, "Committed");

      const { fundedUntil } = await harness.getListing(id);
      await time.setNextBlockTimestamp(fundedUntil);
      await expect(harness.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("not accepting commits");

      const closed = await openListing(harness, maker, params({ artifact: atCommit(COMMIT_FIXED_2) }));
      await harness.connect(maker).close(closed);
      await expect(harness.connect(hunter).commit(closed, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("not accepting commits");
    });

    it("requires isAllowed(): an invited listing admits only its allowlist", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const [invited, outsider] = hunters;
      const id = await openListing(sa, maker, params({ allowlist: [invited.address] }));
      await expect(sa.connect(outsider).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("not allowed");
      await expect(sa.connect(invited).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(sa, "Committed");
    });

    it("requires bondWei + the live maxTotalFee; an overpayment is kept as prepay", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      await expect(sa.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE - 1n }))
        .to.be.revertedWith("payment below bond + fee");

      await aggregator.setFeeMultiplier(5n); // the live fee rises
      const live = ORACLE.maxOracleFee * 5n;
      expect(await sa.commitPrice(id)).to.equal(BOND + live);
      await expect(sa.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE }))
        .to.be.revertedWith("payment below bond + fee");
      const { claimId } = await commitAs(sa, hunter, id, { value: BOND + live + 7n });
      expect((await sa.getClaim(claimId)).prepayWei).to.equal(live + 7n);

      // The fee follows a lowered ceiling: the quote clamps maxOracleFee as the aggregator does.
      await aggregator.setMaxOracleFee(ORACLE.maxOracleFee / 2n);
      expect(await sa.commitPrice(id)).to.equal(BOND + (ORACLE.maxOracleFee / 2n) * 5n);

      await aggregator.setFeeMultiplier(0n); // a quote of 0 is a broken aggregator, not a free round
      await expect(sa.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND })).to.be.revertedWith("bad budget");
    });

    it("refuses a zero archive hash or ciphertext hash", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      await expect(sa.connect(hunter).commit(id, ZeroHash, CT, { value: BOND + FEE })).to.be.revertedWith("bad archiveHash");
      await expect(sa.connect(hunter).commit(id, ARCHIVE, ZeroHash, { value: BOND + FEE })).to.be.revertedWith("bad ciphertextSha256");
    });

    it("maintains Listing.pendingClaims and the commit-order queue; close() is refused while a claim is pending", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const a = await commitAs(sa, hunters[0], id);
      const b = await commitAs(sa, hunters[1], id);
      let l = await sa.getListing(id);
      expect(l.pendingClaims).to.equal(2n);
      expect(l.claimsCommitted).to.equal(2n);
      expect(l.headClaim).to.equal(a.claimId);
      expect(l.tailClaim).to.equal(b.claimId);
      expect(l.headSince).to.equal(a.at);
      expect((await sa.getClaim(a.claimId)).nextInOrder).to.equal(b.claimId);
      expect((await sa.getClaim(b.claimId)).prevInOrder).to.equal(a.claimId);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");

      await time.increase(DISCLOSE_WINDOW);
      await sa.expire(a.claimId);
      await sa.expire(b.claimId);
      l = await sa.getListing(id);
      expect(l.pendingClaims).to.equal(0n);
      expect(l.headClaim).to.equal(0n);
      expect(l.tailClaim).to.equal(0n);
      expect(l.claimsCommitted).to.equal(2n);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed");
    });

    it("rejects an unknown listing", async function () {
      const { sa, hunter } = await loadFixture(deploy);
      await expect(sa.connect(hunter).commit(9n, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("bad listingId");
    });
  });

  // ------------------------------------------------------------------ disclose
  describe("disclose() (erratum E5)", function () {
    it("stores the ciphertext CID within DISCLOSE_WINDOW; the fix window and grace run from disclosedAt; emits Disclosed", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      expect(await sa.DISCLOSE_WINDOW()).to.equal(DISCLOSE_WINDOW);
      const id = await openListing(sa, maker);
      const { claimId, at } = await commitAs(sa, hunter, id);
      const disclosedAt = at + DISCLOSE_WINDOW - 1n; // the last second of the window
      await time.setNextBlockTimestamp(disclosedAt);
      await expect(sa.connect(hunter).disclose(claimId, CT_CID))
        .to.emit(sa, "Disclosed")
        .withArgs(claimId, id, CT_CID, disclosedAt + FIX);
      const c = await sa.getClaim(claimId);
      expect(c.ciphertextCid).to.equal(CT_CID);
      expect(c.disclosedAt).to.equal(disclosedAt);
      expect(c.fixWindowEnd).to.equal(disclosedAt + FIX);

      const t = await sa.claimTimes(claimId);
      expect(t.discloseDeadline).to.equal(at + DISCLOSE_WINDOW);
      expect(t.revealableAt).to.equal(disclosedAt + FIX);

      // The grace runs from disclosedAt: the maker may still flag at committedAt + grace.
      await time.setNextBlockTimestamp(at + GRACE);
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.emit(sa, "Flagged");
      // So does the fix window: at committedAt + fixWindow the claim is still in it.
      await time.increaseTo(at + FIX);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed);
      await expect(revealTx(sa, hunter, claimId)).to.be.revertedWith("fix window open");
      await time.increaseTo(disclosedAt + FIX);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
    });

    it("only the hunter discloses, once, and only within DISCLOSE_WINDOW of the commit", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, at } = await commitAs(sa, hunter, id);
      await expect(sa.connect(other).disclose(claimId, CT_CID)).to.be.revertedWith("not hunter");
      await expect(sa.connect(maker).disclose(claimId, CT_CID)).to.be.revertedWith("not hunter");

      const late = await commitAs(sa, hunter, id);
      await time.setNextBlockTimestamp(late.at + DISCLOSE_WINDOW);
      await expect(sa.connect(hunter).disclose(late.claimId, CT_CID)).to.be.revertedWith("disclose window over");

      // The late claim's refused disclose was mined past the first claim's window too.
      expect(late.at + DISCLOSE_WINDOW).to.be.greaterThan(at + DISCLOSE_WINDOW);
      await expect(sa.connect(hunter).disclose(claimId, CT_CID)).to.be.revertedWith("disclose window over");
      await expect(sa.connect(hunter).disclose(99n, CT_CID)).to.be.revertedWith("bad claimId");
      const fresh = await commitAs(sa, hunter, id);
      await sa.connect(hunter).disclose(fresh.claimId, CT_CID);
      await expect(sa.connect(hunter).disclose(fresh.claimId, CT_CID)).to.be.revertedWith("already disclosed");
    });

    it("validates the CID as BountyEscrow's _isValidCid does", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await commitAs(sa, hunter, id);
      for (const bad of [
        "", "Qm" + "a".repeat(43), "b".repeat(101), CT_CID.slice(0, 50) + ",QmX", CT_CID.slice(0, 50) + ":addendum",
        CT_CID.slice(0, 58) + " ", CT_CID.slice(0, 58) + "/", CT_CID.slice(0, 58) + "é",
      ]) {
        await expect(sa.connect(hunter).disclose(claimId, bad), JSON.stringify(bad)).to.be.revertedWith("bad ciphertextCid");
      }
      await expect(sa.connect(hunter).disclose(claimId, "Q".repeat(46))).to.emit(sa, "Disclosed");
    });

    it("an undisclosed claim may be expired by anyone after DISCLOSE_WINDOW: bond to the maker, prepay back, counted undisclosed", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, at } = await commitAs(sa, hunter, id);
      await time.setNextBlockTimestamp(at + DISCLOSE_WINDOW - 1n);
      await expect(sa.connect(other).expire(claimId)).to.be.revertedWith("disclose window open");

      await time.setNextBlockTimestamp(at + DISCLOSE_WINDOW);
      const tx = sa.connect(other).expire(claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, other, sa], [BOND, FEE, 0n, -(BOND + FEE)]);
      await expect(tx).to.emit(sa, "Expired").withArgs(claimId, id, Expiry.Undisclosed);
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Expired);
      expect(c.expiry).to.equal(Expiry.Undisclosed);
      const l = await sa.getListing(id);
      expect(l.undisclosedClaims).to.equal(1n);
      expect(l.unrevealedClaims).to.equal(0n);
      expect(l.pendingClaims).to.equal(0n);
      await expect(sa.connect(hunter).disclose(claimId, CT_CID)).to.be.revertedWith("not committed");
      await expect(sa.expire(claimId)).to.be.revertedWith("not committed");
    });

    it("an undisclosed claim expires while an earlier claim is unresolved (D5's ordering applies to the reveal window only)", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const first = await claimAs(sa, hunters[0], id); // disclosed, in its fix window: unresolved
      const second = await commitAs(sa, hunters[1], id); // never disclosed
      const third = await commitAs(sa, hunters[2], id);
      await time.increase(DISCLOSE_WINDOW);
      await expect(sa.expire(second.claimId)).to.emit(sa, "Expired").withArgs(second.claimId, id, Expiry.Undisclosed);
      // Unlinked in O(1): the queue now runs first -> third.
      expect((await sa.getClaim(first.claimId)).nextInOrder).to.equal(third.claimId);
      expect((await sa.getClaim(third.claimId)).prevInOrder).to.equal(first.claimId);
      expect((await sa.getListing(id)).headClaim).to.equal(first.claimId);
      await sa.expire(third.claimId);
      const l = await sa.getListing(id);
      expect(l.tailClaim).to.equal(first.claimId);
      expect(l.undisclosedClaims).to.equal(2n);
    });

    it("E5: a close or rollForward that lands before a commit leaves nothing fetchable", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const closing = await openListing(sa, maker);
      const rolling = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      const successor = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED_2) }));
      const fees = (tip) => ({ gasLimit: 500_000, maxFeePerGas: 10n ** 11n, maxPriorityFeePerGas: tip });
      const races = [
        { listingId: closing, front: () => sa.connect(maker).close(closing, fees(5n * 10n ** 10n)) },
        { listingId: rolling, front: () => sa.connect(maker).rollForward(rolling, successor, fees(5n * 10n ** 10n)) },
      ];
      for (const [i, race] of races.entries()) {
        const hunter = hunters[i];
        const balance = await ethers.provider.getBalance(hunter.address);
        await network.provider.send("evm_setAutomine", [false]);
        let commitTx, frontTx;
        try {
          // The hunter's commit is in the mempool first; the maker's transaction outbids it.
          commitTx = await sa.connect(hunter).commit(race.listingId, ARCHIVE, CT, { value: BOND + FEE, ...fees(1n) });
          frontTx = await race.front();
          await mine();
        } finally {
          await network.provider.send("evm_setAutomine", [true]);
        }
        const front = await ethers.provider.getTransactionReceipt(frontTx.hash);
        const commit = await ethers.provider.getTransactionReceipt(commitTx.hash);
        expect(front.status).to.equal(1);
        expect(commit.status).to.equal(0);
        expect(front.blockNumber).to.equal(commit.blockNumber);
        // What the pending commit put in public view: two hashes, no CID.
        const decoded = sa.interface.decodeFunctionData("commit", commitTx.data);
        expect(decoded.map((x) => typeof x)).to.deep.equal(["bigint", "string", "string"]);
        expect([decoded[1], decoded[2]]).to.deep.equal([ARCHIVE, CT]);
        expect(commitTx.data.toLowerCase()).to.not.include(Buffer.from(CT_CID).toString("hex"));
        // Nothing was committed, nothing disclosed, and the hunter paid only gas.
        expect(eventsOf(sa, commit, "Committed")).to.have.length(0);
        expect(eventsOf(sa, commit, "Disclosed")).to.have.length(0);
        const gas = commit.gasUsed * commit.gasPrice;
        expect(await ethers.provider.getBalance(hunter.address)).to.equal(balance - gas);
      }
      expect(await sa.claimCount()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ flag
  describe("flagBadDisclosure()", function () {
    it("maker-only, within disclosureGrace of disclosedAt, once; emits Flagged", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const undisclosed = await commitAs(sa, hunter, id);
      await expect(sa.connect(maker).flagBadDisclosure(undisclosed.claimId)).to.be.revertedWith("not disclosed");

      const { claimId } = await claimAs(sa, hunter, id);
      await expect(sa.connect(other).flagBadDisclosure(claimId)).to.be.revertedWith("not maker");
      await expect(sa.connect(hunter).flagBadDisclosure(claimId)).to.be.revertedWith("not maker");
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.emit(sa, "Flagged").withArgs(claimId, id);
      expect((await sa.getClaim(claimId)).flaggedBadDisclosure).to.equal(true);
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.be.revertedWith("already flagged");

      // The last second of the grace, and its end.
      const last = await claimAs(sa, hunter, id);
      const over = await claimAs(sa, hunter, id);
      await time.setNextBlockTimestamp(last.disclosedAt + GRACE - 1n);
      await expect(sa.connect(maker).flagBadDisclosure(last.claimId)).to.emit(sa, "Flagged");
      await time.setNextBlockTimestamp(over.disclosedAt + GRACE);
      await expect(sa.connect(maker).flagBadDisclosure(over.claimId)).to.be.revertedWith("grace over");
    });

    it("a flag is a statement on the record, not a verdict: the claim still reveals", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await sa.connect(maker).flagBadDisclosure(claimId);
      await time.increaseTo(disclosedAt + FIX);
      await expect(revealTx(sa, hunter, claimId)).to.emit(sa, "Revealed");
      expect((await sa.getClaim(claimId)).flaggedBadDisclosure).to.equal(true);
    });
  });

  // ------------------------------------------------------------------ release
  describe("release()", function () {
    it("release-then-immediate-reveal: the claim is revealable at once, the reveal is accepted, the record shows the release", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await time.setNextBlockTimestamp(disclosedAt + DAY); // well inside the 14-day window
      const tx = sa.connect(maker).release(claimId);
      await expect(tx).to.emit(sa, "Released").withArgs(claimId, id);
      const releasedAt = await blockTime(await (await tx).wait());
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
      const c = await sa.getClaim(claimId);
      expect(c.released).to.equal(true);
      expect(c.fixWindowEnd).to.equal(releasedAt);
      expect((await sa.claimTimes(claimId)).revealableAt).to.equal(releasedAt);

      await expect(revealTx(sa, hunter, claimId)).to.emit(sa, "Revealed");
      const after = await sa.getClaim(claimId);
      expect(after.state).to.equal(ClaimState.Revealed);
      expect(after.released).to.equal(true);
    });

    it("maker-only, disclosed claims only, inside the fix window only, once", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const undisclosed = await commitAs(sa, hunter, id);
      await expect(sa.connect(maker).release(undisclosed.claimId)).to.be.revertedWith("not disclosed");

      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await expect(sa.connect(other).release(claimId)).to.be.revertedWith("not maker");
      await expect(sa.connect(hunter).release(claimId)).to.be.revertedWith("not maker");
      await sa.connect(maker).release(claimId);
      await expect(sa.connect(maker).release(claimId)).to.be.revertedWith("not in fix window");

      // Once the window has elapsed there is nothing to release: the record must not say "released".
      const late = await claimAs(sa, hunter, id);
      await time.setNextBlockTimestamp(late.disclosedAt + FIX);
      await expect(sa.connect(maker).release(late.claimId)).to.be.revertedWith("not in fix window");
      expect(disclosedAt).to.be.greaterThan(0n);
    });
  });

  // ------------------------------------------------------------------ rollForward
  describe("rollForward()", function () {
    it("roll-forward-makes-pending-revealable: every disclosed Committed claim Revealable, no new commits, lineage both ways", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      const undisclosed = await commitAs(sa, hunters[2], id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      const successorHash = (await sa.getListing(successor)).artifactHash;

      const tx = sa.connect(maker).rollForward(id, successor);
      await expect(tx).to.emit(sa, "RolledForward").withArgs(id, successor, successorHash);
      const rolledAt = await blockTime(await (await tx).wait());

      for (const { claimId } of [a, b]) {
        expect(await sa.claimState(claimId), `claim ${claimId}`).to.equal(ClaimState.Revealable);
        expect((await sa.claimTimes(claimId)).revealableAt).to.equal(rolledAt);
      }
      // The undisclosed claim keeps its disclose deadline (E5: roll-forward applies to disclosed claims).
      expect(await sa.claimState(undisclosed.claimId)).to.equal(ClaimState.Committed);
      expect((await sa.claimTimes(undisclosed.claimId)).discloseDeadline).to.equal(undisclosed.at + DISCLOSE_WINDOW);

      const pred = await sa.getListing(id);
      const succ = await sa.getListing(successor);
      expect(pred.state).to.equal(ListingState.Rolled);
      expect(pred.successor).to.equal(successor);
      expect(pred.rolledAt).to.equal(rolledAt);
      expect(succ.predecessor).to.equal(id);
      expect(succ.state).to.equal(ListingState.Open);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(hunters[3]).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("not accepting commits");
      expect(await sa.acceptsCommits(successor)).to.equal(true); // the badge moved

      // The first claim reveals at once; the second waits its turn in commit order.
      await expect(revealTx(sa, hunters[0], a.claimId)).to.emit(sa, "Revealed");
      await expect(revealTx(sa, hunters[1], b.claimId)).to.be.revertedWith("earlier claim unresolved");
    });

    it("a claim disclosed after the roll-forward gets its own fix window from disclosedAt", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await commitAs(sa, hunter, id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      await sa.connect(maker).rollForward(id, successor);
      const disclosedAt = await discloseAs(sa, hunter, claimId);
      const c = await sa.getClaim(claimId);
      expect(c.disclosedAfterRoll).to.equal(true);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed);
      expect((await sa.claimTimes(claimId)).revealableAt).to.equal(disclosedAt + FIX);
      await sa.connect(maker).release(claimId); // the maker may still waive it
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
    });

    it("maker-only, to a listed and funded successor of the same maker, from an Open or Depleted listing, once", async function () {
      const { harness, maker, owner, other } = await loadFixture(deploy);
      const id = await openListing(harness, maker);
      const listedOnly = await listAs(harness, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      const othersListing = await openListing(harness, other, params({ artifact: atCommit(COMMIT_FIXED) }));
      const successor = await openListing(harness, maker, params({ artifact: atCommit(COMMIT_FIXED_2) }));

      await expect(harness.connect(other).rollForward(id, successor)).to.be.revertedWith("not maker");
      await expect(harness.connect(owner).rollForward(id, successor)).to.be.revertedWith("not maker");
      await expect(harness.connect(maker).rollForward(id, id)).to.be.revertedWith("bad successor");
      await expect(harness.connect(maker).rollForward(id, listedOnly)).to.be.revertedWith("bad successor"); // not funded
      await expect(harness.connect(maker).rollForward(id, othersListing)).to.be.revertedWith("bad successor"); // not the maker's
      await expect(harness.connect(maker).rollForward(id, 99n)).to.be.revertedWith("bad listingId");
      await expect(harness.connect(maker).rollForward(listedOnly, successor)).to.be.revertedWith("not rollable");

      await harness.harnessSetState(id, ListingState.Depleted);
      await expect(harness.connect(maker).rollForward(id, successor)).to.emit(harness, "RolledForward");
      await expect(harness.connect(maker).rollForward(id, successor)).to.be.revertedWith("not rollable");

      // A successor already has a predecessor; a Rolled listing cannot be a successor.
      const another = await openListing(harness, maker, params({ artifact: atCommit("ab".repeat(20)) }));
      await expect(harness.connect(maker).rollForward(another, successor)).to.be.revertedWith("bad successor");
      await expect(harness.connect(maker).rollForward(another, id)).to.be.revertedWith("bad successor");

      // The chain continues: the successor may roll forward in turn.
      await expect(harness.connect(maker).rollForward(successor, another)).to.emit(harness, "RolledForward");
      expect((await harness.getListing(another)).predecessor).to.equal(successor);

      const closed = await openListing(harness, maker, params({ artifact: atCommit("cd".repeat(20)) }));
      const fresh = await openListing(harness, maker, params({ artifact: atCommit("ef".repeat(20)) }));
      await harness.connect(maker).close(closed);
      await expect(harness.connect(maker).rollForward(closed, fresh)).to.be.revertedWith("not rollable");
      await expect(harness.connect(maker).rollForward(fresh, closed)).to.be.revertedWith("bad successor");
    });

    it("a rolled listing still settles its claims, and closes once nothing is pending", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId } = await claimAs(sa, hunter, id);
      const successor = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      const rc = await (await sa.connect(maker).rollForward(id, successor)).wait();
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await time.setNextBlockTimestamp((await blockTime(rc)) + REVEAL);
      await expect(sa.expire(claimId)).to.emit(sa, "Expired").withArgs(claimId, id, Expiry.Unrevealed);
      await expect(sa.connect(maker).close(id)).to.emit(sa, "Closed");
    });
  });

  // ------------------------------------------------------------------ fix window
  describe("the fix window", function () {
    it("reveal-before-fix-window-ends: a reveal before fixWindow with neither release nor roll-forward is rejected", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await expect(revealTx(sa, hunter, claimId)).to.be.revertedWith("fix window open");
      await time.setNextBlockTimestamp(disclosedAt + FIX - 1n);
      await expect(revealTx(sa, hunter, claimId)).to.be.revertedWith("fix window open");
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Committed);
      expect(c.bcid).to.equal("");
    });

    it("a claim becomes Revealable when the fix window elapses: one second before and at the boundary", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await time.increaseTo(disclosedAt + FIX - 1n);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed);
      await time.increaseTo(disclosedAt + FIX);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);

      const second = await claimAs(sa, hunter, await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED) })));
      await time.setNextBlockTimestamp(second.disclosedAt + FIX - 1n);
      await expect(revealTx(sa, hunter, second.claimId)).to.be.revertedWith("fix window open");
      await time.setNextBlockTimestamp(second.disclosedAt + FIX);
      await expect(revealTx(sa, hunter, second.claimId)).to.emit(sa, "Revealed");
    });

    it("fixWindowDays = 0: a claim is revealable as soon as it is disclosed", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await commitAs(sa, hunter, id);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Committed); // undisclosed: nothing to reveal yet
      await expect(revealTx(sa, hunter, claimId)).to.be.revertedWith("not disclosed");
      const disclosedAt = await discloseAs(sa, hunter, claimId);
      expect((await sa.getClaim(claimId)).fixWindowEnd).to.equal(disclosedAt);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.be.revertedWith("grace over"); // grace 0
      await expect(sa.connect(maker).release(claimId)).to.be.revertedWith("not in fix window");
      await expect(revealTx(sa, hunter, claimId)).to.emit(sa, "Revealed");
    });
  });

  // ------------------------------------------------------------------ reveal
  describe("reveal()", function () {
    it("stores the reveal, keys as bytes16 / bytes32, and submits through a fresh EIP-1167 EvaluationWallet", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      const f = sa.interface.getFunction("reveal");
      expect(f.inputs.map((i) => i.type)).to.deep.equal(["uint256", "string", "bytes16", "bytes32"]);
      expect(f.payable).to.equal(true);

      const tx = revealTx(sa, hunter, claimId);
      await expect(tx).to.emit(sa, "Revealed").withArgs(claimId, id, BCID, CK, EK);
      const rc = await (await tx).wait();
      const revealedAt = await blockTime(rc);
      const ev = eventsOf(sa, rc, "EvaluationRequested")[0].args;
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Revealed);
      expect(c.bcid).to.equal(BCID);
      expect(c.contentKey).to.equal(CK);
      expect(c.ephemeralKey).to.equal(EK);
      expect(c.revealedAt).to.equal(revealedAt);
      expect(c.requestId).to.equal(ev.requestId);
      expect(c.evalWallet).to.equal(ev.wallet);
      expect(ev.prepayWei).to.equal(FEE);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealed);

      // The wallet is a minimal proxy of the implementation and is the requester the aggregator saw.
      const impl = (await sa.walletImplementation()).toLowerCase().slice(2);
      const code = await ethers.provider.getCode(c.evalWallet);
      expect(code).to.equal(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`);
      const status = await aggregator.getAggregationStatus(c.requestId);
      expect(status.requester).to.equal(c.evalWallet);
      expect(await aggregator.ethReceived(c.requestId)).to.equal(FEE);
      const wallet = await ethers.getContractAt("EvaluationWallet", c.evalWallet);
      expect(await wallet.requester()).to.equal(sa.target);
      expect(await wallet.aggId()).to.equal(c.requestId);

      // The next claim gets its own wallet.
      const next = await openListing(sa, maker, params({ artifact: atCommit(COMMIT_FIXED), fixWindow: 0n, disclosureGrace: 0n }));
      const other = await claimAs(sa, hunter, next);
      await revealAs(sa, hunter, other.claimId);
      expect((await sa.getClaim(other.claimId)).evalWallet).to.not.equal(c.evalWallet);
    });

    it("only the hunter reveals, once, with a valid bCID", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await expect(revealTx(sa, other, claimId)).to.be.revertedWith("not hunter");
      await expect(revealTx(sa, maker, claimId)).to.be.revertedWith("not hunter");
      for (const bad of ["", BCID.slice(0, 40), BCID.slice(0, 50) + ",QmAbc", BCID.slice(0, 50) + ":text"]) {
        await expect(revealTx(sa, hunter, claimId, { bcid: bad }), bad).to.be.revertedWith("bad bcid");
      }
      await revealAs(sa, hunter, claimId);
      await expect(revealTx(sa, hunter, claimId, { value: 0n })).to.be.revertedWith("not committed");
      await expect(revealTx(sa, hunter, 99n, { value: 0n })).to.be.revertedWith("bad claimId");
    });

    it("E3: reveal tops up to the live maxTotalFee when it rose after the commit", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setFeeMultiplier(4n);
      const live = ORACLE.maxOracleFee * 4n;
      expect(await sa.revealTopUp(claimId)).to.equal(live - FEE);
      await expect(revealTx(sa, hunter, claimId, { value: live - FEE - 1n })).to.be.revertedWith("prepay below fee");
      const tx = revealTx(sa, hunter, claimId, { value: live - FEE });
      await expect(tx).to.changeEtherBalances([hunter, sa], [-(live - FEE), -FEE]);
      const c = await sa.getClaim(claimId);
      expect(c.prepayWei).to.equal(live);
      expect(await aggregator.ethReceived(c.requestId)).to.equal(live);
      await expect(tx).to.emit(sa, "EvaluationRequested").withArgs(claimId, c.evalWallet, c.requestId, live);
    });

    it("E3: when the fee fell, the whole prepay funds the round and the excess returns through the wallet's ethOwed", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setFeeMultiplier(2n);
      expect(await sa.revealTopUp(claimId)).to.equal(0n);
      const { requestId } = await revealAs(sa, hunter, claimId, { value: 0n });
      expect(await aggregator.ethReceived(requestId)).to.equal(FEE);
      const wallet = (await sa.getClaim(claimId)).evalWallet;
      // The oracles spend at most the live figure; the mock credits the rest to the requester.
      await aggregator.scriptResult(requestId, [0, 0, 0, 1_000_000, 0, 0], "QmJustification");
      expect(await aggregator.ethOwed(wallet)).to.equal(FEE - ORACLE.maxOracleFee * 2n);
    });

    it("refuses a reveal when the aggregator quotes no budget (fee multiplier or ceiling at 0)", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setFeeMultiplier(0n);
      await expect(revealTx(sa, hunter, claimId, { value: 0n })).to.be.revertedWith("bad budget");
      await aggregator.setFeeMultiplier(3n);
      await aggregator.setMaxOracleFee(0n); // the clamp takes the fee, and the base cost, to 0
      await expect(revealTx(sa, hunter, claimId, { value: 0n })).to.be.revertedWith("bad budget");
      await aggregator.setMaxOracleFee(parseEther("0.0004"));
      await expect(revealTx(sa, hunter, claimId, { value: 0n })).to.emit(sa, "EvaluationRequested");
    });

    it("a reveal with a stale, larger prepay still sends it all: excess is the aggregator's to refund", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id, { value: BOND + FEE + 1000n });
      const { requestId } = await revealAs(sa, hunter, claimId, { value: 5n });
      expect(await aggregator.ethReceived(requestId)).to.equal(FEE + 1005n);
      expect((await sa.getClaim(claimId)).prepayWei).to.equal(FEE + 1005n);
    });

    it("composes cids = [listingCid, bcid] and forwards the listing's oracle settings", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      const { requestId } = await revealAs(sa, hunter, claimId);
      expect([...(await aggregator.getRequestCids(requestId))]).to.deep.equal([LISTING_CID, BCID]);
      const p = await aggregator.requestParams(requestId);
      expect(p.alpha).to.equal(ORACLE.alpha);
      expect(p.maxFee).to.equal(ORACLE.maxOracleFee);
      expect(p.estimatedBaseCost).to.equal(ORACLE.estimatedBaseCost);
      expect(p.maxFeeBasedScaling).to.equal(ORACLE.maxFeeBasedScaling);
      expect(p.requestedClass).to.equal(ORACLE.requestedClass);
    });

    it("clamps the fee to a lowered aggregator ceiling, and the base cost below it, as BountyEscrow does", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      const ceiling = ORACLE.estimatedBaseCost; // at the base cost: the keeper would refuse base >= fee
      await aggregator.setMaxOracleFee(ceiling);
      const { requestId } = await revealAs(sa, hunter, claimId, { value: 0n });
      const p = await aggregator.requestParams(requestId);
      expect(p.maxFee).to.equal(ceiling);
      expect(p.estimatedBaseCost).to.equal(ceiling - 1n);
    });

    it("E1: the addendum is the disclosure line, byte for byte the hard-coded vector", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const vector = {
        archive: "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        ct: "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        cid: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
        ck: "0x0123456789abcdef0123456789abcdef",
        ek: "0xa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f",
      };
      const EXPECTED =
        "verdikta-disclosure: " +
        "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff " +
        "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210 " +
        "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku " +
        "0x0123456789abcdef0123456789abcdef " +
        "0xa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f";
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id, { archive: vector.archive, ct: vector.ct, cid: vector.cid });
      const { requestId } = await revealAs(sa, hunter, claimId, { ck: vector.ck, ek: vector.ek });
      const addendum = (await aggregator.requestParams(requestId)).addendum;
      expect(addendum).to.equal(EXPECTED);
      expect(Buffer.from(addendum, "utf8").length).to.equal(316);
      expect(addendum).to.match(/^[\x21-\x7e]+( [\x21-\x7e]+){5}$/); // ASCII, single spaces, one line
    });

    it("E1: the line keeps leading zero bytes and spells uppercase CID letters as given; it fits the 1,000-byte addendum", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const cid = "Qm" + "Z".repeat(98); // the longest CID disclose accepts
      const zero16 = "0x" + "00".repeat(15) + "01";
      const ek = "0x" + "00".repeat(31) + "ff";
      const { claimId } = await claimAs(sa, hunter, id, { archive: "0x" + "00".repeat(31) + "0a", ct: "0x" + "ff".repeat(32), cid });
      const { requestId } = await revealAs(sa, hunter, claimId, { ck: zero16, ek });
      const addendum = (await aggregator.requestParams(requestId)).addendum;
      expect(addendum).to.equal(
        `verdikta-disclosure: 0x${"00".repeat(31)}0a 0x${"ff".repeat(32)} ${cid} 0x${"00".repeat(15)}01 0x${"00".repeat(31)}ff`
      );
      expect(addendum.length).to.equal(357);
      expect(addendum.length).to.be.at.most(Number(await aggregator.MAX_ADDENDUM_LENGTH()));
    });

    it("E2: cids carry up to 8 prior valid findings, the most recent, oldest first", async function () {
      const { harness, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(harness, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      expect(await harness.MAX_PRIOR_FINDINGS()).to.equal(8n);
      const priors = [];
      for (let i = 1; i <= 10; i++) {
        const { claimId } = await claimAs(harness, hunter, id);
        await revealAs(harness, hunter, claimId, { bcid: priorCid(i) });
        await harness.harnessResolve(claimId); // P2c: settled
        await harness.harnessAddValidFinding(id, claimId); // P2c: valid
        priors.push(priorCid(i));
        if (i === 3) {
          const probe = await claimAs(harness, hunter, id);
          const { requestId } = await revealAs(harness, hunter, probe.claimId);
          expect([...(await aggregator.getRequestCids(requestId))]).to.deep.equal([LISTING_CID, BCID, ...priors]);
          await harness.harnessResolve(probe.claimId); // settled, not valid
        }
      }
      const { claimId } = await claimAs(harness, hunter, id);
      const { requestId } = await revealAs(harness, hunter, claimId);
      const cids = [...(await aggregator.getRequestCids(requestId))];
      expect(cids).to.deep.equal([LISTING_CID, BCID, ...priors.slice(2)]);
      expect(cids.length).to.equal(Number(await aggregator.MAX_CID_COUNT()));
    });

    it("a failed submission enters the failed-round state; the reveal and the prepay are kept", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setPaused(true); // the aggregator refuses every request
      const tx = revealTx(sa, hunter, claimId);
      await expect(tx).to.changeEtherBalance(sa, 0n);
      await expect(tx).to.emit(sa, "Revealed").withArgs(claimId, id, BCID, CK, EK);
      const rc = await (await tx).wait();
      const failed = eventsOf(sa, rc, "SubmissionFailed");
      expect(failed).to.have.length(1);
      expect(eventsOf(sa, rc, "EvaluationRequested")).to.have.length(0);
      const pausedError = aggregator.interface.encodeErrorResult("EnforcedPause", []);
      expect(failed[0].args.reason).to.equal(pausedError);
      const c = await sa.getClaim(claimId);
      expect(failed[0].args.wallet).to.equal(c.evalWallet);
      expect(c.state).to.equal(ClaimState.RoundFailed);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.RoundFailed);
      expect(c.requestId).to.equal(ZeroHash);
      expect(c.bcid).to.equal(BCID);
      expect(c.prepayWei).to.equal(FEE);
      // escrow + the fee recipient's pull balance + bond + prepay
      expect(await ethers.provider.getBalance(sa.target)).to.equal(TOP + LISTING_FEE + BOND + FEE);
      // Still unresolved: it holds its place in commit order, and it is not expirable while the
      // hunter may re-trigger it (P2d: revealWindow from the failure).
      expect((await sa.getListing(id)).headClaim).to.equal(claimId);
      expect((await sa.getListing(id)).pendingClaims).to.equal(1n);
      await expect(sa.expire(claimId)).to.be.revertedWith("retrigger window open");
    });

    it("the request gets exactly SUBMISSION_GAS: whatever gas a reveal brings, a costly aggregator never leaves it RoundFailed", async function () {
      // Regression (review R1-F1): with the budget forwarded as "all but 1/64", an aggregator
      // running out of gas several frames down returned enough reserve gas to pass a floor
      // check, so an underfunded reveal could enter RoundFailed.
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const SUBMISSION_GAS = 10_000_000n;
      expect(await sa.SUBMISSION_GAS()).to.equal(SUBMISSION_GAS);
      expect(await sa.SUBMISSION_GAS_NEEDED()).to.equal(SUBMISSION_GAS + SUBMISSION_GAS / 63n + 100_000n);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setRequestGasCost(3_000_000n); // a keeper loop over many oracles
      const estimate = await sa.connect(hunter).reveal.estimateGas(claimId, BCID, CK, EK, { value: 0n });
      expect(estimate).to.be.greaterThan(SUBMISSION_GAS);
      let reverted = 0;
      for (const limit of [3_300_000n, 4_500_000n, 7_000_000n, SUBMISSION_GAS, estimate - 100_000n, estimate - 10_000n]) {
        const snap = await network.provider.send("evm_snapshot");
        try {
          await (await revealTx(sa, hunter, claimId, { value: 0n, gasLimit: limit })).wait();
          expect((await sa.getClaim(claimId)).state, `limit ${limit}`).to.equal(ClaimState.Revealed);
        } catch (e) {
          reverted++;
          expect((await sa.getClaim(claimId)).state, `limit ${limit}`).to.equal(ClaimState.Committed);
        } finally {
          await network.provider.send("evm_revert", [snap]);
        }
      }
      expect(reverted).to.be.greaterThan(0);
      await expect(revealTx(sa, hunter, claimId, { value: 0n, gasLimit: 3_300_000n }))
        .to.be.revertedWith("gas below SUBMISSION_GAS_NEEDED");
      // Gas estimation lands on the submitted path, and a funded retry succeeds.
      await revealAs(sa, hunter, claimId, { value: 0n, gasLimit: estimate });
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Revealed);
    });

    it("a request that needs more than SUBMISSION_GAS fails the same way for every caller", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const { claimId } = await claimAs(sa, hunter, id);
      await aggregator.setRequestGasCost(11_000_000n); // more than the budget: out of gas inside
      for (const limit of [12_000_000n, 25_000_000n]) {
        const snap = await network.provider.send("evm_snapshot");
        try {
          const rc = await (await revealTx(sa, hunter, claimId, { value: 0n, gasLimit: limit })).wait();
          const failed = eventsOf(sa, rc, "SubmissionFailed");
          expect(failed, `limit ${limit}`).to.have.length(1);
          expect(failed[0].args.reason).to.equal("0x"); // out of gas: no revert data
          expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.RoundFailed);
        } finally {
          await network.provider.send("evm_revert", [snap]);
        }
      }
    });

    it("reveal closes revealWindow after the reveal clock starts", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const a = await claimAs(sa, hunters[0], id);
      const b = await claimAs(sa, hunters[1], id);
      await time.setNextBlockTimestamp(b.disclosedAt + FIX + REVEAL);
      await sa.expire(a.claimId); // a's clock started at its revealableAt, earlier than b's
      // b's clock: max(revealableAt, when a resolved) = when a resolved.
      const resolvedAt = b.disclosedAt + FIX + REVEAL;
      expect((await sa.claimTimes(b.claimId)).revealDeadline).to.equal(resolvedAt + REVEAL);
      await time.setNextBlockTimestamp(resolvedAt + REVEAL);
      await expect(revealTx(sa, hunters[1], b.claimId)).to.be.revertedWith("reveal window over");
    });
  });

  // ------------------------------------------------------------------ commit order (D5)
  describe("commit order and the reveal clock (decision D5)", function () {
    it("a reveal waits for every earlier claim to be settled or expired", async function () {
      const { harness, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(harness, maker, params({ fixWindow: 0n, disclosureGrace: 0n }));
      const a = await claimAs(harness, hunters[0], id);
      const b = await claimAs(harness, hunters[1], id);
      expect(await harness.claimState(b.claimId)).to.equal(ClaimState.Revealable);
      await expect(revealTx(harness, hunters[1], b.claimId)).to.be.revertedWith("earlier claim unresolved");
      await revealAs(harness, hunters[0], a.claimId); // Revealed is not resolved
      await expect(revealTx(harness, hunters[1], b.claimId)).to.be.revertedWith("earlier claim unresolved");
      expect((await harness.claimTimes(b.claimId)).revealDeadline).to.equal(0n); // its clock has not started
      await harness.harnessResolve(a.claimId); // P2c: settled
      await expect(revealTx(harness, hunters[1], b.claimId)).to.emit(harness, "Revealed");
    });

    it("the cursor is O(1): a reveal costs the same behind 1 or 24 resolved earlier claims", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      // The first reveal also writes the mock's request counter from zero; measure after it.
      const gasBehind = async (n, commit) => {
        const id = await openListing(sa, maker, params({ artifact: atCommit(commit), fixWindow: 0n, disclosureGrace: 0n }));
        for (let i = 0; i < n; i++) await commitAs(sa, hunters[i % 4], id); // never disclosed
        const last = await claimAs(sa, hunters[5], id);
        await time.increase(DISCLOSE_WINDOW);
        for (let i = 1; i <= n; i++) await sa.expire(last.claimId - BigInt(i));
        const { rc } = await revealAs(sa, hunters[5], last.claimId);
        return rc.gasUsed;
      };
      await gasBehind(1, COMMIT);
      const one = await gasBehind(1, COMMIT_FIXED);
      const many = await gasBehind(24, COMMIT_FIXED_2);
      expect(many > one ? many - one : one - many).to.be.lessThan(2_000n);
    });

    it("the reveal clock starts at max(revealableAt, the time every earlier claim resolved)", async function () {
      const { harness, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(harness, maker);
      const a = await claimAs(harness, hunters[0], id);
      await time.increase(DAY);
      const b = await claimAs(harness, hunters[1], id);
      // a resolves before b is revealable: b's clock starts at its revealableAt.
      await time.increaseTo(a.disclosedAt + FIX);
      await revealAs(harness, hunters[0], a.claimId);
      await harness.harnessResolve(a.claimId);
      let t = await harness.claimTimes(b.claimId);
      expect(t.revealableAt).to.equal(b.disclosedAt + FIX);
      expect(t.revealDeadline).to.equal(b.disclosedAt + FIX + REVEAL);

      // c is revealable long before b resolves: c's clock starts when b resolves.
      await time.increase(HOUR);
      const c = await claimAs(harness, hunters[2], id);
      await time.increaseTo(b.disclosedAt + FIX);
      await revealAs(harness, hunters[1], b.claimId);
      await time.increaseTo(c.disclosedAt + FIX + REVEAL + DAY); // c's own window would be over
      const rc = await (await harness.harnessResolve(b.claimId)).wait();
      const resolvedAt = await blockTime(rc);
      t = await harness.claimTimes(c.claimId);
      expect(t.revealDeadline).to.equal(resolvedAt + REVEAL);
      await time.setNextBlockTimestamp(resolvedAt + REVEAL - 1n);
      await expect(revealTx(harness, hunters[2], c.claimId)).to.emit(harness, "Revealed");
    });

    it("expire() reverts while an earlier claim is unresolved", async function () {
      const { harness, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(harness, maker);
      const a = await claimAs(harness, hunters[0], id);
      const b = await claimAs(harness, hunters[1], id);
      await time.increaseTo(a.disclosedAt + FIX);
      await revealAs(harness, hunters[0], a.claimId); // a is being judged
      await time.increaseTo(b.disclosedAt + FIX + REVEAL + 30n * DAY);
      await expect(harness.expire(b.claimId)).to.be.revertedWith("earlier claim unresolved");
      const rc = await (await harness.harnessResolve(a.claimId)).wait();
      const resolvedAt = await blockTime(rc);
      await time.setNextBlockTimestamp(resolvedAt + REVEAL - 1n);
      await expect(harness.expire(b.claimId)).to.be.revertedWith("reveal window open");
      await time.setNextBlockTimestamp(resolvedAt + REVEAL);
      await expect(harness.expire(b.claimId)).to.emit(harness, "Expired").withArgs(b.claimId, id, Expiry.Unrevealed);
    });

    it("four claims released by one roll-forward all reach judgement with default windows", async function () {
      const { harness, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(harness, maker);
      const claims = [];
      for (let i = 0; i < 4; i++) claims.push(await claimAs(harness, hunters[i], id));
      const successor = await openListing(harness, maker, params({ artifact: atCommit(COMMIT_FIXED) }));
      const rolledAt = await blockTime(await (await harness.connect(maker).rollForward(id, successor)).wait());
      for (const { claimId } of claims) expect(await harness.claimState(claimId)).to.equal(ClaimState.Revealable);

      // Each claim is revealed an hour after its turn comes, judged valid, waits out the 72-hour
      // dispute window and settles (P2c's settle, through the harness). Three such rounds take
      // more than the 7-day reveal window, which without D5 would expire the fourth claim.
      let turn = rolledAt;
      for (const [i, { claimId }] of claims.entries()) {
        await time.setNextBlockTimestamp(turn + HOUR);
        const { requestId } = await revealAs(harness, hunters[i], claimId);
        await aggregator.scriptResult(requestId, [0, 0, 0, 0, 1_000_000, 0], "QmJustification");
        const [, , exists] = await aggregator.getEvaluation(requestId);
        expect(exists, `claim ${i + 1} judged`).to.equal(true);
        if (i === 3) break;
        await time.setNextBlockTimestamp(turn + HOUR + DISPUTE + HOUR);
        if (i === 2) {
          // Now past rolledAt + revealWindow: the fourth claim still cannot be expired.
          expect(turn + HOUR + DISPUTE + HOUR).to.be.greaterThan(rolledAt + REVEAL);
          await expect(harness.expire(claims[3].claimId)).to.be.revertedWith("earlier claim unresolved");
          await time.setNextBlockTimestamp(turn + HOUR + DISPUTE + HOUR + 1n);
        }
        turn = await blockTime(await (await harness.harnessResolve(claimId)).wait());
      }
      expect(turn).to.be.greaterThan(rolledAt + REVEAL);
      expect((await harness.getClaim(claims[3].claimId)).state).to.equal(ClaimState.Revealed);
      expect((await harness.getListing(id)).unrevealedClaims).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ expire
  describe("expire()", function () {
    it("commit-never-revealed-expires: anyone, revealWindow after revealable; bond to the maker, prepay back, recorded unrevealed", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      const deadline = disclosedAt + FIX + REVEAL;
      expect((await sa.claimTimes(claimId)).revealDeadline).to.equal(deadline);

      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(sa.connect(other).expire(claimId)).to.be.revertedWith("reveal window open");
      await time.setNextBlockTimestamp(deadline);
      const tx = sa.connect(other).expire(claimId);
      await expect(tx).to.changeEtherBalances([maker, hunter, other, sa], [BOND, FEE, 0n, -(BOND + FEE)]);
      await expect(tx).to.emit(sa, "Expired").withArgs(claimId, id, Expiry.Unrevealed);
      const c = await sa.getClaim(claimId);
      expect(c.state).to.equal(ClaimState.Expired);
      expect(c.expiry).to.equal(Expiry.Unrevealed);
      expect(await sa.claimState(claimId)).to.equal(ClaimState.Expired);
      const l = await sa.getListing(id);
      expect(l.unrevealedClaims).to.equal(1n);
      expect(l.undisclosedClaims).to.equal(0n);
      expect(l.pendingClaims).to.equal(0n);
      expect(l.headSince).to.equal(deadline);
      await expect(revealTx(sa, hunter, claimId, { value: 0n })).to.be.revertedWith("not committed");
      await expect(sa.expire(claimId)).to.be.revertedWith("not committed");
    });

    it("refuses a disclosed claim inside its fix window, and a revealed claim", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id);
      await expect(sa.expire(claimId)).to.be.revertedWith("fix window open");
      await time.increaseTo(disclosedAt + FIX);
      await revealAs(sa, hunter, claimId);
      await time.increase(REVEAL);
      await expect(sa.expire(claimId)).to.be.revertedWith("not committed");
      await expect(sa.expire(42n)).to.be.revertedWith("bad claimId");
    });

    it("pays a maker or hunter that rejects ETH through the pull ledger", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const rejecting = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      const id = await openListing(sa, maker);
      const data = sa.interface.encodeFunctionData("commit", [id, ARCHIVE, CT]);
      await rejecting.act(sa.target, data, { value: BOND + FEE });
      await rejecting.setRejecting(true);
      await time.increase(DISCLOSE_WINDOW);
      await expect(sa.expire(1n)).to.emit(sa, "PaymentDeferred").withArgs(rejecting.target, FEE);
      expect(await sa.withdrawable(rejecting.target)).to.equal(FEE);
    });

    for (const entry of ["expire", "commit", "reveal"]) {
      it(`re-entering ${entry}() from the bond payment is refused and both payments land`, async function () {
        const { sa, hunters } = await loadFixture(deploy);
        const r = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
        const listData = sa.interface.encodeFunctionData("list", [params(), LISTING_CID, DISPUTE_CID, []]);
        await r.act(sa.target, listData);
        const fee = await sa.feeDue(1n);
        await r.act(sa.target, sa.interface.encodeFunctionData("fund", [1n, fee]), { value: fee + TOP });
        const a = await commitAs(sa, hunters[0], 1n);
        const b = await commitAs(sa, hunters[1], 1n);
        await time.increase(DISCLOSE_WINDOW);
        const attack = {
          expire: ["expire", [b.claimId]],
          commit: ["commit", [1n, ARCHIVE, CT]],
          reveal: ["reveal", [b.claimId, BCID, CK, EK]],
        }[entry];
        await r.setAttack(sa.target, sa.interface.encodeFunctionData(...attack));
        await expect(sa.expire(a.claimId)).to.changeEtherBalances([r, hunters[0]], [BOND, FEE]);
        expect(await r.attempted()).to.equal(true);
        expect(await r.attackOk()).to.equal(false);
        expect(await r.attackReasonHash()).to.equal(ethers.keccak256(sa.interface.encodeErrorResult("Error", ["reentrant"])));
        expect((await sa.getClaim(b.claimId)).state).to.equal(ClaimState.Committed);
        expect(await sa.claimCount()).to.equal(2n);
      });
    }
  });

  // ------------------------------------------------------------------ views and events
  describe("views and events", function () {
    it("getClaim and the claim views revert for an unknown id; ids start at 1", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      await expect(sa.getClaim(0n)).to.be.revertedWith("bad claimId");
      await expect(sa.getClaim(1n)).to.be.revertedWith("bad claimId");
      const id = await openListing(sa, maker);
      expect((await commitAs(sa, hunter, id)).claimId).to.equal(1n);
      for (const view of ["getClaim", "claimState", "claimTimes", "revealTopUp"]) {
        await expect(sa[view](2n), view).to.be.revertedWith("bad claimId");
      }
      await expect(sa.commitPrice(9n)).to.be.revertedWith("bad listingId");
    });

    it("the lens answers at the StakeAttestation address and at its own, read-only", async function () {
      const { sa, maker, hunter, other } = await loadFixture(deploy);
      await expect(sa.connect(other).lensDelegate("0x")).to.be.revertedWith("self only");
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      expect(await lens.host()).to.equal(sa.target);
      const id = await openListing(sa, maker);
      const { claimId } = await claimAs(sa, hunter, id);
      expect(await lens.claimState(claimId)).to.equal(await sa.claimState(claimId));
      expect(await lens.claimTimes(claimId)).to.deep.equal(await sa.claimTimes(claimId));
      expect(await lens.commitPrice(id)).to.equal(BOND + FEE);
      // An unknown selector reaches the lens and reverts readably.
      await expect(other.sendTransaction({ to: sa.target, data: "0xdeadbeef" })).to.be.revertedWith("unknown function");
    });

    it("declares an event for every state change this node adds", async function () {
      const { sa } = await loadFixture(deploy);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of [
        "Committed", "Disclosed", "Flagged", "Released", "RolledForward", "Revealed", "EvaluationRequested",
        "SubmissionFailed", "Expired",
      ]) {
        expect(events, name).to.include(name);
      }
    });
  });

  describe("EvaluationWallet", function () {
    it("only its requester operates it; it starts once and hands every refund back to the requester", async function () {
      const { aggregator, owner, other } = await loadFixture(deploy);
      const wallet = await (await ethers.getContractFactory("EvaluationWallet")).deploy(owner.address, aggregator.target);
      const start = (signer, value = FEE) =>
        wallet.connect(signer).startEvaluation([LISTING_CID, BCID], "", 500n, ORACLE.maxOracleFee, 0n, 1n, 133n, { value });
      await expect(start(other)).to.be.revertedWith("not requester");
      await expect(wallet.connect(other).refundLeftoverEth()).to.be.revertedWith("not requester");
      await start(owner);
      await expect(start(owner)).to.be.revertedWith("already started");
      const aggId = await wallet.aggId();
      expect(await wallet.started()).to.equal(true);
      await aggregator.setRefundAmount(1000n);
      await aggregator.scriptResult(aggId, [0, 0, 0, 1_000_000, 0, 0], "QmJustification");
      await expect(wallet.refundLeftoverEth()).to.changeEtherBalance(owner, 1000n);
      // Idempotent: nothing left, nothing sent.
      await expect(wallet.refundLeftoverEth()).to.changeEtherBalance(owner, 0n);
    });

    it("refundLeftoverEth reverts when the requester refuses the ETH (the requester retries later)", async function () {
      const { aggregator } = await loadFixture(deploy);
      const requester = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      const wallet = await (await ethers.getContractFactory("EvaluationWallet")).deploy(requester.target, aggregator.target);
      const start = wallet.interface.encodeFunctionData("startEvaluation", [
        [LISTING_CID, BCID], "", 500n, ORACLE.maxOracleFee, 0n, 1n, 133n,
      ]);
      await requester.act(wallet.target, start, { value: FEE });
      await aggregator.setRefundAmount(1000n);
      await aggregator.scriptResult(await wallet.aggId(), [0, 0, 0, 1_000_000, 0, 0], "QmJustification");
      await requester.setRejecting(true);
      const refund = wallet.interface.encodeFunctionData("refundLeftoverEth");
      await expect(requester.act(wallet.target, refund)).to.be.revertedWith("repatriate failed");
      await requester.setRejecting(false);
      await expect(requester.act(wallet.target, refund)).to.changeEtherBalance(requester, 1000n);
    });
  });
});
