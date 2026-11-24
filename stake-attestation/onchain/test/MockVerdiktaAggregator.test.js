// Tests for the mock aggregator, the v2 ReputationAggregator's stand-in (verdikta-dispatcher,
// `beacon` branch, reputationBasedAggregator/contracts/ReputationAggregator.sol). The mock is
// example-bounty-program's, byte for byte; these tests pin it to the real contract's
// requester-visible behaviour, as StakeAttestation relies on it: the escrow formula and
// fund-from-credit, sequential ids, the draw (B+2, the requester's 30 s, a day's limit), the beacon
// stage, the commit window's M+ / T+ close, promote, finalization, settle after the deadline,
// cancelUnsealed, and where every refund goes (the requester, or the treasury).
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CEILING = ethers.parseEther("0.0004");
// A six-outcome vector, as the stake-attestation classes return.
const RESULT = [0, 0, 0, 0, 1_000_000, 0];
const TREASURY = "0x0000000000000000000000000000000000007EA5";
const ARBITERS = "0x00000000000000000000000000000000A4B17E45";
// Juries (the request's last argument): the Small and Jumbo class presets.
const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
const JUMBO = { K: 50, M: 38, N: 27, P: 17, timeout: 600 };
const PH = { DRAW: 1n, BEACON: 2n, COMMIT: 3n, CLOSING: 4n, REVEAL: 5n, FINAL: 6n, SETTLED: 7n, FAILED: 8n, CANCELLED: 9n };

function args(overrides = {}) {
  return {
    cids: [CID],
    addendum: "",
    alpha: 500n,
    maxFee: CEILING,
    minFee: 0n,
    baseCost: CEILING / 100n,
    scaling: 5n,
    requestedClass: 133n,
    withBeacons: false,
    jury: SMALL,
    ...overrides,
  };
}

async function deploy() {
  const [owner, hunter, other] = await ethers.getSigners();
  const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
  const requester = await (await ethers.getContractFactory("MockPollingRequester")).deploy(await aggregator.getAddress());
  return { owner, hunter, other, aggregator, requester };
}

const send = (aggregator, signer, a, value, overrides = {}) =>
  aggregator.connect(signer).requestAIEvaluationWithApproval(
    a.cids, a.addendum, a.alpha, a.maxFee, a.minFee, a.baseCost, a.scaling, a.requestedClass, a.withBeacons, a.jury,
    { value, ...overrides }
  );

// Sends a request from an EOA and returns its id (from the event).
async function request(aggregator, signer, a = args(), value) {
  const required = await aggregator.maxTotalFee(a.maxFee, a.minFee, a.withBeacons, a.jury.K, a.jury.P);
  const receipt = await (await send(aggregator, signer, a, value === undefined ? required : value)).wait();
  return receipt.logs
    .map((l) => { try { return aggregator.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "RequestAIEvaluation").args.aggRequestId;
}

async function info(aggregator, id) {
  const r = await aggregator.getRoundInfo(id);
  return { ...r.toObject(), leftover: r.received - r.baseFees - r.bonuses - r.rewards };
}

// Mine to B+2 and draw as `signer` (the reward goes to whoever draws, within the rules).
async function draw(aggregator, id, signer) {
  const { requestBlock } = await info(aggregator, id);
  const now = BigInt(await ethers.provider.getBlockNumber());
  if (now < requestBlock + 2n) await mine(Number(requestBlock + 2n - now));
  return aggregator.connect(signer).drawJury(id);
}

describe("Hardhat tooling", function () {
  it("compiles with solc 0.8.23 and loads the gas reporter and solidity-coverage", async function () {
    const versions = hre.config.solidity.compilers.map((c) => c.version);
    expect(versions).to.deep.equal(["0.8.23"]);
    expect(hre.config.gasReporter, "gasReporter config").to.be.an("object");
    expect(hre.tasks, "hardhat-gas-reporter task").to.have.property("gas-reporter:merge");
    expect(hre.tasks, "solidity-coverage task").to.have.property("coverage");
  });

  it("needs no network secrets: tests run in-process, and the deploy networks (P2e) are Base Sepolia and Base, keyed from the environment", async function () {
    expect(hre.network.name).to.equal("hardhat");
    const remote = Object.entries(hre.config.networks).filter(
      ([name, cfg]) => name !== "hardhat" && name !== "localhost" && cfg.url && !/127\.0\.0\.1|localhost/.test(cfg.url)
    );
    expect(remote.map(([name]) => name).sort()).to.deep.equal(["base", "base_sepolia"]);
    // No key in the config: the accounts are PRIVATE_KEY from the environment, or none.
    for (const [, cfg] of remote) expect(cfg.accounts.length).to.equal(process.env.PRIVATE_KEY ? 1 : 0);
  });
});

describe("MockVerdiktaAggregator (v2)", function () {
  describe("interface", function () {
    const bountyFile = (...p) => path.join(__dirname, "..", "..", "..", "example-bounty-program", "onchain", "contracts", ...p);
    const ourFile = (...p) => path.join(__dirname, "..", "contracts", ...p);
    const norm = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

    it("conformance: the interface is the bounty program's, byte for byte", function () {
      expect(norm(ourFile("interfaces", "IVerdiktaAggregator.sol")), "a change to the aggregator interface goes to both copies")
        .to.equal(norm(bountyFile("interfaces", "IVerdiktaAggregator.sol")));
    });

    it("conformance: the mock is the bounty program's, byte for byte", function () {
      expect(norm(ourFile("mocks", "MockVerdiktaAggregator.sol")), "a change to the mock goes to both copies")
        .to.equal(norm(bountyFile("mocks", "MockVerdiktaAggregator.sol")));
    });

    // The mock is the interface, function by function and event by event, so a test that passes
    // against the mock calls the deployed aggregator the same way.
    it("conformance: every IVerdiktaAggregator function has the mock's inputs, outputs and state mutability", async function () {
      const iface = new ethers.Interface((await hre.artifacts.readArtifact("IVerdiktaAggregator")).abi);
      const mock = new ethers.Interface((await hre.artifacts.readArtifact("MockVerdiktaAggregator")).abi);
      const shape = (f) => ({
        sig: f.format("sighash"),
        outputs: f.outputs.map((o) => o.format("sighash")),
        mutability: f.stateMutability,
      });
      const fns = iface.fragments.filter((f) => f.type === "function");
      expect(fns.map((f) => f.name).sort()).to.deep.equal([
        "beacons", "cancelUnsealed", "closeCommits", "drawJury", "ethOwed", "getEvaluation", "getJury",
        "getOutcomeScores", "getRoundInfo", "isFailed", "maxJury", "maxOracleFee", "maxTimeout", "maxTotalFee", "promote",
        "requestAIEvaluationWithApproval", "sealSeed", "settle", "withdrawEth",
      ]);
      for (const f of fns) expect(shape(mock.getFunction(f.format("sighash"))), f.name).to.deep.equal(shape(f));
      expect(fns.filter((f) => f.payable).map((f) => f.name)).to.deep.equal(["requestAIEvaluationWithApproval"]);
    });

    it("conformance: every IVerdiktaAggregator event is the mock's, with the same signature and indexed fields", async function () {
      const iface = new ethers.Interface((await hre.artifacts.readArtifact("IVerdiktaAggregator")).abi);
      const mock = new ethers.Interface((await hre.artifacts.readArtifact("MockVerdiktaAggregator")).abi);
      for (const e of iface.fragments.filter((f) => f.type === "event")) {
        const m = mock.getEvent(e.topicHash);
        expect(m, e.name).to.not.equal(null);
        expect(m.inputs.map((i) => [i.type, i.indexed]), e.name).to.deep.equal(e.inputs.map((i) => [i.type, i.indexed]));
      }
    });

    it("has no requester callback: a whole round never calls the requester, which learns everything by polling", async function () {
      const { aggregator, requester } = await deploy();
      const a = args();
      const required = await aggregator.maxTotalFee(a.maxFee, 0, false, 6, 3);
      await requester.request(a.cids, "", 500, a.maxFee, 0, a.baseCost, 5, 133, false, SMALL, { value: required });
      const id = await requester.lastRequestId();
      await mine(2);
      await requester.draw();
      await aggregator.scriptResult(id, RESULT, "QmJustification");
      expect(await requester.unexpectedCalls()).to.equal(0n);
      const [scores, just, valid] = await aggregator.getEvaluation(id);
      expect(scores.map(Number)).to.deep.equal(RESULT);
      expect(just).to.equal("QmJustification");
      expect(valid).to.equal(true);
      // Refunds and the draw reward arrive as pull credit, never pushed.
      const { leftover } = await info(aggregator, id);
      expect(await aggregator.ethOwed(await requester.getAddress())).to.equal(leftover + 2n * CEILING);
      await requester.withdraw();
      expect(await aggregator.ethOwed(await requester.getAddress())).to.equal(0n);
      expect(await requester.unexpectedCalls()).to.equal(0n);
    });

    it("has no receive(): plain ETH is refused, as by the real aggregator", async function () {
      const { aggregator, hunter } = await deploy();
      await expect(hunter.sendTransaction({ to: await aggregator.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("input limits (the real aggregator's constants; BadInput)", function () {
    it("exposes MAX_CID_COUNT 10, MAX_CID_LENGTH 100, MAX_ADDENDUM_LENGTH 1000", async function () {
      const { aggregator } = await deploy();
      expect(await aggregator.MAX_CID_COUNT()).to.equal(10n);
      expect(await aggregator.MAX_CID_LENGTH()).to.equal(100n);
      expect(await aggregator.MAX_ADDENDUM_LENGTH()).to.equal(1000n);
    });

    it("accepts 10 CIDs of 100 bytes and a 1000-byte addendum; rejects 11 CIDs, none, 101 bytes and 1001 bytes", async function () {
      const { aggregator, hunter } = await deploy();
      await request(aggregator, hunter, args({ cids: Array(10).fill("b".repeat(100)), addendum: "a".repeat(1000) }));
      for (const bad of [{ cids: Array(11).fill(CID) }, { cids: [] }, { cids: [CID, "b".repeat(101)] }, { addendum: "a".repeat(1001) }]) {
        await expect(request(aggregator, hunter, args(bad))).to.be.revertedWithCustomError(aggregator, "BadInput");
      }
    });

    it("rejects alpha above 1000, a base cost at the clamped fee, and a scaling factor of 0", async function () {
      const { aggregator, hunter } = await deploy();
      await request(aggregator, hunter, args({ alpha: 1000n }));
      for (const bad of [{ alpha: 1001n }, { baseCost: CEILING }, { maxFee: CEILING * 2n, baseCost: CEILING }, { scaling: 0n }]) {
        await expect(request(aggregator, hunter, args(bad))).to.be.revertedWithCustomError(aggregator, "BadInput");
      }
    });

    it("refuses new requests while paused, like the real circuit breaker", async function () {
      const { aggregator, hunter } = await deploy();
      await aggregator.setPaused(true);
      await expect(request(aggregator, hunter)).to.be.revertedWithCustomError(aggregator, "EnforcedPause");
      await aggregator.setPaused(false);
      await request(aggregator, hunter);
    });

    it("records what the requester forwarded, for request-composition tests", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter, args({ cids: [CID, "QmClaim"], addendum: "line", minFee: 7n }));
      expect(await aggregator.getRequestCids(id)).to.deep.equal([CID, "QmClaim"]);
      const p = await aggregator.requestParams(id);
      expect([p.addendum, p.alpha, p.maxFee, p.minFee, p.requestedClass, p.withBeacons])
        .to.deep.equal(["line", 500n, CEILING, 7n, 133n, false]);
      expect(await aggregator.requesterOf(id)).to.equal(hunter.address);
    });

    it("numbers rounds from 1, aggId = bytes32(roundId)", async function () {
      const { aggregator, hunter } = await deploy();
      expect(await request(aggregator, hunter)).to.equal(ethers.toBeHex(1, 32));
      expect(await request(aggregator, hunter)).to.equal(ethers.toBeHex(2, 32));
    });
  });

  describe("the jury: the request's, checked by the real rules (BadJury)", function () {
    for (const [label, jury] of [
      ["M above K", { ...SMALL, K: 4 }],
      ["N above M", { ...SMALL, N: 6 }],
      ["P above N", { ...SMALL, P: 5 }],
      ["P = 0", { ...SMALL, P: 0 }],
      ["P = 1 with N > 1", { ...SMALL, P: 1 }],
      ["N above 40", { K: 50, M: 45, N: 41, P: 17, timeout: 600 }],
      ["K above maxJury (50)", { K: 51, M: 38, N: 27, P: 17, timeout: 600 }],
      ["a timeout at T+ (155)", { ...SMALL, timeout: 155 }],
      ["a timeout above maxTimeout (3600)", { ...SMALL, timeout: 3601 }],
    ]) {
      it(`refuses ${label}`, async function () {
        const { aggregator, hunter } = await deploy();
        await expect(send(aggregator, hunter, args({ jury }), CEILING * 1000n)).to.be.revertedWithCustomError(aggregator, "BadJury");
      });
    }

    it("accepts N = P = 1, and the limits are settable (setLimits; BadInput for 0 or a timeout bound at T+)", async function () {
      const { aggregator, hunter } = await deploy();
      expect([await aggregator.maxJury(), await aggregator.maxTimeout()]).to.deep.equal([50n, 3600n]);
      const id = await request(aggregator, hunter, args({ jury: { K: 1, M: 1, N: 1, P: 1, timeout: 156 } }));
      expect(await aggregator.getJury(id)).to.deep.equal([1n, 1n, 1n, 1n, 156n]);
      await aggregator.setLimits(8, 1000);
      await expect(send(aggregator, hunter, args({ jury: { K: 10, M: 8, N: 7, P: 4, timeout: 300 } }), CEILING * 1000n))
        .to.be.revertedWithCustomError(aggregator, "BadJury");
      await expect(send(aggregator, hunter, args({ jury: { ...SMALL, timeout: 1001 } }), CEILING * 1000n))
        .to.be.revertedWithCustomError(aggregator, "BadJury");
      await expect(aggregator.setLimits(0, 1000)).to.be.revertedWithCustomError(aggregator, "BadInput");
      await expect(aggregator.setLimits(8, 155)).to.be.revertedWithCustomError(aggregator, "BadInput");
    });

    it("stores each round's jury: a Small and a Jumbo round side by side, each escrowed, drawn and finalized by its own", async function () {
      const { aggregator, hunter } = await deploy();
      const small = await request(aggregator, hunter);
      const jumbo = await request(aggregator, hunter, args({ jury: JUMBO }));
      expect(await aggregator.getJury(small)).to.deep.equal([6n, 5n, 4n, 3n, 300n]);
      expect(await aggregator.getJury(jumbo)).to.deep.equal([50n, 38n, 27n, 17n, 600n]);
      expect(await aggregator.getJury(ethers.toBeHex(9, 32))).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
      expect((await info(aggregator, jumbo)).received).to.equal(await aggregator.maxTotalFee(CEILING, 0, false, 50, 17));
      await draw(aggregator, jumbo, hunter);
      const at = BigInt(await time.latest());
      const r = await info(aggregator, jumbo);
      expect([r.baseFees, r.deadline]).to.deep.equal([50n * CEILING, at + 600n]);
      await aggregator.scriptCommits(jumbo, 44);                         // M+ = 38 + ceil(12 / 2)
      expect((await info(aggregator, jumbo)).phase).to.equal(PH.CLOSING);
      await mine(2);
      await aggregator.promote(jumbo);
      await expect(aggregator.scriptReveals(jumbo, Array(4).fill(RESULT), "Qm")).to.be.revertedWithCustomError(aggregator, "Unreachable");
      await aggregator.scriptReveals(jumbo, Array(27).fill(RESULT), "Qm");
      const [scores, valid] = await aggregator.getOutcomeScores(jumbo, 4);
      expect([scores.length, valid]).to.deep.equal([27, true]);
      await draw(aggregator, small, hunter);
      await aggregator.scriptResult(small, RESULT, "Qm");
      expect((await aggregator.getOutcomeScores(small, 4))[0].length).to.equal(4);
    });
  });

  describe("the escrow and fund-from-credit", function () {
    it("prices maxTotalFee as max(eff, minFee) x (K + B x P [+ quorum]) + eff x (draw + promote)", async function () {
      const { aggregator } = await deploy();
      const fee = CEILING / 4n;
      expect(await aggregator.maxTotalFee(fee, 0, false, 6, 3)).to.equal(fee * 15n + fee * 3n);
      expect(await aggregator.maxTotalFee(CEILING * 2n, 0, false, 6, 3)).to.equal(CEILING * 18n); // clamped
      expect(await aggregator.maxTotalFee(fee, fee * 2n, false, 6, 3)).to.equal(fee * 2n * 15n + fee * 3n); // the floor
      expect(await aggregator.maxTotalFee(fee, CEILING * 2n, false, 6, 3)).to.equal(CEILING * 2n * 15n + fee * 3n); // above the ceiling
      expect(await aggregator.maxTotalFee(fee, 0, true, 6, 3)).to.equal(fee * 17n + fee * 3n); // a quorum of 2
      // the jury is the request's: K = 10, P = 4
      expect(await aggregator.maxTotalFee(fee, 0, false, 10, 4)).to.equal(fee * 22n + fee * 3n);
      await aggregator.setBonusMultiplier(2);
      await aggregator.setRewards(3, 2);
      expect(await aggregator.maxTotalFee(fee, 0, false, 10, 4)).to.equal(fee * 18n + fee * 5n);
      await aggregator.setBeacons(false, 2);
      await expect(aggregator.maxTotalFee(fee, 0, true, 6, 3)).to.be.reverted;
    });

    it("takes msg.value first, then credit for a shortfall (InsufficientPayment without), and excess value to credit", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(CEILING, 0, false, 6, 3);
      await expect(request(aggregator, hunter, args(), required - 1n)).to.be.revertedWithCustomError(aggregator, "InsufficientPayment");
      await expect(send(aggregator, hunter, args(), required + 5n))
        .to.emit(aggregator, "RequestFunded").withArgs(anyValue, hunter.address, 0n, required + 5n);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(5n);
      // A shortfall of 5 comes from that credit.
      await expect(send(aggregator, hunter, args(), required - 5n))
        .to.emit(aggregator, "RequestFunded").withArgs(anyValue, hunter.address, 5n, required - 5n);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
      const id = ethers.toBeHex(2, 32);
      expect((await info(aggregator, id)).received).to.equal(required);
    });

    it("withdrawEth pays the caller's credit and reverts NothingOwed on zero", async function () {
      const { aggregator, hunter } = await deploy();
      await send(aggregator, hunter, args(), (await aggregator.maxTotalFee(CEILING, 0, false, 6, 3)) + 9n);
      await expect(aggregator.connect(hunter).withdrawEth()).to.changeEtherBalance(hunter, 9n);
      await expect(aggregator.connect(hunter).withdrawEth()).to.be.revertedWithCustomError(aggregator, "NothingOwed");
    });
  });

  describe("the draw", function () {
    it("from block B+2 (TooEarly before); base fees at the draw; the deadline and T+ run from it", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await expect(aggregator.connect(hunter).drawJury(id)).to.be.revertedWithCustomError(aggregator, "TooEarly");
      const before = await info(aggregator, id);
      expect([before.phase, before.deadline, before.baseFees]).to.deep.equal([PH.DRAW, 0n, 0n]);
      await expect(draw(aggregator, id, hunter)).to.emit(aggregator, "JuryDrawn").withArgs(id, hunter.address, 2n * CEILING);
      const at = BigInt(await time.latest());
      const r = await info(aggregator, id);
      expect(r.phase).to.equal(PH.COMMIT);
      expect(r.baseFees).to.equal(6n * CEILING);
      expect(r.deadline).to.equal(at + 300n);   // the request's jury timeout (Small)
      expect(r.windowEnd).to.equal(at + (await aggregator.tPlus()));
      await expect(aggregator.drawJury(id)).to.be.revertedWithCustomError(aggregator, "WrongPhase");
    });

    it("the reward: the requester's alone within 30 s (another drawer earns nothing), anyone's after", async function () {
      const { aggregator, hunter, other } = await deploy();
      const early = await request(aggregator, hunter);
      await expect(draw(aggregator, early, other)).to.emit(aggregator, "JuryDrawn").withArgs(early, other.address, 0n);
      expect(await aggregator.ethOwed(other.address)).to.equal(0n);
      const late = await request(aggregator, hunter);
      await time.increase(31);
      await expect(draw(aggregator, late, other)).to.emit(aggregator, "JuryDrawn").withArgs(late, other.address, 2n * CEILING);
    });

    it("DrawExpired a day after the request; then only cancelUnsealed, the whole prepay to the treasury", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await mine(2);
      await aggregator.sealSeed(id);
      await expect(aggregator.cancelUnsealed(id)).to.be.revertedWithCustomError(aggregator, "TooEarly");
      await time.increase(24 * 3600 + 1);
      await expect(aggregator.drawJury(id)).to.be.revertedWithCustomError(aggregator, "DrawExpired");
      await expect(aggregator.settle(id)).to.be.revertedWithCustomError(aggregator, "WrongPhase"); // an undrawn round never times out
      const { received } = await info(aggregator, id);
      await expect(aggregator.cancelUnsealed(id)).to.emit(aggregator, "RoundCancelled").withArgs(id, received);
      expect((await info(aggregator, id)).phase).to.equal(PH.CANCELLED);
      expect(await aggregator.ethOwed(TREASURY)).to.equal(received);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
      expect(await aggregator.isFailed(id)).to.equal(false);
    });

    it("a pool shortage fails the round at the draw and refunds the requester", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await aggregator.setPoolShortage(true);
      await expect(draw(aggregator, id, hunter)).to.emit(aggregator, "EvaluationFailed").withArgs(id, PH.DRAW);
      expect(await aggregator.isFailed(id)).to.equal(true);
      expect(await aggregator.ethOwed(hunter.address)).to.equal((await info(aggregator, id)).received);
    });

    it("with beacons: the first call starts the stage, the second draws once the quorum is in, or fails to the treasury", async function () {
      const { aggregator, hunter } = await deploy();
      const ok = await request(aggregator, hunter, args({ withBeacons: true }));
      await expect(draw(aggregator, ok, hunter)).to.emit(aggregator, "BeaconStageStarted");
      expect((await info(aggregator, ok)).phase).to.equal(PH.BEACON);
      await expect(aggregator.connect(hunter).drawJury(ok)).to.be.revertedWithCustomError(aggregator, "TooEarly");
      await aggregator.scriptBeacons(ok, 2, false);
      await expect(aggregator.connect(hunter).drawJury(ok)).to.emit(aggregator, "JuryDrawn");
      expect((await info(aggregator, ok)).phase).to.equal(PH.COMMIT);

      const missed = await request(aggregator, hunter, args({ withBeacons: true }));
      await draw(aggregator, missed, hunter);
      await aggregator.scriptBeacons(missed, 1, true);
      const owed = await aggregator.ethOwed(hunter.address);
      await expect(aggregator.connect(hunter).drawJury(missed)).to.emit(aggregator, "EvaluationFailed").withArgs(missed, PH.BEACON);
      const r = await info(aggregator, missed);
      expect(r.phase).to.equal(PH.FAILED);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(owed); // no refund
      expect(await aggregator.ethOwed(TREASURY)).to.equal(r.leftover);
    });
  });

  describe("commits, promotion, reveals", function () {
    it("M+ commits close the window; promote from C+2 pays the caller 1 x eff; the N-th reveal finalizes and refunds", async function () {
      const { aggregator, hunter, other } = await deploy();
      const id = await request(aggregator, hunter);
      await draw(aggregator, id, hunter);
      await aggregator.scriptCommits(id, 5); // M+ = 5 + (6 - 5 + 1) / 2 = 6
      expect((await info(aggregator, id)).phase).to.equal(PH.COMMIT);
      await aggregator.scriptCommits(id, 1);
      expect((await info(aggregator, id)).phase).to.equal(PH.CLOSING);
      await expect(aggregator.connect(other).promote(id)).to.be.revertedWithCustomError(aggregator, "TooEarly");
      await mine(1);
      await expect(aggregator.connect(other).promote(id)).to.emit(aggregator, "CommitPhaseComplete").withArgs(id, 5n);
      expect(await aggregator.ethOwed(other.address)).to.equal(CEILING);
      const reveals = [RESULT, RESULT, [0, 0, 0, 0, 0, 1_000_000], [0, 0, 0, 0, 0, 1_000_000]];
      await expect(aggregator.scriptReveals(id, reveals, "QmA,QmB"))
        .to.emit(aggregator, "FulfillAIEvaluation").withArgs(id, [0, 0, 0, 0, 500_000, 500_000], "QmA,QmB");
      const r = await info(aggregator, id);
      expect(r.phase).to.equal(PH.FINAL);
      expect(r.bonuses).to.equal(9n * CEILING);
      expect(r.leftover).to.equal(0n); // 6 base + 9 bonus + 2 draw + 1 promote = 18
      const [scores, valid] = await aggregator.getOutcomeScores(id, 5);
      expect(valid).to.equal(true);
      expect(scores).to.deep.equal([0n, 0n, 1_000_000n, 1_000_000n]);
      expect((await aggregator.getOutcomeScores(id, 6)).valid).to.equal(false);
      await expect(aggregator.settle(id)).to.be.revertedWithCustomError(aggregator, "NotDue");
      await time.increaseTo(r.deadline + 1n);
      await expect(aggregator.settle(id)).to.emit(aggregator, "RoundSettled").withArgs(id, false);
      expect((await aggregator.getEvaluation(id)).valid).to.equal(true);
    });

    it("closeCommits after T+ with at least M commits (WrongPhase before T+ or below M)", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await draw(aggregator, id, hunter);
      await aggregator.scriptCommits(id, 4);
      await expect(aggregator.closeCommits(id)).to.be.revertedWithCustomError(aggregator, "WrongPhase");
      await aggregator.scriptCommits(id, 1);
      await expect(aggregator.closeCommits(id)).to.be.revertedWithCustomError(aggregator, "WrongPhase");
      await time.increaseTo((await info(aggregator, id)).windowEnd + 1n);
      await expect(aggregator.closeCommits(id)).to.emit(aggregator, "CommitWindowClosed");
    });

    it("scriptResult: from any drawn phase before final, N identical reveals (one-number answers too)", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await expect(aggregator.scriptResult(id, RESULT, "QmJ")).to.be.revertedWithCustomError(aggregator, "WrongPhase");
      await draw(aggregator, id, hunter);
      await aggregator.scriptResult(id, [42], "QmJ");
      const [agg, , valid] = await aggregator.getEvaluation(id);
      expect([agg, valid]).to.deep.equal([[42n], true]);
      await expect(aggregator.scriptResult(id, RESULT, "QmJ")).to.be.revertedWithCustomError(aggregator, "WrongPhase");
    });
  });

  describe("settle after the deadline: failed rounds and where the refund goes", function () {
    async function failIn(setup) {
      const f = await deploy();
      const id = await request(f.aggregator, f.hunter);
      await draw(f.aggregator, id, f.hunter);
      await setup(f.aggregator, id);
      await time.increaseTo((await info(f.aggregator, id)).deadline + 1n);
      return { ...f, id };
    }

    it("too few commits (phase 3, below M): failed, the unspent prepay to the requester", async function () {
      const { aggregator, hunter, id } = await failIn((a, i) => a.scriptCommits(i, 4));
      const before = await aggregator.ethOwed(hunter.address);
      const { leftover } = await info(aggregator, id);
      await expect(aggregator.settle(id)).to.emit(aggregator, "EvaluationFailed").withArgs(id, PH.COMMIT)
        .and.to.emit(aggregator, "RoundSettled").withArgs(id, true);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(before + leftover);
      expect(await aggregator.isFailed(id)).to.equal(true);
      expect((await aggregator.getEvaluation(id)).valid).to.equal(false);
    });

    it("M commits never closed, or closed and never promoted: the unspent prepay to the treasury", async function () {
      for (const setup of [(a, i) => a.scriptCommits(i, 5), (a, i) => a.scriptCommits(i, 6)]) {
        const { aggregator, id } = await failIn(setup);
        const { leftover, phase } = await info(aggregator, id);
        await expect(aggregator.settle(id)).to.emit(aggregator, "EvaluationFailed").withArgs(id, phase);
        expect(await aggregator.ethOwed(TREASURY)).to.equal(leftover);
      }
    });

    it("too few reveals (phase 5): failed, the unspent prepay to the requester", async function () {
      const { aggregator, hunter, id } = await failIn(async (a, i) => {
        await a.scriptCommits(i, 6);
        await mine(2);
        await a.promote(i);
      });
      const before = await aggregator.ethOwed(hunter.address);
      const { leftover } = await info(aggregator, id);
      await expect(aggregator.settle(id)).to.emit(aggregator, "EvaluationFailed").withArgs(id, PH.REVEAL);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(before + leftover);
    });

    it("base fees and bonuses go to the arbiters' stand-in payee", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await draw(aggregator, id, hunter);
      await aggregator.scriptResult(id, RESULT, "QmJ");
      expect(await aggregator.ethOwed(ARBITERS)).to.equal(15n * CEILING);
    });
  });

  describe("request gas cost", function () {
    it("setRequestGasCost makes a request spend about that much more gas, and run out of gas without it", async function () {
      const { aggregator, hunter } = await deploy();
      const a = args();
      const required = await aggregator.maxTotalFee(a.maxFee, 0, false, 6, 3);
      const go = (gasLimit) => send(aggregator, hunter, a, required, { gasLimit });
      expect(await aggregator.requestGasCost()).to.equal(0n);
      await (await go(5_000_000n)).wait(); // the first request also writes the counter from zero
      const cheap = (await (await go(5_000_000n)).wait()).gasUsed;
      await aggregator.setRequestGasCost(1_000_000n);
      const costly = (await (await go(5_000_000n)).wait()).gasUsed;
      expect(costly - cheap).to.be.within(990_000n, 1_100_000n); // coverage instruments the search loop
      await expect(go(900_000n)).to.be.reverted; // out of gas, as the real request would
    });
  });
});
