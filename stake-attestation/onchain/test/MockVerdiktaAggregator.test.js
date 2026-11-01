// Tests for the stake-attestation mock aggregator. The mock stands in for the deployed
// ReputationAggregator (verdikta-dispatcher) in every StakeAttestation test, so these tests pin
// it to the real contract's requester-visible behaviour: input limits, fund-from-credit,
// settlement by polling (no requester callback), refunds at settlement and the timeout path.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const MAX_ORACLE_FEE = ethers.parseEther("0.0004");
const DEFAULT_MULTIPLIER = 3n;
// A six-outcome vector, as the stake-attestation classes return.
const RESULT = [0, 0, 0, 0, 1_000_000, 0];

function args(overrides = {}) {
  return {
    cids: [CID],
    addendum: "",
    alpha: 500n,
    maxFee: MAX_ORACLE_FEE,
    baseCost: MAX_ORACLE_FEE / 100n,
    scaling: 5n,
    requestedClass: 133n,
    ...overrides,
  };
}

async function deploy() {
  const [owner, hunter, other] = await ethers.getSigners();
  const Aggregator = await ethers.getContractFactory("MockVerdiktaAggregator");
  const aggregator = await Aggregator.deploy();
  const Requester = await ethers.getContractFactory("MockPollingRequester");
  const requester = await Requester.deploy(await aggregator.getAddress());
  return { owner, hunter, other, aggregator, requester };
}

// Sends a request from an EOA and returns the aggregator request id from the event.
async function request(aggregator, signer, a = args(), value) {
  const required = await aggregator.maxTotalFee(a.maxFee);
  const tx = await aggregator
    .connect(signer)
    .requestAIEvaluationWithApproval(
      a.cids, a.addendum, a.alpha, a.maxFee, a.baseCost, a.scaling, a.requestedClass,
      { value: value === undefined ? required : value }
    );
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return aggregator.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "RequestAIEvaluation");
  return log.args.requestId;
}

describe("Hardhat tooling", function () {
  it("compiles with solc 0.8.23 and loads the gas reporter and solidity-coverage", async function () {
    const versions = hre.config.solidity.compilers.map((c) => c.version);
    expect(versions).to.deep.equal(["0.8.23"]);
    expect(hre.config.gasReporter, "gasReporter config").to.be.an("object");
    expect(hre.tasks, "hardhat-gas-reporter task").to.have.property("gas-reporter:merge");
    expect(hre.tasks, "solidity-coverage task").to.have.property("coverage");
  });

  it("needs no network secrets: the only configured network is the in-process one", async function () {
    const remote = Object.entries(hre.config.networks).filter(
      ([name, cfg]) => name !== "hardhat" && name !== "localhost" && cfg.url && !/127\.0\.0\.1|localhost/.test(cfg.url)
    );
    expect(remote.map(([name]) => name)).to.deep.equal([]);
  });
});

describe("MockVerdiktaAggregator", function () {
  describe("interface", function () {
    it("implements every IVerdiktaAggregator function with the same selector", async function () {
      const iface = (await hre.artifacts.readArtifact("IVerdiktaAggregator")).abi;
      const mock = new ethers.Interface((await hre.artifacts.readArtifact("MockVerdiktaAggregator")).abi);
      for (const fragment of iface.filter((f) => f.type === "function")) {
        const sig = ethers.FunctionFragment.from(fragment).format("sighash");
        expect(mock.getFunction(sig), sig).to.not.equal(null);
      }
    });

    it("has no requester callback: settlement never calls the requester", async function () {
      const { aggregator, requester } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await aggregator.setRefundAmount(required / 2n);

      // The requester counts every call and every wei it did not ask for.
      await requester.request([CID], "", 500, MAX_ORACLE_FEE, 0, 5, 133, { value: required });
      const fulfilled = await requester.lastRequestId();
      await expect(aggregator.scriptResult(fulfilled, RESULT, "QmJustification"))
        .to.emit(aggregator, "FulfillAIEvaluation");

      // A round that times out.
      await requester.request([CID], "", 500, MAX_ORACLE_FEE, 0, 5, 133, { value: required });
      const timedOut = await requester.lastRequestId();
      await time.increase(await aggregator.responseTimeoutSeconds());
      await aggregator.finalizeEvaluationTimeout(timedOut);

      expect(await requester.unexpectedCalls()).to.equal(0n);
      // The requester learns the result only by polling.
      const [scores, cids, exists] = await aggregator.getEvaluation(fulfilled);
      expect(scores.map(Number)).to.deep.equal(RESULT);
      expect(cids).to.equal("QmJustification");
      expect(exists).to.equal(true);
      // Refunds arrive as pull credit, never pushed. The second request drew the first refund
      // (fund-from-credit) on top of its msg.value, and that excess came back with the second
      // round's unspent half.
      expect(await aggregator.ethOwed(await requester.getAddress())).to.equal(required);
      await requester.withdraw();
      expect(await aggregator.ethOwed(await requester.getAddress())).to.equal(0n);
      expect(await requester.unexpectedCalls()).to.equal(0n);
    });

    it("has no receive(): plain ETH is refused, as by the real aggregator", async function () {
      const { aggregator, hunter } = await deploy();
      await expect(hunter.sendTransaction({ to: await aggregator.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("input limits (the real aggregator's constants and errors)", function () {
    it("exposes MAX_CID_COUNT 10, MAX_CID_LENGTH 100, MAX_ADDENDUM_LENGTH 1000", async function () {
      const { aggregator } = await deploy();
      expect(await aggregator.MAX_CID_COUNT()).to.equal(10n);
      expect(await aggregator.MAX_CID_LENGTH()).to.equal(100n);
      expect(await aggregator.MAX_ADDENDUM_LENGTH()).to.equal(1000n);
    });

    it("accepts 10 CIDs and rejects 11 (TooManyCIDs) and none (EmptyCIDList)", async function () {
      const { aggregator, hunter } = await deploy();
      await request(aggregator, hunter, args({ cids: Array(10).fill(CID) }));
      await expect(request(aggregator, hunter, args({ cids: Array(11).fill(CID) })))
        .to.be.revertedWithCustomError(aggregator, "TooManyCIDs");
      await expect(request(aggregator, hunter, args({ cids: [] })))
        .to.be.revertedWithCustomError(aggregator, "EmptyCIDList");
    });

    it("accepts a 100-byte CID and rejects 101 bytes (CIDTooLong)", async function () {
      const { aggregator, hunter } = await deploy();
      await request(aggregator, hunter, args({ cids: [CID, "b".repeat(100)] }));
      await expect(request(aggregator, hunter, args({ cids: [CID, "b".repeat(101)] })))
        .to.be.revertedWithCustomError(aggregator, "CIDTooLong");
    });

    it("accepts a 1000-byte addendum and rejects 1001 bytes (AddendumTooLong)", async function () {
      const { aggregator, hunter } = await deploy();
      await request(aggregator, hunter, args({ addendum: "a".repeat(1000) }));
      await expect(request(aggregator, hunter, args({ addendum: "a".repeat(1001) })))
        .to.be.revertedWithCustomError(aggregator, "AddendumTooLong");
    });

    it("rejects alpha above 1000 as the keeper's scoring does (panic 0x11), opening no round", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      // Credit to show a rejected request draws none of it.
      await aggregator.setRefundAmount(required);
      await aggregator.scriptResult(await request(aggregator, hunter), RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);

      await expect(request(aggregator, hunter, args({ alpha: 1001n }), 0n))
        .to.be.revertedWithPanic(0x11);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);
      await request(aggregator, hunter, args({ alpha: 1000n }), 0n);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
    });

    it("applies the keeper's selection checks on base cost and scaling factor", async function () {
      const { aggregator, hunter } = await deploy();
      await expect(request(aggregator, hunter, args({ baseCost: MAX_ORACLE_FEE })))
        .to.be.revertedWith("Base cost must be less than max fee");
      await expect(request(aggregator, hunter, args({ scaling: 0n })))
        .to.be.revertedWith("Max scaling factor must be at least 1");
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
      const id = await request(aggregator, hunter, args({ cids: [CID, "QmClaim"], addendum: "line" }));
      expect(await aggregator.getRequestCids(id)).to.deep.equal([CID, "QmClaim"]);
      const p = await aggregator.requestParams(id);
      expect(p.addendum).to.equal("line");
      expect(p.alpha).to.equal(500n);
      expect(p.maxFee).to.equal(MAX_ORACLE_FEE);
      expect(p.requestedClass).to.equal(133n);
    });
  });

  describe("fees and fund-from-credit", function () {
    it("prices maxTotalFee as the clamped fee times a settable multiplier", async function () {
      const { aggregator } = await deploy();
      expect(await aggregator.feeMultiplier()).to.equal(DEFAULT_MULTIPLIER);
      expect(await aggregator.maxTotalFee(MAX_ORACLE_FEE * 10n)).to.equal(MAX_ORACLE_FEE * DEFAULT_MULTIPLIER);
      await aggregator.setFeeMultiplier(7);
      expect(await aggregator.maxTotalFee(1000n)).to.equal(7000n);
      await aggregator.setMaxOracleFee(500n);
      expect(await aggregator.maxTotalFee(1000n)).to.equal(3500n);
    });

    it("rejects a request paying less than maxTotalFee (InsufficientPayment)", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await expect(request(aggregator, hunter, args(), required - 1n))
        .to.be.revertedWithCustomError(aggregator, "InsufficientPayment");
    });

    it("draws the caller's ethOwed credit before msg.value", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      const credit = required / 3n;
      await aggregator.setRefundAmount(credit);
      const first = await request(aggregator, hunter);
      await aggregator.scriptResult(first, RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(credit);

      // Credit covers part: msg.value pays the rest, credit goes to zero.
      await aggregator.setRefundAmount(0);
      const a = args();
      await expect(
        aggregator.connect(hunter).requestAIEvaluationWithApproval(
          a.cids, a.addendum, a.alpha, a.maxFee, a.baseCost, a.scaling, a.requestedClass,
          { value: required - credit }
        )
      ).to.emit(aggregator, "RequestFunded").withArgs(anyValue, hunter.address, credit, required - credit);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
      // One wei short of the remainder fails once the credit is gone.
      await expect(request(aggregator, hunter, args(), required - 1n))
        .to.be.revertedWithCustomError(aggregator, "InsufficientPayment");
    });

    it("lets credit alone fund a request, keeping the surplus as credit", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      // Fund 3x the requirement and refund all of it: credit = 3x.
      const first = await request(aggregator, hunter, args(), required * 3n);
      await aggregator.setRefundAmount(required * 3n);
      await aggregator.scriptResult(first, RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required * 3n);

      await aggregator.setRefundAmount(0);
      await request(aggregator, hunter, args(), 0n);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required * 2n);
    });

    it("draws credit even when msg.value alone would cover the request; the excess is refunded at settlement", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      const first = await request(aggregator, hunter);
      await aggregator.setRefundAmount(required);
      await aggregator.scriptResult(first, RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);

      // The oracles spend the whole worst case; the overfunding still comes back.
      await aggregator.setRefundAmount(0);
      const id = await request(aggregator, hunter, args(), required);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
      expect(await aggregator.ethReceived(id)).to.equal(required * 2n);
      await expect(aggregator.scriptResult(id, RESULT, "QmJ"))
        .to.emit(aggregator, "RequesterRefunded").withArgs(id, hunter.address, required);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);
    });

    it("refunds msg.value above maxTotalFee even when the round spends its whole worst case", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      expect(await aggregator.refundAmount()).to.equal(0n);
      const fulfilled = await request(aggregator, hunter, args(), required * 2n);
      await aggregator.scriptResult(fulfilled, RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);

      // On the timeout path too. The request draws the credit first, then the overpaid value.
      const timedOut = await request(aggregator, hunter, args(), required + 7n);
      expect(await aggregator.ethReceived(timedOut)).to.equal(required * 2n + 7n);
      await time.increase(300);
      await aggregator.finalizeEvaluationTimeout(timedOut);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required + 7n);
    });

    it("withdrawEth pays the caller's credit and reverts NothingOwed on zero", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await aggregator.setRefundAmount(required);
      const id = await request(aggregator, hunter);
      await aggregator.scriptResult(id, RESULT, "QmJ");
      await expect(aggregator.connect(hunter).withdrawEth()).to.changeEtherBalances(
        [hunter, aggregator], [required, -required]
      );
      await expect(aggregator.connect(hunter).withdrawEth())
        .to.be.revertedWithCustomError(aggregator, "NothingOwed");
    });
  });

  describe("scripted results", function () {
    it("a scripted result completes the round; getEvaluation and getAggregationStatus report it", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      let status = await aggregator.getAggregationStatus(id);
      expect(status.isComplete).to.equal(false);
      expect(status.requester).to.equal(hunter.address);
      expect((await aggregator.getEvaluation(id))[2]).to.equal(false);

      const vector = [0, 0, 100_000, 300_000, 400_000, 200_000];
      await expect(aggregator.scriptResult(id, vector, "QmA,QmB"))
        .to.emit(aggregator, "FulfillAIEvaluation").withArgs(id, vector, "QmA,QmB");
      const [scores, cids, exists] = await aggregator.getEvaluation(id);
      expect(scores.map(Number)).to.deep.equal(vector);
      expect(cids).to.equal("QmA,QmB");
      expect(exists).to.equal(true);
      status = await aggregator.getAggregationStatus(id);
      expect(status.isComplete).to.equal(true);
      expect(status.failed).to.equal(false);
    });

    it("scripts any vector, including malformed ones a requester must treat as failed", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      // Five components summing short of 1,000,000: delivered as-is.
      await aggregator.scriptResult(id, [1, 2, 3, 4, 5], "QmJ");
      const [scores, , exists] = await aggregator.getEvaluation(id);
      expect(scores.map(Number)).to.deep.equal([1, 2, 3, 4, 5]);
      expect(exists).to.equal(true);
    });

    it("only scripts vector lengths a real round can produce (2..maxLikelihoodLength)", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await expect(aggregator.scriptResult(id, [1_000_000], "QmJ"))
        .to.be.revertedWithCustomError(aggregator, "UnreachableResult").withArgs(1);
      await expect(aggregator.scriptLateResult(id, Array(21).fill(1), "QmJ"))
        .to.be.revertedWithCustomError(aggregator, "UnreachableResult").withArgs(21);
      await aggregator.scriptResult(id, Array(20).fill(50_000), "QmJ");
    });

    it("rejects scripting an unknown or already settled round", async function () {
      const { aggregator, hunter } = await deploy();
      await expect(aggregator.scriptResult(ethers.ZeroHash, RESULT, "QmJ"))
        .to.be.revertedWithCustomError(aggregator, "UnknownRequest");
      const id = await request(aggregator, hunter);
      await aggregator.scriptResult(id, RESULT, "QmJ");
      await expect(aggregator.scriptResult(id, RESULT, "QmJ"))
        .to.be.revertedWithCustomError(aggregator, "AggregationComplete");
    });

    it("refunds ethReceived minus the round's spend to the requester at settlement, not before", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await aggregator.setRefundAmount(required / 4n);
      const id = await request(aggregator, hunter);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(0n);
      await expect(aggregator.scriptResult(id, RESULT, "QmJ"))
        .to.emit(aggregator, "RequesterRefunded").withArgs(id, hunter.address, required / 4n);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required / 4n);
    });

    it("never refunds more than the round received", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await aggregator.setRefundAmount(required * 10n);
      const id = await request(aggregator, hunter);
      await aggregator.scriptResult(id, RESULT, "QmJ");
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);
    });
  });

  describe("timeouts", function () {
    it("finalizeEvaluationTimeout: UnknownRequest, NotTimedOut, then a failed round", async function () {
      const { aggregator, hunter, other } = await deploy();
      await expect(aggregator.finalizeEvaluationTimeout(ethers.ZeroHash))
        .to.be.revertedWithCustomError(aggregator, "UnknownRequest");
      const id = await request(aggregator, hunter);
      const timeout = await aggregator.responseTimeoutSeconds();
      expect(timeout).to.equal(300n);
      await time.increase(timeout - 5n);
      await expect(aggregator.finalizeEvaluationTimeout(id))
        .to.be.revertedWithCustomError(aggregator, "NotTimedOut");
      await time.increase(5n);
      // Anyone may finalize a timed-out round.
      await expect(aggregator.connect(other).finalizeEvaluationTimeout(id))
        .to.emit(aggregator, "EvaluationTimedOut").withArgs(id)
        .and.to.emit(aggregator, "EvaluationFailed").withArgs(id, "commit");
      const status = await aggregator.getAggregationStatus(id);
      expect(status.isComplete).to.equal(true);
      expect(status.failed).to.equal(true);
      expect((await aggregator.getEvaluation(id))[2]).to.equal(false);
      await expect(aggregator.finalizeEvaluationTimeout(id))
        .to.be.revertedWithCustomError(aggregator, "AggregationComplete");
      await expect(aggregator.scriptResult(id, RESULT, "QmJ"))
        .to.be.revertedWithCustomError(aggregator, "AggregationComplete");
    });

    it("refunds at timeout settlement", async function () {
      const { aggregator, hunter } = await deploy();
      const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
      await aggregator.setRefundAmount(required);
      const id = await request(aggregator, hunter);
      await time.increase(300);
      await aggregator.finalizeEvaluationTimeout(id);
      expect(await aggregator.ethOwed(hunter.address)).to.equal(required);
    });

    it("a staged late result settles valid at timeout (enough reveals after all)", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await aggregator.scriptLateResult(id, [0, 0, 0, 0, 1_000_000, 0], "QmLate");
      const before = await aggregator.getAggregationStatus(id);
      expect(before.isComplete).to.equal(false);
      expect(before.commitPhaseComplete).to.equal(true);
      await time.increase(300);
      await expect(aggregator.finalizeEvaluationTimeout(id)).to.emit(aggregator, "FulfillAIEvaluation");
      const [scores, cids, exists] = await aggregator.getEvaluation(id);
      expect(scores.map(Number)).to.deep.equal([0, 0, 0, 0, 1_000_000, 0]);
      expect(cids).to.equal("QmLate");
      expect(exists).to.equal(true);
      expect((await aggregator.getAggregationStatus(id)).failed).to.equal(false);
    });

    it("a result may still arrive after the timeout until someone finalizes it", async function () {
      const { aggregator, hunter } = await deploy();
      const id = await request(aggregator, hunter);
      await time.increase(1000);
      await aggregator.scriptResult(id, RESULT, "QmJ");
      expect((await aggregator.getEvaluation(id))[2]).to.equal(true);
    });

    it("the response timeout is settable (the design raises it to 900 s)", async function () {
      const { aggregator, hunter } = await deploy();
      await aggregator.setResponseTimeout(900);
      const id = await request(aggregator, hunter);
      const start = (await aggregator.getAggregationStatus(id)).startTimestamp;
      await time.setNextBlockTimestamp(start + 899n);
      await expect(aggregator.finalizeEvaluationTimeout(id))
        .to.be.revertedWithCustomError(aggregator, "NotTimedOut");
      await time.setNextBlockTimestamp(start + 900n);
      await aggregator.finalizeEvaluationTimeout(id);
    });
  });
});
