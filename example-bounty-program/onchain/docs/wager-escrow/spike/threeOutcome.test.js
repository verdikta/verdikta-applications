// Spike: does the ETH-funded ReputationAggregator handle a 3-outcome round end to end?
// Runs the real contract source (verdikta-dispatcher/reputationBasedAggregator) with the
// repo's own mocks, at the PRODUCTION polling config K/M/N/P = 6/4/3/2 (read from Base
// mainnet 0xd8F3...142a on 2026-10-20). Local hardhat chain only.
//
// Outcome order used throughout: [NO_WINNER, SIDE_A, SIDE_B].

const { expect } = require("chai");
const { ethers } = require("hardhat");

const abi = ethers.AbiCoder.defaultAbiCoder();
const FEE = 10n ** 13n;
const REQ_MAX_FEE = 2n * 10n ** 13n;
const BASE_COST = 10n ** 13n;
const SCALING = 3n;
const M = 1_000_000n;

function saltHexFor(i) { return (BigInt(i) + 1n).toString(16).padStart(20, "0"); }
function commitResp0(operatorAddr, revealArr, saltBig) {
  const encoded = abi.encode(["address", "uint256[]", "uint256"], [operatorAddr, revealArr, saltBig]);
  return BigInt(ethers.dataSlice(ethers.sha256(encoded), 0, 16));
}

describe("3-outcome round on ReputationAggregator (spike)", function () {
  let deployer, requester, agg, keeper, operators;

  function reqIdsFrom(receipt) {
    const topic = agg.interface.getEvent("ChainlinkRequested").topicHash;
    return receipt.logs.filter((l) => l.topics[0] === topic)
      .map((l) => agg.interface.parseLog({ topics: [...l.topics], data: l.data }).args.id);
  }
  async function slotMap(receipt) {
    const m = {};
    for (const id of reqIdsFrom(receipt)) m[Number(await agg.requestIdToPollIndex(id))] = id;
    return m;
  }

  beforeEach(async () => {
    [deployer, requester] = await ethers.getSigners();
    const lib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
    const link = await (await ethers.getContractFactory("MockLinkToken")).deploy(ethers.parseEther("1000000"));
    keeper = await (await ethers.getContractFactory("MockReputationKeeper")).deploy();
    agg = await (await ethers.getContractFactory("ReputationAggregator", {
      libraries: { AggregatorLib: await lib.getAddress() },
    })).deploy(await link.getAddress(), await keeper.getAddress());
    await (await agg.setConfig(6, 4, 3, 2, 300)).wait();   // production K/M/N/P
    const Op = await ethers.getContractFactory("MockArbiterOperator");
    operators = [];
    for (let i = 0; i < 6; i++) operators.push(await Op.deploy(ethers.Wallet.createRandom().address));
    await (await keeper.setOracles(await Promise.all(operators.map((o) => o.getAddress())), FEE)).wait();
  });

  // reveals: array (per slot 0..3) of score vectors; the first 4 commits move to reveal,
  // the first 3 reveals finalize. Returns the aggregator's getEvaluation result + events.
  async function round(reveals) {
    const required = await agg.maxTotalFee(REQ_MAX_FEE);
    const rcpt = await (await agg.connect(requester).requestAIEvaluationWithApproval(
      ["QmWagerPackage"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 128, { value: required },
    )).wait();
    const aggId = agg.interface.parseLog(rcpt.logs.find(
      (l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash)).args.aggRequestId;
    const commitIds = await slotMap(rcpt);
    let lastCommit;
    for (let s = 0; s < 4; s++) {
      lastCommit = await (await operators[s].callFulfill(await agg.getAddress(), commitIds[s],
        [commitResp0(await operators[s].getAddress(), reveals[s], BigInt("0x" + saltHexFor(s)))], "")).wait();
    }
    const revealIds = await slotMap(lastCommit);
    const logs = [];
    for (let s = 0; s < 3; s++) {
      const r = await (await operators[s].callFulfill(await agg.getAddress(), revealIds[s],
        reveals[s], `QmJustification${s}:${saltHexFor(s)}`)).wait();
      logs.push(...r.logs);
    }
    const [scores, cids, ok] = await agg.getEvaluation(aggId);
    return { aggId, scores: scores.map((x) => x), cids, ok, logs };
  }

  it("unanimous 3-vector -> valid result of length 3", async () => {
    const v = [0n, M, 0n];
    const r = await round([v, v, v, v]);
    expect(r.ok).to.equal(true);
    expect(r.scores).to.deep.equal([0n, M, 0n]);
  });

  it("2 vs 1 split -> the closest pair clusters, the outlier is excluded", async () => {
    const a = [50_000n, 950_000n, 0n];
    const b = [0n, M, 0n];
    const c = [0n, 0n, M];            // dissenting juror says side B
    const r = await round([a, c, b, b]);
    expect(r.ok).to.equal(true);
    // cluster = slots 0 and 2 (a, b); mean = [25000, 975000, 0]
    expect(r.scores).to.deep.equal([25_000n, 975_000n, 0n]);
  });

  it("AI-node fallback vector (one model failed) averages into the result", async () => {
    // ai-node fallback for 3 outcomes: floor(1e6/3) each, remainder to index 0
    const fb = [333_334n, 333_333n, 333_333n];
    const half = fb.map((x, i) => (x + [0n, M, 0n][i]) / 2n); // 2-model jury, one failed
    const r = await round([half, half, [0n, M, 0n], half]);
    expect(r.ok).to.equal(true);
    expect(r.scores.length).to.equal(3);
    expect(r.scores[1] < 700_000n).to.equal(true); // a 1-of-2 model failure caps SIDE_A near 0.67
  });

  it("a 2-length deviant reveal is zero-filled to the modal length 3 and loses on distance", async () => {
    const v = [0n, M, 0n];
    const r = await round([[M, 0n], v, v, v]);
    expect(r.ok).to.equal(true);
    expect(r.scores).to.deep.equal([0n, M, 0n]);
  });
});
