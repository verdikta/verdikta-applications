// StakeAttestation, listing half (build node P2a): list, fund, renew, close, the listing fee,
// the owner's powers, payments and the listing views. Design: verdikta-arbiter
// docs/development/stake-attestation-design.md §13.1-§13.2, §4.1; the build plan's decision D8
// and assumption A5 override it where they differ (stake-attestation/docs/BUILD_PLAN.md).
// The claim half (P2b-P2e) maintains pendingClaims, owedWei and the Depleted / Rolled states;
// here those are set through StakeAttestationHarness, never through a public setter.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { parseEther, ZeroAddress, ZeroHash, keccak256 } = ethers;
const coder = ethers.AbiCoder.defaultAbiCoder();

// ---- enums, in declaration order ----
const State = { Listed: 0n, Open: 1n, Depleted: 2n, Rolled: 3n, Closed: 4n };
const Outcome = { INVALID: 0n, DUPLICATE: 1n, LOW: 2n, MEDIUM: 3n, HIGH: 4n, CRITICAL: 5n };
const Kind = { Repo: 0n, Contract: 1n };

const HOUR = 3600n;
const DAY = 24n * HOUR;
const LISTING_PERIOD = 30n * DAY;

const LISTING_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const DISPUTE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const REPO = "https://github.com/acme/vault";
const COMMIT = "9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f";
const COMMIT_SHA256 = "9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f9c1e4f0a3b7d2e5c8f1a4b6d";
const DISCLOSURE_KEY = "0x" + "a1".repeat(32);

const LISTING_FEE = parseEther("0.01");
const AWARDS = [0n, parseEther("0.1"), parseEther("0.4"), parseEther("2")];
const TOP = AWARDS[3];
const CEILING = parseEther("0.0004"); // the mock aggregator's maxOracleFee, the live value

const ORACLE = {
  requestedClass: 133n,
  maxOracleFee: parseEther("0.00012"),
  disputeMaxOracleFee: parseEther("0.0002"),
  estimatedBaseCost: parseEther("0.000001"),
  alpha: 500n,
  maxFeeBasedScaling: 1n,
};

function artifact(overrides = {}) {
  return { kind: Kind.Repo, repo: REPO, baseCommit: COMMIT, chainId: 0n, addr: ZeroAddress, ...overrides };
}

function params(overrides = {}) {
  return {
    artifact: artifact(),
    disclosureKey: DISCLOSURE_KEY,
    awards: [...AWARDS],
    lowestClassCounted: Outcome.MEDIUM,
    bondWei: parseEther("0.02"),
    fixWindow: 30n * DAY,
    disputeWindow: 72n * HOUR,
    disclosureGrace: 48n * HOUR,
    revealWindow: 7n * DAY,
    allowlist: [],
    valueAtRiskUsd: 1_250_000n,
    oracle: { ...ORACLE },
    ...overrides,
  };
}

function repoHash(repo = REPO, commit = COMMIT) {
  return keccak256(coder.encode(["uint8", "string", "string"], [Kind.Repo, repo, commit]));
}

function contractHash(repo, commit, chainId, addr) {
  return keccak256(
    coder.encode(["uint8", "string", "string", "uint64", "address"], [Kind.Contract, repo, commit, chainId, addr])
  );
}

const bigintJson = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

function revertReason(reason) {
  return "0x08c379a0" + coder.encode(["string"], [reason]).slice(2);
}

function eventsOf(contract, receipt, name) {
  const address = contract.target.toLowerCase();
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => contract.interface.parseLog(l))
    .filter((e) => e && e.name === name);
}

async function blockTime(receipt) {
  return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
}

async function deploy() {
  const [owner, maker, maker2, hunter, feeRecipient, other] = await ethers.getSigners();
  const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
  const args = [await aggregator.getAddress(), owner.address, feeRecipient.address, LISTING_FEE];
  const sa = await (await ethers.getContractFactory("StakeAttestation")).deploy(...args);
  const harness = await (await ethers.getContractFactory("StakeAttestationHarness")).deploy(...args);
  return { owner, maker, maker2, hunter, feeRecipient, other, aggregator, sa, harness };
}

async function listAs(sa, signer, p = params(), ids = [], listingCid = LISTING_CID, disputeCid = DISPUTE_CID) {
  const rc = await (await sa.connect(signer).list(p, listingCid, disputeCid, ids)).wait();
  return eventsOf(sa, rc, "Listed")[0].args.listingId;
}

// The opening fund: the fee due plus `escrow`.
async function openAs(sa, signer, id, escrow = TOP) {
  const fee = await sa.feeDue(id);
  return sa.connect(signer).fund(id, fee, { value: fee + escrow });
}

// A contract actor (one of the recipient mocks) lists through its forwarding `act` call.
async function listVia(sa, actor, p = params()) {
  const data = sa.interface.encodeFunctionData("list", [p, LISTING_CID, DISPUTE_CID, []]);
  const rc = await (await actor.act(sa.target, data)).wait();
  return eventsOf(sa, rc, "Listed")[0].args.listingId;
}

async function openVia(sa, actor, id, escrow = TOP) {
  const fee = await sa.feeDue(id);
  return actor.act(sa.target, sa.interface.encodeFunctionData("fund", [id, fee]), { value: fee + escrow });
}

function closeVia(sa, actor, id) {
  return actor.act(sa.target, sa.interface.encodeFunctionData("close", [id]));
}

describe("StakeAttestation: listing lifecycle (P2a)", function () {
  describe("list()", function () {
    it("stores every §13.1 field and the per-listing oracle parameters", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const ids = [ZeroHash.slice(0, -1) + "1", "0x" + "0b".repeat(32)];
      const p = params({ allowlist: [hunter.address] });
      const tx = await sa.connect(maker).list(p, LISTING_CID, DISPUTE_CID, ids);
      const listedAt = await blockTime(await tx.wait());

      expect(await sa.listingCount()).to.equal(1n);
      const l = await sa.getListing(1n);
      expect(l.maker).to.equal(maker.address);
      expect(l.state).to.equal(State.Listed);
      expect(l.artifactKind).to.equal(Kind.Repo);
      expect(l.artifactHash).to.equal(repoHash());
      expect(l.artifactChainId).to.equal(0n);
      expect(l.artifactAddress).to.equal(ZeroAddress);
      expect(l.listingCid).to.equal(LISTING_CID);
      expect(l.disputeCid).to.equal(DISPUTE_CID);
      expect(l.disclosureKey).to.equal(DISCLOSURE_KEY);
      expect([...l.awards]).to.deep.equal(AWARDS);
      expect(l.lowestClassCounted).to.equal(Outcome.MEDIUM);
      expect(l.bondWei).to.equal(p.bondWei);
      expect(l.fixWindow).to.equal(p.fixWindow);
      expect(l.disputeWindow).to.equal(p.disputeWindow);
      expect(l.disclosureGrace).to.equal(p.disclosureGrace);
      expect(l.revealWindow).to.equal(p.revealWindow);
      expect([...l.knownIssueIds]).to.deep.equal(ids);
      expect([...l.allowlist]).to.deep.equal([hunter.address]);
      expect(l.valueAtRiskUsd).to.equal(1_250_000n);
      expect(l.escrowWei).to.equal(0n);
      expect(l.owedWei).to.equal(0n);
      expect(l.pendingClaims).to.equal(0n);
      expect(l.fundedUntil).to.equal(0n);
      expect(l.listedAt).to.equal(listedAt);
      expect(l.openedAt).to.equal(0n);
      expect(l.predecessor).to.equal(0n);
      expect(l.successor).to.equal(0n);
      expect(l.oracle.requestedClass).to.equal(ORACLE.requestedClass);
      expect(l.oracle.maxOracleFee).to.equal(ORACLE.maxOracleFee);
      expect(l.oracle.disputeMaxOracleFee).to.equal(ORACLE.disputeMaxOracleFee);
      expect(l.oracle.estimatedBaseCost).to.equal(ORACLE.estimatedBaseCost);
      expect(l.oracle.alpha).to.equal(ORACLE.alpha);
      expect(l.oracle.maxFeeBasedScaling).to.equal(ORACLE.maxFeeBasedScaling);
    });

    it("emits Listed with the artifact's identity and the two archives", async function () {
      const { sa, maker } = await loadFixture(deploy);
      await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, []))
        .to.emit(sa, "Listed")
        .withArgs(1n, maker.address, repoHash(), Kind.Repo, REPO, COMMIT, 0n, ZeroAddress, LISTING_CID, DISPUTE_CID);
    });

    it("artifactHash = keccak256(abi.encode(kind, repo, baseCommit)) for a repo", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker, params({ artifact: artifact({ baseCommit: COMMIT_SHA256 }) }));
      expect((await sa.getListing(id)).artifactHash).to.equal(repoHash(REPO, COMMIT_SHA256));
      expect(await sa.artifactHashOf(artifact())).to.equal(repoHash());
    });

    it("artifactHash = keccak256(abi.encode(kind, repo, baseCommit, chainId, address)) for a contract", async function () {
      const { sa, maker, other } = await loadFixture(deploy);
      const a = artifact({ kind: Kind.Contract, chainId: 8453n, addr: other.address });
      const id = await listAs(sa, maker, params({ artifact: a }));
      const l = await sa.getListing(id);
      expect(l.artifactHash).to.equal(contractHash(REPO, COMMIT, 8453n, other.address));
      expect(l.artifactHash).to.not.equal(repoHash());
      expect(l.artifactKind).to.equal(Kind.Contract);
      expect(l.artifactChainId).to.equal(8453n);
      expect(l.artifactAddress).to.equal(other.address);
      expect(await sa.artifactHashOf(a)).to.equal(l.artifactHash);
    });

    it("an invited listing admits only its allowlist; an open one admits everyone", async function () {
      const { sa, maker, maker2, hunter, other } = await loadFixture(deploy);
      const open = await listAs(sa, maker);
      const invited = await listAs(sa, maker2, params({ allowlist: [hunter.address] }));
      expect(await sa.isAllowed(open, other.address)).to.equal(true);
      expect(await sa.isAllowed(invited, hunter.address)).to.equal(true);
      expect(await sa.isAllowed(invited, other.address)).to.equal(false);
    });

    describe("awards and the counted class", function () {
      for (const [i, name] of [[0, "LOW > MEDIUM"], [1, "MEDIUM > HIGH"], [2, "HIGH > CRITICAL"]]) {
        it(`reverts unless awards are non-decreasing (${name})`, async function () {
          const { sa, maker } = await loadFixture(deploy);
          const awards = [parseEther("0.1"), parseEther("0.2"), parseEther("0.4"), parseEther("2")];
          awards[i] = awards[i + 1] + 1n;
          await expect(sa.connect(maker).list(params({ awards, lowestClassCounted: Outcome.LOW }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("awards decrease");
          awards[i] = awards[i + 1]; // equal neighbours are allowed
          await expect(sa.connect(maker).list(params({ awards, lowestClassCounted: Outcome.LOW }), LISTING_CID, DISPUTE_CID, []))
            .to.emit(sa, "Listed");
        });
      }

      it("reverts unless every class at or above lowestClassCounted pays more than 0", async function () {
        const { sa, maker, maker2 } = await loadFixture(deploy);
        // LOW counted but unpaid
        await expect(sa.connect(maker).list(params({ lowestClassCounted: Outcome.LOW }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("counted class pays nothing");
        // MEDIUM counted but unpaid
        const awards = [0n, 0n, parseEther("0.4"), parseEther("2")];
        await expect(sa.connect(maker).list(params({ awards }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("counted class pays nothing");
        // an unpaid class below the counted one is fine
        await expect(sa.connect(maker).list(params({ awards, lowestClassCounted: Outcome.HIGH }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
        // only CRITICAL counted
        const onlyTop = [0n, 0n, 0n, parseEther("1")];
        await expect(sa.connect(maker2).list(params({ awards: onlyTop, lowestClassCounted: Outcome.CRITICAL }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("reverts unless lowestClassCounted is LOW..CRITICAL", async function () {
        const { sa, maker } = await loadFixture(deploy);
        const all = [parseEther("0.05"), parseEther("0.1"), parseEther("0.4"), parseEther("2")];
        for (const c of [Outcome.INVALID, Outcome.DUPLICATE]) {
          await expect(sa.connect(maker).list(params({ awards: all, lowestClassCounted: c }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("bad lowestClassCounted");
        }
        // Not an outcome at all: the ABI decoder refuses it.
        await expect(sa.connect(maker).list(params({ awards: all, lowestClassCounted: 6n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.reverted;
        // LOW and CRITICAL, the two ends, are accepted (different commits: one active listing per hash and maker).
        for (const [c, commit] of [[Outcome.LOW, COMMIT], [Outcome.CRITICAL, COMMIT_SHA256]]) {
          const p = params({ awards: all, lowestClassCounted: c, artifact: artifact({ baseCommit: commit }) });
          await expect(sa.connect(maker).list(p, LISTING_CID, DISPUTE_CID, [])).to.emit(sa, "Listed");
        }
      });
    });

    describe("decision D8: window bounds (one test per bound)", function () {
      it("D8: revealWindow >= 72 h", async function () {
        const { sa, maker } = await loadFixture(deploy);
        await expect(sa.connect(maker).list(params({ revealWindow: 72n * HOUR - 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("reveal window too short");
        await expect(sa.connect(maker).list(params({ revealWindow: 72n * HOUR }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("D8: disputeWindow >= 24 h", async function () {
        const { sa, maker } = await loadFixture(deploy);
        await expect(sa.connect(maker).list(params({ disputeWindow: 24n * HOUR - 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("dispute window too short");
        await expect(sa.connect(maker).list(params({ disputeWindow: 24n * HOUR }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("D8: disclosureGrace <= fixWindow", async function () {
        const { sa, maker } = await loadFixture(deploy);
        const fixWindow = 14n * DAY;
        await expect(sa.connect(maker).list(params({ fixWindow, disclosureGrace: fixWindow + 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("grace exceeds fix window");
        await expect(sa.connect(maker).list(params({ fixWindow, disclosureGrace: fixWindow }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("D8: fixWindow <= 90 d, and 0 is allowed", async function () {
        const { sa, maker, maker2 } = await loadFixture(deploy);
        await expect(sa.connect(maker).list(params({ fixWindow: 90n * DAY + 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("fix window too long");
        await expect(sa.connect(maker).list(params({ fixWindow: 90n * DAY }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
        await expect(sa.connect(maker2).list(params({ fixWindow: 0n, disclosureGrace: 0n }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("revealWindow and disputeWindow are at most 90 d too, so no term can hold funds indefinitely", async function () {
        const { sa, maker, maker2 } = await loadFixture(deploy);
        await expect(sa.connect(maker).list(params({ revealWindow: 90n * DAY + 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("reveal window too long");
        await expect(sa.connect(maker).list(params({ disputeWindow: 90n * DAY + 1n }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("dispute window too long");
        await expect(sa.connect(maker).list(params({ revealWindow: 90n * DAY }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
        await expect(sa.connect(maker2).list(params({ disputeWindow: 90n * DAY }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });
    });

    describe("oracle parameters, validated as BountyEscrow.createBounty does", function () {
      const cases = [
        ["maxOracleFee 0", { maxOracleFee: 0n }, "bad oracle fee"],
        ["maxOracleFee above the aggregator ceiling", { maxOracleFee: CEILING + 1n }, "oracle fee above ceiling"],
        ["disputeMaxOracleFee 0", { disputeMaxOracleFee: 0n }, "bad dispute oracle fee"],
        ["disputeMaxOracleFee above the ceiling", { disputeMaxOracleFee: CEILING + 1n }, "dispute oracle fee above ceiling"],
        ["estimatedBaseCost >= maxOracleFee", { estimatedBaseCost: ORACLE.maxOracleFee }, "base cost must be below fee"],
        ["estimatedBaseCost >= disputeMaxOracleFee", { maxOracleFee: CEILING, disputeMaxOracleFee: ORACLE.estimatedBaseCost }, "base cost must be below dispute fee"],
        ["scaling 0", { maxFeeBasedScaling: 0n }, "bad fee scaling"],
        ["scaling above 1000", { maxFeeBasedScaling: 1001n }, "bad fee scaling"],
        ["alpha above 1000", { alpha: 1001n }, "bad alpha"],
      ];
      for (const [name, o, reason] of cases) {
        it(`reverts on ${name}`, async function () {
          const { sa, maker } = await loadFixture(deploy);
          await expect(sa.connect(maker).list(params({ oracle: { ...ORACLE, ...o } }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith(reason);
        });
      }

      it("accepts the boundary values: fees at the ceiling, scaling 1 and 1000, alpha 0 and 1000", async function () {
        const { sa, maker } = await loadFixture(deploy);
        const variants = [
          { maxOracleFee: CEILING, disputeMaxOracleFee: CEILING, maxFeeBasedScaling: 1000n, alpha: 1000n },
          { maxFeeBasedScaling: 1n, alpha: 0n, estimatedBaseCost: 0n },
        ];
        for (const [i, o] of variants.entries()) {
          const p = params({ oracle: { ...ORACLE, ...o }, artifact: artifact({ baseCommit: i ? COMMIT_SHA256 : COMMIT }) });
          await expect(sa.connect(maker).list(p, LISTING_CID, DISPUTE_CID, [])).to.emit(sa, "Listed");
        }
      });

      it("reverts when the aggregator would quote no budget for either fee", async function () {
        const { sa, maker, aggregator } = await loadFixture(deploy);
        await aggregator.setFeeMultiplier(0n);
        await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, [])).to.be.revertedWith("bad budget");
      });
    });

    describe("archives, artifact and listing data", function () {
      it("reverts on a malformed listingCid or disputeCid", async function () {
        const { sa, maker } = await loadFixture(deploy);
        for (const bad of ["", LISTING_CID.slice(0, 45), LISTING_CID + "," + LISTING_CID, LISTING_CID + ":x", "Q".repeat(101)]) {
          await expect(sa.connect(maker).list(params(), bad, DISPUTE_CID, [])).to.be.revertedWith("bad listingCid");
          await expect(sa.connect(maker).list(params(), LISTING_CID, bad, [])).to.be.revertedWith("bad disputeCid");
        }
      });

      it("reverts on a baseCommit that is not 40 or 64 lowercase hex", async function () {
        const { sa, maker } = await loadFixture(deploy);
        for (const bad of [COMMIT.slice(0, 39), COMMIT + "0", COMMIT.toUpperCase(), "g" + COMMIT.slice(1), ""]) {
          await expect(sa.connect(maker).list(params({ artifact: artifact({ baseCommit: bad }) }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("bad baseCommit");
        }
      });

      it("reverts on a repo that is not an https URL of printable ASCII up to 512 bytes", async function () {
        const { sa, maker } = await loadFixture(deploy);
        const long = "https://example.com/" + "a".repeat(493);
        expect(long.length).to.equal(513);
        for (const bad of ["", "http://github.com/acme/vault", "https://", "https://github.com/acme vault", "https://github.com/acme/é", long]) {
          await expect(sa.connect(maker).list(params({ artifact: artifact({ repo: bad }) }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("bad repo");
        }
        await expect(sa.connect(maker).list(params({ artifact: artifact({ repo: long.slice(0, 512) }) }), LISTING_CID, DISPUTE_CID, []))
          .to.emit(sa, "Listed");
      });

      it("a repo artifact names no deployment; a contract artifact names both chainId and address", async function () {
        const { sa, maker, other } = await loadFixture(deploy);
        for (const a of [artifact({ chainId: 8453n }), artifact({ addr: other.address })]) {
          await expect(sa.connect(maker).list(params({ artifact: a }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("repo artifact has a deployment");
        }
        for (const a of [
          artifact({ kind: Kind.Contract, chainId: 0n, addr: other.address }),
          artifact({ kind: Kind.Contract, chainId: 8453n, addr: ZeroAddress }),
        ]) {
          await expect(sa.connect(maker).list(params({ artifact: a }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("contract artifact needs a deployment");
        }
        await expect(sa.connect(maker).list(params({ artifact: artifact({ kind: 2n }) }), LISTING_CID, DISPUTE_CID, []))
          .to.be.reverted; // no third artifact kind in the MVP
      });

      it("reverts without a disclosure key", async function () {
        const { sa, maker } = await loadFixture(deploy);
        await expect(sa.connect(maker).list(params({ disclosureKey: ZeroHash }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("no disclosure key");
      });

      it("known issue ids are non-zero, strictly ascending and at most 256", async function () {
        const { sa, maker, maker2 } = await loadFixture(deploy);
        const id = (n) => ethers.toBeHex(n, 32);
        for (const bad of [[ZeroHash], [id(2), id(1)], [id(1), id(1)]]) {
          await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, bad)).to.be.revertedWith("bad knownIssueIds");
        }
        const many = Array.from({ length: 257 }, (_, i) => id(i + 1));
        await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, many)).to.be.revertedWith("too many known issues");
        const lid = await listAs(sa, maker, params(), many.slice(0, 256));
        expect((await sa.getListing(lid)).knownIssueIds.length).to.equal(256);
        await expect(sa.connect(maker2).list(params(), LISTING_CID, DISPUTE_CID, [])).to.emit(sa, "Listed"); // none is fine
      });

      it("allowlist entries are non-zero and distinct, at most 64", async function () {
        const { sa, maker, hunter } = await loadFixture(deploy);
        for (const bad of [[ZeroAddress], [hunter.address, hunter.address]]) {
          await expect(sa.connect(maker).list(params({ allowlist: bad }), LISTING_CID, DISPUTE_CID, []))
            .to.be.revertedWith("bad allowlist");
        }
        const many = Array.from({ length: 65 }, (_, i) => ethers.getAddress(ethers.toBeHex(i + 1, 20)));
        await expect(sa.connect(maker).list(params({ allowlist: many }), LISTING_CID, DISPUTE_CID, []))
          .to.be.revertedWith("allowlist too long");
        const lid = await listAs(sa, maker, params({ allowlist: many.slice(0, 64) }));
        expect((await sa.getListing(lid)).allowlist.length).to.equal(64);
      });

      it("list() takes no ETH", async function () {
        const { sa } = await loadFixture(deploy);
        expect(sa.interface.getFunction("list").payable).to.equal(false);
      });
    });
  });

  describe("listings by artifact hash (D8: one active listing per hash and maker)", function () {
    it("indexes every listing of a hash; two makers may list the same hash", async function () {
      const { sa, maker, maker2 } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      const b = await listAs(sa, maker2);
      expect([...(await sa.listingsByHash(repoHash()))]).to.deep.equal([a, b]);
      expect(await sa.listingCountByHash(repoHash())).to.equal(2n);
      expect(await sa.activeListingOf(repoHash(), maker.address)).to.equal(a);
      expect(await sa.activeListingOf(repoHash(), maker2.address)).to.equal(b);
      await openAs(sa, maker, a);
      await openAs(sa, maker2, b);
      expect(await sa.acceptsCommits(a)).to.equal(true);
      expect(await sa.acceptsCommits(b)).to.equal(true);
    });

    it("refuses a second active listing by the same maker on one hash, Listed or Open", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, [])).to.be.revertedWith("active listing exists");
      await openAs(sa, maker, a);
      await expect(sa.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, [])).to.be.revertedWith("active listing exists");
      // another commit is another hash
      await expect(sa.connect(maker).list(params({ artifact: artifact({ baseCommit: COMMIT_SHA256 }) }), LISTING_CID, DISPUTE_CID, []))
        .to.emit(sa, "Listed");
    });

    it("refuses a second listing while the first is Rolled or Depleted (still active until closed)", async function () {
      const { harness, maker } = await loadFixture(deploy);
      const a = await listAs(harness, maker);
      for (const s of [State.Rolled, State.Depleted]) {
        await harness.harnessSetState(a, s);
        await expect(harness.connect(maker).list(params(), LISTING_CID, DISPUTE_CID, [])).to.be.revertedWith("active listing exists");
      }
    });

    it("relists the same hash after close", async function () {
      const { sa, maker, maker2 } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      const b = await listAs(sa, maker2);
      await openAs(sa, maker, a);
      await sa.connect(maker).close(a);
      expect(await sa.activeListingOf(repoHash(), maker.address)).to.equal(0n);
      const c = await listAs(sa, maker);
      expect(c).to.equal(3n);
      expect(await sa.activeListingOf(repoHash(), maker.address)).to.equal(c);
      expect([...(await sa.listingsByHash(repoHash()))]).to.deep.equal([a, b, c]);
      expect((await sa.getListing(a)).state).to.equal(State.Closed); // the history stays
    });

    it("pages the listings of a hash", async function () {
      const { sa, maker, maker2, hunter } = await loadFixture(deploy);
      const ids = [await listAs(sa, maker), await listAs(sa, maker2), await listAs(sa, hunter)];
      expect([...(await sa.listingsByHashPage(repoHash(), 1n, 5n))]).to.deep.equal(ids.slice(1));
      expect([...(await sa.listingsByHashPage(repoHash(), 0n, 2n))]).to.deep.equal(ids.slice(0, 2));
      expect([...(await sa.listingsByHashPage(repoHash(), 3n, 2n))]).to.deep.equal([]);
      expect([...(await sa.listingsByHash(ZeroHash))]).to.deep.equal([]);
    });
  });

  describe("fund()", function () {
    it("opens only when escrowWei reaches awards[CRITICAL] and the listing fee is paid; emits Opened", async function () {
      const { sa, maker, feeRecipient } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      expect(await sa.feeDue(id)).to.equal(LISTING_FEE);
      await expect(sa.connect(maker).fund(id, LISTING_FEE, { value: LISTING_FEE - 1n })).to.be.revertedWith("fee not paid");
      await expect(sa.connect(maker).fund(id, LISTING_FEE, { value: LISTING_FEE + TOP - 1n }))
        .to.be.revertedWith("escrow below top award");
      expect(await sa.acceptsCommits(id)).to.equal(false);

      const tx = sa.connect(maker).fund(id, LISTING_FEE, { value: LISTING_FEE + TOP });
      await expect(tx).to.changeEtherBalances([maker, sa], [-(LISTING_FEE + TOP), LISTING_FEE + TOP]);
      const at = await blockTime(await (await tx).wait());
      await expect(tx).to.emit(sa, "Opened").withArgs(id, repoHash(), TOP, at + LISTING_PERIOD);
      await expect(tx).to.emit(sa, "Funded").withArgs(id, maker.address, TOP, TOP);
      await expect(tx).to.emit(sa, "ListingFeeAccrued").withArgs(id, feeRecipient.address, LISTING_FEE);

      const l = await sa.getListing(id);
      expect(l.state).to.equal(State.Open);
      expect(l.escrowWei).to.equal(TOP);
      expect(l.openedAt).to.equal(at);
      expect(l.fundedUntil).to.equal(at + LISTING_PERIOD);
      expect(await sa.acceptsCommits(id)).to.equal(true);
      expect(await sa.feeDue(id)).to.equal(0n);
    });

    it("an opening fund may escrow more than the top award", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id, 3n * TOP);
      expect((await sa.getListing(id)).escrowWei).to.equal(3n * TOP);
    });

    it("refuses a fee quote that is not the fee due, so a fee change cannot take the escrow", async function () {
      const { sa, owner, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await sa.connect(owner).setListingFee(parseEther("1")); // e.g. raised while the maker's fund is in flight
      await expect(sa.connect(maker).fund(id, LISTING_FEE, { value: LISTING_FEE + 2n * TOP })).to.be.revertedWith("fee changed");
      await openAs(sa, maker, id);
      await expect(sa.connect(maker).fund(id, LISTING_FEE, { value: 1n })).to.be.revertedWith("fee changed"); // none is due once open
    });

    it("only the maker funds", async function () {
      const { sa, maker, other } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await expect(sa.connect(other).fund(id, LISTING_FEE, { value: LISTING_FEE + TOP })).to.be.revertedWith("not maker");
      await expect(sa.connect(other).fund(99n, 0n, { value: 1n })).to.be.revertedWith("bad listingId");
    });

    it("allows top-ups once open: escrow grows, no fee, fundedUntil unchanged", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      const before = await sa.getListing(id);
      const accrued = await sa.withdrawable(await sa.feeRecipient());
      const tx = sa.connect(maker).fund(id, 0n, { value: parseEther("1") });
      await expect(tx).to.emit(sa, "Funded").withArgs(id, maker.address, parseEther("1"), TOP + parseEther("1"));
      await expect(tx).to.not.emit(sa, "Opened");
      await expect(tx).to.not.emit(sa, "ListingFeeAccrued");
      const after = await sa.getListing(id);
      expect(after.escrowWei).to.equal(TOP + parseEther("1"));
      expect(after.fundedUntil).to.equal(before.fundedUntil);
      expect(await sa.withdrawable(await sa.feeRecipient())).to.equal(accrued);
      await expect(sa.connect(maker).fund(id, 0n)).to.be.revertedWith("no value");
    });

    it("top-ups are allowed on a lapsed Open listing (they fund pending claims)", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await time.increase(LISTING_PERIOD + 1n);
      await expect(sa.connect(maker).fund(id, 0n, { value: 1n })).to.emit(sa, "Funded");
      expect(await sa.acceptsCommits(id)).to.equal(false);
    });

    it("tops up a Rolled listing for the claims still settling against it; it stays Rolled", async function () {
      const { harness, maker, hunter } = await loadFixture(deploy);
      const a = await listAs(harness, maker);
      await openAs(harness, maker, a);
      await harness.harnessPayFromEscrow(a, hunter.address, TOP);
      await harness.harnessSetState(a, State.Rolled);
      const topUp = harness.connect(maker).fund(a, 0n, { value: 2n * TOP });
      await expect(topUp).to.emit(harness, "Funded").withArgs(a, maker.address, 2n * TOP, 2n * TOP);
      await expect(topUp).to.not.emit(harness, "Reopened");
      const l = await harness.getListing(a);
      expect(l.state).to.equal(State.Rolled);
      expect(l.escrowWei).to.equal(2n * TOP);
      expect(await harness.acceptsCommits(a)).to.equal(false);
      await expect(harness.connect(maker).fund(a, LISTING_FEE, { value: 1n })).to.be.revertedWith("fee changed");
    });

    it("refuses a Closed listing", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      await openAs(sa, maker, a);
      await sa.connect(maker).close(a);
      await expect(sa.connect(maker).fund(a, 0n, { value: 1n })).to.be.revertedWith("not fundable");
      await expect(sa.connect(maker).fund(a, LISTING_FEE, { value: LISTING_FEE + TOP })).to.be.revertedWith("not fundable");
    });

    it("reopens a Depleted listing once escrow is back at awards[CRITICAL] and nothing is owed", async function () {
      const { harness, maker, hunter } = await loadFixture(deploy);
      const id = await listAs(harness, maker);
      await openAs(harness, maker, id);
      // stand-in for a P2c payout that leaves the escrow below the top award
      await harness.harnessPayFromEscrow(id, hunter.address, TOP / 2n);
      await harness.harnessSetState(id, State.Depleted);
      expect(await harness.acceptsCommits(id)).to.equal(false);

      await expect(harness.connect(maker).fund(id, 0n, { value: TOP / 4n })).to.not.emit(harness, "Reopened");
      expect((await harness.getListing(id)).state).to.equal(State.Depleted);

      await harness.harnessSetOwed(id, 1n);
      await expect(harness.connect(maker).fund(id, 0n, { value: TOP })).to.not.emit(harness, "Reopened");
      expect((await harness.getListing(id)).state).to.equal(State.Depleted);

      await harness.harnessSetOwed(id, 0n);
      const escrow = (await harness.getListing(id)).escrowWei + 1n;
      await expect(harness.connect(maker).fund(id, 0n, { value: 1n })).to.emit(harness, "Reopened").withArgs(id, escrow);
      expect((await harness.getListing(id)).state).to.equal(State.Open);
      expect(await harness.acceptsCommits(id)).to.equal(true);
    });
  });

  describe("renew()", function () {
    it("extends fundedUntil by 30 days for the listing fee; emits Renewed", async function () {
      const { sa, maker, feeRecipient } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      const { fundedUntil, escrowWei } = await sa.getListing(id);
      const tx = sa.connect(maker).renew(id, { value: LISTING_FEE });
      await expect(tx).to.emit(sa, "Renewed").withArgs(id, LISTING_FEE, fundedUntil + LISTING_PERIOD);
      await expect(tx).to.emit(sa, "ListingFeeAccrued").withArgs(id, feeRecipient.address, LISTING_FEE);
      const l = await sa.getListing(id);
      expect(l.fundedUntil).to.equal(fundedUntil + LISTING_PERIOD);
      expect(l.escrowWei).to.equal(escrowWei);
      // twice stacks
      await sa.connect(maker).renew(id, { value: LISTING_FEE });
      expect((await sa.getListing(id)).fundedUntil).to.equal(fundedUntil + 2n * LISTING_PERIOD);
    });

    it("after a lapse, renews 30 days from now (the lapsed gap is not bought)", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await time.increase(LISTING_PERIOD + 10n * DAY);
      const rc = await (await sa.connect(maker).renew(id, { value: LISTING_FEE })).wait();
      expect((await sa.getListing(id)).fundedUntil).to.equal((await blockTime(rc)) + LISTING_PERIOD);
    });

    it("a lapsed listing refuses new commits until renewed", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      const { fundedUntil } = await sa.getListing(id);
      await time.increaseTo(fundedUntil - 1n);
      expect(await sa.acceptsCommits(id)).to.equal(true);
      expect(await sa.isLapsed(id)).to.equal(false);
      await time.increaseTo(fundedUntil);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      expect(await sa.isLapsed(id)).to.equal(true);
      expect((await sa.getListing(id)).state).to.equal(State.Open); // still Open for pending claims
      await sa.connect(maker).renew(id, { value: LISTING_FEE });
      expect(await sa.acceptsCommits(id)).to.equal(true);
      expect(await sa.isLapsed(id)).to.equal(false);
    });

    it("charges exactly the current fee", async function () {
      const { sa, owner, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await expect(sa.connect(maker).renew(id, { value: LISTING_FEE - 1n })).to.be.revertedWith("wrong fee");
      await expect(sa.connect(maker).renew(id, { value: LISTING_FEE + 1n })).to.be.revertedWith("wrong fee");
      await sa.connect(owner).setListingFee(0n);
      await expect(sa.connect(maker).renew(id)).to.emit(sa, "Renewed");
    });

    it("only the maker renews, and only an Open or Depleted listing", async function () {
      const { harness, maker, other } = await loadFixture(deploy);
      const id = await listAs(harness, maker);
      await expect(harness.connect(maker).renew(id, { value: LISTING_FEE })).to.be.revertedWith("not renewable"); // Listed
      await openAs(harness, maker, id);
      await expect(harness.connect(other).renew(id, { value: LISTING_FEE })).to.be.revertedWith("not maker");
      await harness.harnessSetState(id, State.Depleted);
      await expect(harness.connect(maker).renew(id, { value: LISTING_FEE })).to.emit(harness, "Renewed");
      await harness.harnessSetState(id, State.Rolled);
      await expect(harness.connect(maker).renew(id, { value: LISTING_FEE })).to.be.revertedWith("not renewable");
      await harness.connect(maker).close(id);
      await expect(harness.connect(maker).renew(id, { value: LISTING_FEE })).to.be.revertedWith("not renewable");
    });
  });

  describe("acceptsCommits()", function () {
    it("is true only for an Open, funded, unlapsed listing", async function () {
      const { harness, maker, hunter } = await loadFixture(deploy);
      const id = await listAs(harness, maker);
      expect(await harness.acceptsCommits(id)).to.equal(false); // Listed
      await openAs(harness, maker, id);
      expect(await harness.acceptsCommits(id)).to.equal(true);
      for (const s of [State.Depleted, State.Rolled]) {
        await harness.harnessSetState(id, s);
        expect(await harness.acceptsCommits(id)).to.equal(false);
      }
      await harness.harnessSetState(id, State.Open);
      await harness.harnessPayFromEscrow(id, hunter.address, 1n); // Open but below the top award
      expect(await harness.acceptsCommits(id)).to.equal(false);
      await harness.connect(maker).fund(id, 0n, { value: 1n });
      expect(await harness.acceptsCommits(id)).to.equal(true);
      await harness.connect(maker).close(id);
      expect(await harness.acceptsCommits(id)).to.equal(false);
      await expect(harness.acceptsCommits(0n)).to.be.revertedWith("bad listingId");
    });
  });

  describe("close()", function () {
    it("withdraws the escrow to the maker and ends the listing", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await sa.connect(maker).fund(id, 0n, { value: parseEther("1") });
      const escrow = TOP + parseEther("1");
      const tx = sa.connect(maker).close(id);
      await expect(tx).to.changeEtherBalances([maker, sa], [escrow, -escrow]);
      await expect(tx).to.emit(sa, "Closed").withArgs(id, maker.address, escrow);
      const l = await sa.getListing(id);
      expect(l.state).to.equal(State.Closed);
      expect(l.escrowWei).to.equal(0n);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      expect(await sa.activeListingOf(repoHash(), maker.address)).to.equal(0n);
    });

    it("refuses while a claim is pending (D8)", async function () {
      const { harness, maker } = await loadFixture(deploy);
      const id = await listAs(harness, maker);
      await openAs(harness, maker, id);
      await harness.harnessSetPendingClaims(id, 1n);
      await expect(harness.connect(maker).close(id)).to.be.revertedWith("claims pending");
      await harness.harnessSetPendingClaims(id, 0n);
      await expect(harness.connect(maker).close(id)).to.emit(harness, "Closed");
    });

    it("refuses while anything is owed (D8)", async function () {
      const { harness, maker } = await loadFixture(deploy);
      const id = await listAs(harness, maker);
      await openAs(harness, maker, id);
      await harness.harnessSetOwed(id, 1n);
      await expect(harness.connect(maker).close(id)).to.be.revertedWith("amount owed");
      await harness.harnessSetOwed(id, 0n);
      await expect(harness.connect(maker).close(id)).to.emit(harness, "Closed");
    });

    it("only the maker closes, and only once", async function () {
      const { sa, maker, other } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await expect(sa.connect(other).close(id)).to.be.revertedWith("not maker");
      await sa.connect(maker).close(id);
      await expect(sa.connect(maker).close(id)).to.be.revertedWith("already closed");
      await expect(sa.connect(maker).close(42n)).to.be.revertedWith("bad listingId");
    });

    it("closes an unfunded listing, and a Rolled or Depleted one once nothing is pending or owed", async function () {
      const { harness, maker, maker2, hunter } = await loadFixture(deploy);
      const listed = await listAs(harness, maker);
      await expect(harness.connect(maker).close(listed)).to.emit(harness, "Closed").withArgs(listed, maker.address, 0n);

      const rolled = await listAs(harness, maker);
      await openAs(harness, maker, rolled);
      await harness.harnessSetState(rolled, State.Rolled);
      await expect(harness.connect(maker).close(rolled)).to.changeEtherBalance(maker, TOP);

      const depleted = await listAs(harness, maker2);
      await openAs(harness, maker2, depleted);
      await harness.harnessPayFromEscrow(depleted, hunter.address, TOP / 2n);
      await harness.harnessSetState(depleted, State.Depleted);
      await expect(harness.connect(maker2).close(depleted)).to.changeEtherBalance(maker2, TOP / 2n);
    });
  });

  describe("the listing fee and the owner's powers", function () {
    it("the fee accrues to feeRecipient as a pull balance and never counts toward escrowWei", async function () {
      const { sa, maker, maker2, feeRecipient } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      const b = await listAs(sa, maker2);
      await openAs(sa, maker, a);
      await openAs(sa, maker2, b, 2n * TOP);
      await sa.connect(maker).renew(a, { value: LISTING_FEE });

      expect((await sa.getListing(a)).escrowWei).to.equal(TOP);
      expect((await sa.getListing(b)).escrowWei).to.equal(2n * TOP);
      expect(await sa.withdrawable(feeRecipient.address)).to.equal(3n * LISTING_FEE);
      // The contract holds exactly the escrows plus the pull balances.
      expect(await ethers.provider.getBalance(sa.target)).to.equal(3n * TOP + 3n * LISTING_FEE);

      const pull = sa.connect(feeRecipient).withdraw();
      await expect(pull).to.emit(sa, "Withdrawn").withArgs(feeRecipient.address, 3n * LISTING_FEE);
      await expect(pull).to.changeEtherBalance(feeRecipient, 3n * LISTING_FEE);
      expect(await sa.withdrawable(feeRecipient.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(sa.target)).to.equal(3n * TOP);

      // Closing returns the escrow only; the fee already paid stays paid.
      await expect(sa.connect(maker).close(a)).to.changeEtherBalance(maker, TOP);
      await expect(sa.connect(feeRecipient).withdraw()).to.be.revertedWith("nothing to withdraw");
    });

    it("setListingFee applies from the next fund or renew", async function () {
      const { sa, owner, maker, maker2, feeRecipient } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      await openAs(sa, maker, a);
      const before = bigintJson(await sa.getListing(a));
      const newFee = parseEther("0.03");
      await expect(sa.connect(owner).setListingFee(newFee)).to.emit(sa, "ListingFeeSet").withArgs(LISTING_FEE, newFee);
      expect(await sa.listingFeeWei()).to.equal(newFee);
      expect(bigintJson(await sa.getListing(a))).to.equal(before); // nothing already paid changes
      expect(await sa.withdrawable(feeRecipient.address)).to.equal(LISTING_FEE);

      await expect(sa.connect(maker).renew(a, { value: LISTING_FEE })).to.be.revertedWith("wrong fee");
      await sa.connect(maker).renew(a, { value: newFee });
      const b = await listAs(sa, maker2);
      expect(await sa.feeDue(b)).to.equal(newFee);
      await openAs(sa, maker2, b);
      expect(await sa.withdrawable(feeRecipient.address)).to.equal(LISTING_FEE + 2n * newFee);
    });

    it("setFeeRecipient applies from the next fee; the previous recipient keeps what accrued", async function () {
      const { sa, owner, maker, feeRecipient, other } = await loadFixture(deploy);
      const a = await listAs(sa, maker);
      await openAs(sa, maker, a);
      await expect(sa.connect(owner).setFeeRecipient(other.address))
        .to.emit(sa, "FeeRecipientSet").withArgs(feeRecipient.address, other.address);
      expect(await sa.feeRecipient()).to.equal(other.address);
      await sa.connect(maker).renew(a, { value: LISTING_FEE });
      expect(await sa.withdrawable(feeRecipient.address)).to.equal(LISTING_FEE);
      expect(await sa.withdrawable(other.address)).to.equal(LISTING_FEE);
      await expect(sa.connect(owner).setFeeRecipient(ZeroAddress)).to.be.revertedWith("bad fee recipient");
      await expect(sa.connect(owner).setFeeRecipient(sa.target)).to.be.revertedWith("bad fee recipient");
    });

    it("the constructor refuses a zero aggregator, a zero fee recipient or itself as the recipient", async function () {
      const { owner, aggregator } = await loadFixture(deploy);
      const SA = await ethers.getContractFactory("StakeAttestation");
      await expect(SA.deploy(ZeroAddress, owner.address, owner.address, 0n)).to.be.revertedWith("zero aggregator");
      await expect(SA.deploy(aggregator.target, owner.address, ZeroAddress, 0n)).to.be.revertedWith("bad fee recipient");
      // The address the next deployment will get: fees credited there could never be withdrawn.
      const nonce = await ethers.provider.getTransactionCount(owner.address);
      const predicted = ethers.getCreateAddress({ from: owner.address, nonce });
      await expect(SA.connect(owner).deploy(aggregator.target, owner.address, predicted, 0n)).to.be.revertedWith("bad fee recipient");
    });

    it("only the owner sets the fee and the recipient", async function () {
      const { sa, maker } = await loadFixture(deploy);
      await expect(sa.connect(maker).setListingFee(0n)).to.be.revertedWithCustomError(sa, "OwnableUnauthorizedAccount");
      await expect(sa.connect(maker).setFeeRecipient(maker.address)).to.be.revertedWithCustomError(sa, "OwnableUnauthorizedAccount");
    });

    it("the owner's only powers are the listing fee and the fee recipient", async function () {
      const { sa, maker } = await loadFixture(deploy);
      // Every state-changing entry point. A new one must be added here with its authorization.
      const mutating = sa.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(mutating).to.deep.equal([
        "acceptOwnership", // Ownable2Step: the pending owner takes over; no other power
        "close", // maker only
        "fund", // maker only
        "list", // anyone, for themselves
        "renew", // maker only
        "renounceOwnership", // owner: gives up the two powers below
        "setFeeRecipient", // owner
        "setListingFee", // owner
        "transferOwnership", // owner: hands over the two powers
        "withdraw", // msg.sender's own pull balance
      ]);
      // Program values the owner can never change: no setter exists for any of them.
      expect(await sa.THRESHOLD()).to.equal(500_001n);
      expect(await sa.SCORE_SCALE()).to.equal(1_000_000n);
      expect(await sa.LISTING_PERIOD()).to.equal(LISTING_PERIOD);
      expect(await sa.PAYOUT_GAS_LIMIT()).to.equal(120_000n);
      for (const name of mutating) {
        expect(name, "no setter beyond the fee and its recipient").to.not.match(/^set(?!ListingFee$|FeeRecipient$)/);
      }
      const owner = await ethers.getSigner(await sa.owner());
      expect(owner.address).to.not.equal(maker.address);
    });

    it("the owner cannot fund, renew, close or withdraw a maker's listing, nor change its terms", async function () {
      const { sa, owner, maker, other } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      const before = bigintJson(await sa.getListing(id));
      const balance = await ethers.provider.getBalance(sa.target);

      await expect(sa.connect(owner).fund(id, 0n, { value: 1n })).to.be.revertedWith("not maker");
      await expect(sa.connect(owner).renew(id, { value: LISTING_FEE })).to.be.revertedWith("not maker");
      await expect(sa.connect(owner).close(id)).to.be.revertedWith("not maker");
      await expect(sa.connect(owner).withdraw()).to.be.revertedWith("nothing to withdraw");

      // Everything the owner may do, then: the listing and the escrow are untouched.
      await sa.connect(owner).setListingFee(parseEther("5"));
      await sa.connect(owner).setFeeRecipient(owner.address);
      await sa.connect(owner).transferOwnership(other.address);
      await sa.connect(other).acceptOwnership();
      expect(bigintJson(await sa.getListing(id))).to.equal(before);
      expect(await ethers.provider.getBalance(sa.target)).to.equal(balance);
      await expect(sa.connect(maker).close(id)).to.changeEtherBalance(maker, TOP);
    });
  });

  describe("payments: _payOrCredit with a gas cap, and withdraw()", function () {
    it("a maker that rejects ETH is credited on close and withdraws later (MockRejectingHunter)", async function () {
      const { sa } = await loadFixture(deploy);
      const m = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      const id = await listVia(sa, m);
      await openVia(sa, m, id);
      await m.setRejecting(true);
      await expect(closeVia(sa, m, id)).to.emit(sa, "PaymentDeferred").withArgs(m.target, TOP);
      expect((await sa.getListing(id)).state).to.equal(State.Closed);
      expect(await sa.withdrawable(m.target)).to.equal(TOP);
      await expect(m.claim(sa.target)).to.be.revertedWith("withdraw failed");
      expect(await sa.withdrawable(m.target)).to.equal(TOP);
      await m.setRejecting(false);
      const pull = m.claim(sa.target);
      await expect(pull).to.emit(sa, "Withdrawn").withArgs(m.target, TOP);
      await expect(pull).to.changeEtherBalance(m, TOP);
      expect(await sa.withdrawable(m.target)).to.equal(0n);
    });

    it("a fee recipient that rejects ETH keeps its pull balance until it can receive", async function () {
      const { sa, owner, maker } = await loadFixture(deploy);
      const m = await (await ethers.getContractFactory("MockRejectingHunter")).deploy();
      await sa.connect(owner).setFeeRecipient(m.target);
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await m.setRejecting(true);
      await expect(m.claim(sa.target)).to.be.revertedWith("withdraw failed");
      await m.setRejecting(false);
      await expect(m.claim(sa.target)).to.changeEtherBalance(m, LISTING_FEE);
    });

    it("a gas-hungry maker is paid directly under the cap and credited above it (MockGasHungryRecipient)", async function () {
      const { sa } = await loadFixture(deploy);
      const Hungry = await ethers.getContractFactory("MockGasHungryRecipient");

      const light = await Hungry.deploy();
      const a = await listVia(sa, light);
      await openVia(sa, light, a);
      await light.setGasToConsume(10_000n);
      await expect(closeVia(sa, light, a)).to.not.emit(sa, "PaymentDeferred");
      expect(await light.received()).to.equal(TOP);

      const heavy = await Hungry.deploy();
      const b = await listVia(sa, heavy);
      await openVia(sa, heavy, b);
      await heavy.setGasToConsume(200_000n);
      await expect(closeVia(sa, heavy, b)).to.emit(sa, "PaymentDeferred").withArgs(heavy.target, TOP);
      expect(await heavy.received()).to.equal(0n);
      expect(await sa.withdrawable(heavy.target)).to.equal(TOP);
      await heavy.claim(sa.target); // withdraw forwards full gas
      expect(await heavy.received()).to.equal(TOP);
    });

    it("a maker that burns all gas costs close() at most the cap", async function () {
      const { sa } = await loadFixture(deploy);
      const burner = await (await ethers.getContractFactory("MockGasHungryRecipient")).deploy();
      const id = await listVia(sa, burner);
      await openVia(sa, burner, id);
      await burner.setBurnAll(true);
      const rc = await (await closeVia(sa, burner, id)).wait();
      expect(eventsOf(sa, rc, "PaymentDeferred")).to.have.length(1);
      expect(rc.gasUsed).to.be.lessThan(300_000n);
      expect(await sa.withdrawable(burner.target)).to.equal(TOP);
    });

    it("withdraw() with nothing owed reverts", async function () {
      const { sa, other } = await loadFixture(deploy);
      await expect(sa.connect(other).withdraw()).to.be.revertedWith("nothing to withdraw");
    });

    for (const entry of ["close", "fund", "renew", "withdraw"]) {
      it(`re-entering ${entry}() from a close-out payment is refused and the payment still lands`, async function () {
        const { sa } = await loadFixture(deploy);
        const r = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
        const id = await listVia(sa, r);
        await openVia(sa, r, id);
        // A second Open listing of the same maker, so the re-entrant call is otherwise valid.
        const other = await listVia(sa, r, params({ artifact: artifact({ baseCommit: COMMIT_SHA256 }) }));
        await openVia(sa, r, other);
        const args = { close: [other], fund: [other, 0n], renew: [other], withdraw: [] }[entry];
        await r.setAttack(sa.target, sa.interface.encodeFunctionData(entry, args));
        await expect(closeVia(sa, r, id)).to.changeEtherBalance(r, TOP);
        expect(await r.attempted()).to.equal(true);
        expect(await r.attackOk()).to.equal(false);
        expect(await r.attackReasonHash()).to.equal(keccak256(revertReason("reentrant")));
        expect((await sa.getListing(other)).state).to.equal(State.Open);
      });
    }

    it("re-entering withdraw() from withdraw() is refused and the balance is paid once", async function () {
      const { sa, owner, maker } = await loadFixture(deploy);
      const r = await (await ethers.getContractFactory("MockReentrantRecipient")).deploy();
      await sa.connect(owner).setFeeRecipient(r.target); // the fee gives it a pull balance
      const id = await listAs(sa, maker);
      await openAs(sa, maker, id);
      await r.setAttack(sa.target, sa.interface.encodeFunctionData("withdraw"));
      await expect(r.claim(sa.target)).to.changeEtherBalances([r, sa], [LISTING_FEE, -LISTING_FEE]);
      expect(await r.attempted()).to.equal(true);
      expect(await r.attackOk()).to.equal(false);
      expect(await r.attackReasonHash()).to.equal(keccak256(revertReason("reentrant")));
      expect(await sa.withdrawable(r.target)).to.equal(0n);
    });
  });

  describe("views and events", function () {
    it("getListing reverts for an unknown id; ids start at 1", async function () {
      const { sa, maker } = await loadFixture(deploy);
      await expect(sa.getListing(0n)).to.be.revertedWith("bad listingId");
      await expect(sa.getListing(1n)).to.be.revertedWith("bad listingId");
      expect(await listAs(sa, maker)).to.equal(1n);
      await expect(sa.getListing(2n)).to.be.revertedWith("bad listingId");
      for (const view of ["acceptsCommits", "isLapsed", "feeDue"]) {
        await expect(sa[view](2n)).to.be.revertedWith("bad listingId");
      }
      await expect(sa.isAllowed(2n, maker.address)).to.be.revertedWith("bad listingId");
    });

    it("isLapsed is false before a listing opens", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await listAs(sa, maker);
      expect(await sa.isLapsed(id)).to.equal(false);
    });

    it("declares an event for every state change this node adds", async function () {
      const { sa } = await loadFixture(deploy);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of [
        "Listed", "Funded", "Opened", "Reopened", "Renewed", "ListingFeeAccrued", "Closed",
        "ListingFeeSet", "FeeRecipientSet", "PaymentDeferred", "Withdrawn",
      ]) {
        expect(events, name).to.include(name);
      }
    });
  });
});
