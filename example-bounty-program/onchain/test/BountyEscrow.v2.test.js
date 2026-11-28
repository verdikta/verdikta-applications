// BountyEscrow on the v2 aggregator (verdikta-dispatcher `beacon` branch): the draw through the
// submission's wallet, the creator's jury / fee floor / beacon settings, and TODO item 12's decision
// rule — pass at Q of N, hard fail below R (the hunter bond goes to the creator), and re-runs for a
// soft fail or a round with no result. BountyEscrow.test.js keeps the v1 suite running on the v2 mock
// with v1's rule (Q = R = 1, no bond); this file covers what v2 adds.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { mergedAbi } = require("../deploy/helpers");

describe("BountyEscrow v2 (draw, Q-of-N, bond, re-runs, juries)", function () {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkCid(label) {
    let out = "Qm";
    let h = 11;
    for (let i = 0; out.length < 46; i++) {
      h = (h * 31 + (label.charCodeAt(i % label.length) || 0) + i) >>> 0;
      out += B58[h % B58.length];
    }
    return out;
  }
  const EVAL_CID = mkCid("eval-v2");
  const HUNTER_CID = mkCid("hunter-v2");
  const BOUNTY = ethers.parseEther("1");
  const FEE = ethers.parseEther("0.00002");
  const BOND = ethers.parseEther("0.005");
  const THRESHOLD = 70;
  const JUST = "QmJustificationV2";
  const HOUR = 3600;
  // scores for one arbiter: [DONT_FUND, FUND]
  const yes = (fund = 900_000n) => [1_000_000n - fund, fund];
  const no = (fund = 400_000n) => [1_000_000n - fund, fund];
  // Juries (CreateParams.jury): the Small class preset, and a bigger one. One aggregator runs both.
  const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
  const LARGE = { K: 10, M: 8, N: 7, P: 4, timeout: 600 };

  async function fixture() {
    const [owner, creator, hunter, hunter2, other] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockVerdiktaAggregator");
    const agg = await Mock.deploy();                          // one aggregator for every jury
    const Escrow = await ethers.getContractFactory("BountyEscrow");
    const deployed = await Escrow.deploy(await agg.getAddress());
    const escrow = new ethers.Contract(await deployed.getAddress(), mergedAbi(), owner);
    return { escrow, agg, owner, creator, hunter, hunter2, other };
  }

  // A bounty with item 12's rule. Defaults: the Small jury (N = 4), Q = 3, R = 2, a bond.
  async function createBounty(f, o = {}) {
    const deadline = o.deadline ?? (await time.latest()) + 7 * 24 * HOUR;
    const p = {
      evaluationCid: EVAL_CID,
      requestedClass: 128,
      threshold: o.threshold ?? THRESHOLD,
      submissionDeadline: deadline,
      targetHunter: ethers.ZeroAddress,
      creatorDeterminationPayment: BOUNTY,
      arbiterDeterminationPayment: BOUNTY,
      creatorAssessmentWindowSize: o.windowSize ?? 0,
      oracle: {
        maxOracleFee: o.maxOracleFee ?? FEE,
        alpha: 500,
        estimatedBaseCost: 0,
        maxFeeBasedScaling: 1,
        minOracleFee: o.minOracleFee ?? 0n,
        withBeacons: o.withBeacons ?? false,
      },
      jury: o.jury ?? SMALL,
      quota: o.quota ?? 3,
      forfeitLine: o.forfeitLine ?? 2,
      bond: o.bond ?? BOND,
      outcomes: o.outcomes ?? 2,
    };
    if (o.windowSize) p.creatorDeterminationPayment = p.arbiterDeterminationPayment = BOUNTY;
    const rc = await (await f.escrow.connect(f.creator).createBounty(p, { value: BOUNTY })).wait();
    const ev = rc.logs.find((l) => l.fragment && l.fragment.name === "BountyCreated");
    return { bountyId: ev.args.bountyId, deadline, params: p };
  }

  async function prepare(f, bountyId, who = f.hunter, cid = HUNTER_CID) {
    const rc = await (await f.escrow.connect(who).prepareSubmission(bountyId, EVAL_CID, cid)).wait();
    const ev = rc.logs.find((l) => l.fragment && l.fragment.name === "SubmissionPrepared");
    return { submissionId: ev.args.submissionId, wallet: ev.args.evalWallet };
  }

  async function start(f, bountyId, submissionId, who = f.hunter) {
    const value = await f.escrow.startValue(bountyId);
    await f.escrow.connect(who).startPreparedSubmission(bountyId, submissionId, { value });
    return (await f.escrow.getSubmission(bountyId, submissionId)).verdiktaAggId;
  }

  async function submit(f, bountyId, who = f.hunter) {
    const p = await prepare(f, bountyId, who);
    const aggId = await start(f, bountyId, p.submissionId, who);
    return { ...p, aggId };
  }

  const aggOf = async (f) => ethers.getContractAt("MockVerdiktaAggregator", await f.escrow.aggregator());
  const phase = async (agg, aggId) => (await agg.getRoundInfo(aggId))[0];

  // Drive a round to its reveals the way arbiters would: draw (through the escrow), M+ commits
  // (closes the window), promote at C+2, then the N reveals given.
  async function runRound(f, bountyId, submissionId, reveals) {
    const agg = await aggOf(f, bountyId);
    const aggId = (await f.escrow.getSubmission(bountyId, submissionId)).verdiktaAggId;
    if ((await phase(agg, aggId)) === 1n) {
      await mine(2);
      await f.escrow.connect(f.other).drawJury(bountyId, submissionId);
    }
    const [K, M] = (await agg.getJury(aggId)).map(Number);
    const mPlus = M + Math.ceil((K - M) / 2);
    await agg.scriptCommits(aggId, mPlus);
    await mine(2);
    await agg.connect(f.other).promote(aggId);
    await agg.scriptReveals(aggId, reveals, JUST);
    return aggId;
  }
  // N reveals with `passing` of them at FUND 0.9 and the rest at 0.4 (threshold 70)
  const mix = (n, passing) => Array.from({ length: n }, (_, i) => (i < passing ? yes() : no()));

  describe("creation: the creator's jury, rule and money", function () {
    it("stores the jury, Q, R, bond, fee floor and beacon flag, and quotes prepay + bond", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { jury: LARGE, quota: 5, forfeitLine: 3, minOracleFee: FEE * 2n, withBeacons: true });
      const b = await f.escrow.getBounty(bountyId);
      expect([b.juryK, b.juryM, b.juryN, b.juryP, b.juryTimeout]).to.deep.equal([10n, 8n, 7n, 4n, 600n]);
      expect([b.quota, b.forfeitLine, b.bond]).to.deep.equal([5n, 3n, BOND]);
      expect(b.oracle.minOracleFee).to.equal(FEE * 2n);
      expect(b.oracle.withBeacons).to.equal(true);
      expect(await f.escrow.aggregator()).to.equal(await f.agg.getAddress());
      const prepay = await f.agg.maxTotalFee(FEE, FEE * 2n, true, LARGE.K, LARGE.P);
      expect(await f.escrow.requiredPrepay(bountyId)).to.equal(prepay);
      expect(await f.escrow.startValue(bountyId)).to.equal(prepay + BOND);
    });

    for (const [label, o, reason] of [
      ["a jury with M above K", { jury: { ...SMALL, K: 4 } }, "bad jury"],
      ["a jury with N above M", { jury: { ...SMALL, N: 6 } }, "bad jury"],
      ["a jury with P above N", { jury: { ...SMALL, P: 5 } }, "bad jury"],
      ["a jury with P = 0", { jury: { ...SMALL, P: 0 } }, "bad jury"],
      ["a jury with P = 1 and N > 1", { jury: { ...SMALL, P: 1 }, quota: 1, forfeitLine: 1 }, "bad jury"],
      ["a jury with N above 40", { jury: { K: 50, M: 45, N: 41, P: 17, timeout: 600 } }, "bad jury"],
      // review 2026-11-28: more than half of the seats must be promoted (2M > K), as the aggregator requires
      ["a jury that promotes half of its seats or fewer (K 12, M 6)", { jury: { K: 12, M: 6, N: 4, P: 3, timeout: 300 } }, "bad jury"],
      ["a jury of many seats and M = 2", { jury: { K: 50, M: 2, N: 2, P: 2, timeout: 300 }, quota: 2, forfeitLine: 1 }, "bad jury"],
      ["Q = 0", { quota: 0, forfeitLine: 0 }, "bad quota"],
      ["R above Q", { quota: 2, forfeitLine: 3 }, "bad quota"],
      ["Q above the jury's N", { quota: 5, forfeitLine: 1 }, "bad quota"],
      ["a fee floor above uint96", { minOracleFee: 1n << 96n }, "bad fee floor"],
      ["a bond above uint96", { bond: 1n << 96n }, "bad bond"],
    ]) {
      it(`rejects ${label}`, async function () {
        const f = await loadFixture(fixture);
        await expect(createBounty(f, o)).to.be.revertedWith(reason);
      });
    }

    it("rejects beacons on an aggregator without a beacon contract (its quote reverts)", async function () {
      const f = await loadFixture(fixture);
      await f.agg.setBeacons(false, 2);
      await expect(createBounty(f, { withBeacons: true })).to.be.reverted;
      await createBounty(f, { withBeacons: false });
    });

    it("a bondless bounty (bond 0) starts with the prepay alone", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { bond: 0n });
      expect(await f.escrow.startValue(bountyId)).to.equal(await f.escrow.requiredPrepay(bountyId));
      await submit(f, bountyId);
    });
  });

  describe("start and draw", function () {
    it("start takes exactly prepay + bond and holds the bond; the wallet is the requester", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, wallet } = await prepare(f, bountyId);
      const prepay = await f.escrow.requiredPrepay(bountyId);
      await expect(f.escrow.connect(f.hunter).startPreparedSubmission(bountyId, submissionId, { value: prepay }))
        .to.be.revertedWith("wrong eth amount");
      await expect(f.escrow.connect(f.hunter).startPreparedSubmission(bountyId, submissionId, { value: prepay + BOND + 1n }))
        .to.be.revertedWith("wrong eth amount");
      const aggId = await start(f, bountyId, submissionId);
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.bondHeld, s.bondFunder, s.rounds]).to.deep.equal([BOND, f.hunter.address, 1n]);
      expect(await f.agg.requesterOf(aggId)).to.equal(wallet);
      expect(await ethers.provider.getBalance(await f.escrow.getAddress())).to.equal(BOUNTY + BOND);
    });

    it("anyone draws through the escrow; the wallet earns the draw reward, refunded to the funder at the end", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, aggId, wallet } = await submit(f, bountyId);
      await expect(f.escrow.connect(f.other).drawJury(bountyId, submissionId))
        .to.be.revertedWithCustomError(f.agg, "TooEarly");                 // block B+1
      await mine(1);
      await expect(f.escrow.connect(f.other).drawJury(bountyId, submissionId))
        .to.emit(f.agg, "JuryDrawn").withArgs(aggId, wallet, FEE * 2n);
      expect(await f.agg.ethOwed(wallet)).to.equal(FEE * 2n);
      await expect(f.escrow.drawJury(bountyId, submissionId)).to.be.revertedWithCustomError(f.agg, "WrongPhase");

      await runRound(f, bountyId, submissionId, mix(4, 4));
      const before = await ethers.provider.getBalance(f.hunter.address);
      const i = await f.agg.getRoundInfo(aggId);
      const refund = i[4] - i[5] - i[6] - i[7];                                // the promote reward went to `other`
      await f.escrow.finalizeSubmission(bountyId, submissionId);
      // bounty + bond + this round's refund + the draw reward, all to the hunter
      expect((await ethers.provider.getBalance(f.hunter.address)) - before).to.equal(BOUNTY + BOND + refund + FEE * 2n);
    });

    it("refuses a draw of a submission that is not in evaluation", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await prepare(f, bountyId);
      await expect(f.escrow.drawJury(bountyId, submissionId)).to.be.revertedWith("not pending");
    });

    it("a jury the aggregator's live limits refuse (K above maxJury) reverts at start, BadJury", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { jury: LARGE });
      const { submissionId } = await prepare(f, bountyId);
      await f.agg.setLimits(8, 3600);                                       // the owner lowers maxJury below K = 10
      const value = await f.escrow.startValue(bountyId);
      await expect(f.escrow.connect(f.hunter).startPreparedSubmission(bountyId, submissionId, { value }))
        .to.be.revertedWithCustomError(f.agg, "BadJury");
    });
  });

  describe("the Q-of-N rule (item 12) and the bond", function () {
    it("pass: Q of N scores at the threshold pays the bounty and returns the bond", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await submit(f, bountyId);
      await runRound(f, bountyId, submissionId, mix(4, 3));                 // 3 of 4 >= 70: Q = 3
      await expect(f.escrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(f.escrow, "PayoutSent").withArgs(bountyId, f.hunter.address, BOUNTY)
        .and.to.emit(f.escrow, "BondReturned").withArgs(bountyId, submissionId, f.hunter.address, BOND);
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.passCount, s.bondHeld]).to.deep.equal([3n, 3n, 0n]);
    });

    it("the cluster mean does not decide: 3 strong passes and 1 low still pass; a high mean with 2 passes does not", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const a = await submit(f, bountyId);
      // mean FUND = (3 x 0.71 + 0.1) / 4 = 0.56, below the threshold, but 3 arbiters are at 71
      await runRound(f, bountyId, a.submissionId, [yes(710_000n), yes(710_000n), yes(710_000n), no(100_000n)]);
      expect((await f.escrow.getOracleResult(bountyId, a.submissionId)).outcome).to.equal(2);   // pass
      const { bountyId: b2 } = await createBounty(f);
      const c = await submit(f, b2, f.hunter2);
      // mean FUND = 0.8, but only 2 arbiters reach the threshold
      await runRound(f, b2, c.submissionId, [yes(1_000_000n), yes(1_000_000n), no(600_000n), no(600_000n)]);
      expect((await f.escrow.getOracleResult(b2, c.submissionId)).outcome).to.equal(3);         // soft fail
    });

    it("hard fail: fewer than R at the threshold fails the submission and forfeits the bond to the creator", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await submit(f, bountyId);
      await runRound(f, bountyId, submissionId, mix(4, 1));                 // 1 < R = 2
      const cb = await ethers.provider.getBalance(f.creator.address);
      await expect(f.escrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(f.escrow, "BondForfeited").withArgs(bountyId, submissionId, f.creator.address, BOND)
        .and.to.emit(f.escrow, "SubmissionFinalized");
      expect((await ethers.provider.getBalance(f.creator.address)) - cb).to.equal(BOND);
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.passCount, s.bondHeld]).to.deep.equal([2n, 1n, 0n]);
      expect(await f.escrow.pendingSubmissionIds(bountyId)).to.deep.equal([]);
    });

    it("soft fail: R..Q-1 at the threshold awaits a re-run, keeping the bond and the place", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await submit(f, bountyId);
      await runRound(f, bountyId, submissionId, mix(4, 2));                 // R = 2 <= 2 < Q = 3
      const tx = f.escrow.finalizeSubmission(bountyId, submissionId);
      const until = BigInt(await time.latest()) + 1n + 2n * BigInt(HOUR);
      await expect(tx).to.emit(f.escrow, "RerunAwaited").withArgs(bountyId, submissionId, 1, 2, false, until);
      await expect(tx).to.not.emit(f.escrow, "BondReturned");
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.passCount, s.bondHeld, s.rerunDeadline]).to.deep.equal([6n, 2n, BOND, until]);
      expect(await f.escrow.pendingSubmissionIds(bountyId)).to.deep.equal([submissionId]);
      expect(await f.escrow.activeEvaluations(bountyId)).to.equal(0);
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("RERUN");
    });

    it("a creator can't approve a later submission while an earlier one awaits a re-run", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { windowSize: HOUR });
      const a = await prepare(f, bountyId);
      await time.increase(HOUR + 1);
      await start(f, bountyId, a.submissionId);
      await runRound(f, bountyId, a.submissionId, mix(4, 2));
      await f.escrow.finalizeSubmission(bountyId, a.submissionId);       // soft fail: AwaitingRerun
      const c = await prepare(f, bountyId, f.hunter2, mkCid("c"));       // in its creator window
      await expect(f.escrow.connect(f.creator).creatorApproveSubmission(bountyId, c.submissionId))
        .to.be.revertedWith("earlier submission unresolved");
    });
  });

  describe("reveals of mixed length, as the real aggregator reads them", function () {
    // The real aggregator accepts any valid length, gives the result the most common one (ties: the
    // longer) and returns each reveal as sent from getOutcomeScores (0 for an outcome it lacks).
    it("one one-number reveal among two-outcome reveals is read at FUND index 1, where it scores 0", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await submit(f, bountyId);
      const aggId = await runRound(f, bountyId, submissionId, [yes(), yes(), yes(), [900_000n]]);
      const agg = await aggOf(f, bountyId);
      expect((await agg.getEvaluation(aggId))[0]).to.have.length(2);
      expect((await agg.getOutcomeScores(aggId, 1))[0]).to.deep.equal([900_000n, 900_000n, 900_000n, 0n]);
      await f.escrow.finalizeSubmission(bountyId, submissionId);
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.passCount]).to.deep.equal([3n, 3n]);                // 3 of 4: a pass
    });

    it("a tie between lengths keeps two outcomes, so the one-number reveals score 0 at FUND", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId } = await submit(f, bountyId);
      const aggId = await runRound(f, bountyId, submissionId, [yes(), yes(), [900_000n], [900_000n]]);
      const agg = await aggOf(f, bountyId);
      expect((await agg.getEvaluation(aggId))[0]).to.have.length(2);
      expect((await agg.getOutcomeScores(aggId, 1))[0]).to.deep.equal([900_000n, 900_000n, 0n, 0n]);
      expect((await f.escrow.getOracleResult(bountyId, submissionId)).outcome).to.equal(3);   // 2 of 4: soft fail
    });
  });

  describe("security review: the result's shape is the bounty's, not the jurors'", function () {
    // Bounty packages have two outcomes [DONT_FUND, FUND]. A one-number result exists only if most
    // counted jurors reveal one number; reading it as [FUND] would read every other juror's DONT_FUND
    // as its FUND, so a majority below Q could pass work the rest reject. It is no result instead.
    it("a majority of one-number reveals below Q cannot pass work the others reject: no result, re-run", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { jury: LARGE, quota: 5, forfeitLine: 3 });   // N = 7, Q = 5
      const { submissionId } = await submit(f, bountyId);
      const reject = [900_000n, 100_000n];                                    // DONT_FUND 0.9, FUND 0.1
      const aggId = await runRound(f, bountyId, submissionId,
        [[1_000_000n], [1_000_000n], [1_000_000n], [1_000_000n], reject, reject, reject]);   // 4 of 7 collude
      expect((await f.agg.getEvaluation(aggId))[0]).to.have.length(1);       // the majority's length
      expect((await f.escrow.getOracleResult(bountyId, submissionId)).outcome).to.equal(1);   // no result
      await f.escrow.connect(f.other).finalizeSubmission(bountyId, submissionId);
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.passCount, s.bondHeld]).to.deep.equal([6n, 0n, BOND]);   // AwaitingRerun
      expect((await f.escrow.getBounty(bountyId)).status).to.equal(0n);       // still Open, not awarded
    });

    it("a jury the aggregator refuses after creation strands nothing: the bond returns, the bounty closes", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, deadline } = await createBounty(f, { jury: LARGE, quota: 5, forfeitLine: 3 });
      const { submissionId } = await submit(f, bountyId);
      await runRound(f, bountyId, submissionId, mix(7, 4));                 // soft fail
      await f.escrow.finalizeSubmission(bountyId, submissionId);
      await f.agg.setLimits(8, 3600);                                       // the owner lowers maxJury below K = 10
      await expect(f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId,
        { value: await f.escrow.requiredPrepay(bountyId) })).to.be.revertedWithCustomError(f.agg, "BadJury");
      await time.increase(2 * HOUR + 1);
      await expect(f.escrow.connect(f.other).expireRerun(bountyId, submissionId))
        .to.emit(f.escrow, "BondReturned").withArgs(bountyId, submissionId, f.hunter.address, BOND);
      await time.increaseTo(deadline);
      await expect(f.escrow.connect(f.other).closeExpiredBounty(bountyId))
        .to.emit(f.escrow, "BountyClosed").withArgs(bountyId, f.creator.address, BOUNTY);
    });
  });

  describe("the mock follows the real deadline", function () {
    it("no result can be scripted after the round's deadline: it only settles, failed, and closes as no result", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, aggId } = await submit(f, bountyId);
      const agg = await aggOf(f, bountyId);
      await mine(2);
      await f.escrow.connect(f.other).drawJury(bountyId, submissionId);
      const deadline = (await agg.getRoundInfo(aggId)).deadline;
      await time.increaseTo(deadline + 1n);
      await expect(agg.scriptResult(aggId, yes(), JUST)).to.be.revertedWithCustomError(agg, "WrongPhase");
      await f.escrow.connect(f.other).closeFailedRound(bountyId, submissionId);
      expect((await f.escrow.getSubmission(bountyId, submissionId)).status).to.equal(6n);    // AwaitingRerun
    });
  });

  describe("re-runs", function () {
    async function softFailed(f, o = {}) {
      const { bountyId, deadline } = await createBounty(f, o);
      const s = await submit(f, bountyId);
      await runRound(f, bountyId, s.submissionId, mix(4, 2));
      await f.escrow.finalizeSubmission(bountyId, s.submissionId);
      return { bountyId, deadline, ...s };
    }

    it("the hunter re-runs with a fresh prepay: a new round from the same wallet, same index and bond", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, submissionId, aggId, wallet } = await softFailed(f);
      const prepay = await f.escrow.requiredPrepay(bountyId);
      await expect(f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value: prepay + BOND }))
        .to.be.revertedWith("wrong eth amount");                              // the bond is already held
      await expect(f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value: prepay }))
        .to.emit(f.escrow, "WorkSubmitted");
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect(s.status).to.equal(1);
      expect(s.rounds).to.equal(2);
      expect(s.bondHeld).to.equal(BOND);
      expect(s.verdiktaAggId).to.not.equal(aggId);
      expect(await f.agg.requesterOf(s.verdiktaAggId)).to.equal(wallet);
      expect(await f.escrow.activeEvaluations(bountyId)).to.equal(1);
      // the second round passes
      await runRound(f, bountyId, submissionId, mix(4, 4));
      await expect(f.escrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(f.escrow, "PayoutSent").and.to.emit(f.escrow, "BondReturned");
    });

    it("only the hunter or the bond's funder may re-run, within the 2-hour window", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, submissionId } = await softFailed(f);
      const prepay = await f.escrow.requiredPrepay(bountyId);
      await expect(f.escrow.connect(f.other).rerunSubmission(bountyId, submissionId, { value: prepay }))
        .to.be.revertedWith("only hunter or funder");
      await time.increase(2 * HOUR + 1);
      await expect(f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value: prepay }))
        .to.be.revertedWith("rerun window closed");
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("EXPIRE_RERUN");
    });

    it("expireRerun: anyone, once the window has closed; the bond goes back, the place is freed", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, submissionId } = await softFailed(f);
      await expect(f.escrow.connect(f.other).expireRerun(bountyId, submissionId)).to.be.revertedWith("rerun window open");
      await time.increase(2 * HOUR + 1);
      await expect(f.escrow.connect(f.other).expireRerun(bountyId, submissionId))
        .to.emit(f.escrow, "BondReturned").withArgs(bountyId, submissionId, f.hunter.address, BOND)
        .and.to.emit(f.escrow, "SubmissionFinalized");
      expect((await f.escrow.getSubmission(bountyId, submissionId)).status).to.equal(2);
      expect(await f.escrow.pendingSubmissionIds(bountyId)).to.deep.equal([]);
      await expect(f.escrow.expireRerun(bountyId, submissionId)).to.be.revertedWith("not awaiting rerun");
    });

    it("the re-run window never passes the submission deadline; at the deadline the re-run expires", async function () {
      const f = await loadFixture(fixture);
      const deadline = (await time.latest()) + HOUR;
      const { bountyId, submissionId } = await softFailed(f, { deadline });
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect(s.rerunDeadline).to.equal(BigInt(deadline) - 1n);
      await time.increaseTo(deadline);
      // a submission awaiting a re-run holds the bounty open: the lens agrees with closeExpiredBounty
      expect(await f.escrow.activeEvaluations(bountyId)).to.equal(0);
      expect(await f.escrow.canBeClosed(bountyId)).to.equal(false);
      await expect(f.escrow.closeExpiredBounty(bountyId)).to.be.revertedWith("active evaluation - finalize first");
      await f.escrow.expireRerun(bountyId, submissionId);
      expect(await f.escrow.canBeClosed(bountyId)).to.equal(true);
      await expect(f.escrow.closeExpiredBounty(bountyId)).to.emit(f.escrow, "BountyClosed");
    });

    it("a soft fail with no time left before the deadline fails at once, with the bond returned", async function () {
      const f = await loadFixture(fixture);
      const deadline = (await time.latest()) + 60;
      const { bountyId } = await createBounty(f, { deadline });
      const s = await submit(f, bountyId);
      await runRound(f, bountyId, s.submissionId, mix(4, 2));
      await time.increaseTo(deadline);
      await expect(f.escrow.finalizeSubmission(bountyId, s.submissionId))
        .to.emit(f.escrow, "BondReturned").and.to.not.emit(f.escrow, "RerunAwaited");
      expect((await f.escrow.getSubmission(bountyId, s.submissionId)).status).to.equal(2);
    });

    it("at most 6 rounds: the 6th soft fail ends the submission with its bond returned", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, submissionId } = await softFailed(f);
      expect(await f.escrow.MAX_ROUNDS()).to.equal(6);
      for (let round = 2; round <= 6; round++) {
        await f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value: await f.escrow.requiredPrepay(bountyId) });
        await runRound(f, bountyId, submissionId, mix(4, 2));
        const tx = f.escrow.finalizeSubmission(bountyId, submissionId);
        if (round < 6) await expect(tx).to.emit(f.escrow, "RerunAwaited");
        else await expect(tx).to.emit(f.escrow, "BondReturned").and.to.not.emit(f.escrow, "RerunAwaited");
      }
      const s = await f.escrow.getSubmission(bountyId, submissionId);
      expect([s.status, s.rounds]).to.deep.equal([2n, 6n]);
    });

    // Review 2026-11-26 #4: a later passing round must not extinguish an earlier submission's
    // re-run. The re-run keeps its index; only a LOWER-index pass can beat it.
    const rerun = async (f, bountyId, submissionId) =>
      f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value: await f.escrow.requiredPrepay(bountyId) });

    for (const order of ["later first", "earlier first"]) {
      it(`an earlier soft fail re-runs ahead of a later pass and, passing, is paid (finalize ${order})`, async function () {
        const f = await loadFixture(fixture);
        const { bountyId, submissionId } = await softFailed(f);
        const later = await submit(f, bountyId, f.hunter2);
        await runRound(f, bountyId, later.submissionId, mix(4, 4));
        await expect(f.escrow.finalizeSubmission(bountyId, later.submissionId))
          .to.be.revertedWith("earlier submission pending - retry after it resolves");
        expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("RERUN");
        await rerun(f, bountyId, submissionId);
        // a NEW submission still cannot start: it could never beat the passing round
        const third = await prepare(f, bountyId, f.other);
        await expect(f.escrow.connect(f.other).startPreparedSubmission(bountyId, third.submissionId, { value: await f.escrow.startValue(bountyId) }))
          .to.be.revertedWith("another submission already passed - finalize it first");
        expect(await f.escrow.nextAction(bountyId, third.submissionId)).to.equal("DEAD");
        await runRound(f, bountyId, submissionId, mix(4, 4));
        if (order === "later first") {
          await expect(f.escrow.finalizeSubmission(bountyId, later.submissionId))
            .to.be.revertedWith("earlier submission pending - retry after it resolves");
        }
        await expect(f.escrow.finalizeSubmission(bountyId, submissionId)).to.emit(f.escrow, "PayoutSent");
        await f.escrow.finalizeSubmission(bountyId, later.submissionId);
        expect((await f.escrow.getSubmission(bountyId, submissionId)).status).to.equal(3n);        // PassedPaid
        expect((await f.escrow.getSubmission(bountyId, later.submissionId)).status).to.equal(4n);  // PassedUnpaid
        expect((await f.escrow.getBounty(bountyId)).winner).to.equal(f.hunter.address);
      });
    }

    it("if the earlier re-run fails again and its window closes, the later pass is paid", async function () {
      const f = await loadFixture(fixture);
      const { bountyId, submissionId } = await softFailed(f);
      const later = await submit(f, bountyId, f.hunter2);
      await runRound(f, bountyId, later.submissionId, mix(4, 4));
      await rerun(f, bountyId, submissionId);
      await runRound(f, bountyId, submissionId, mix(4, 2));                  // soft fail again
      await expect(f.escrow.finalizeSubmission(bountyId, submissionId)).to.emit(f.escrow, "RerunAwaited");
      await expect(f.escrow.finalizeSubmission(bountyId, later.submissionId))
        .to.be.revertedWith("earlier submission pending - retry after it resolves");
      await time.increase(2 * HOUR + 1);
      await f.escrow.expireRerun(bountyId, submissionId);
      await expect(f.escrow.finalizeSubmission(bountyId, later.submissionId)).to.emit(f.escrow, "PayoutSent");
      expect((await f.escrow.getBounty(bountyId)).winner).to.equal(f.hunter2.address);
    });

    it("an earlier round with no result also re-runs ahead of a later pass", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, aggId } = await submit(f, bountyId);
      await mine(2);
      await f.escrow.drawJury(bountyId, submissionId);
      await f.agg.scriptCommits(aggId, 2);                                 // too few commits
      await time.increase(301);
      await f.escrow.connect(f.other).closeFailedRound(bountyId, submissionId);
      const later = await submit(f, bountyId, f.hunter2);
      await runRound(f, bountyId, later.submissionId, mix(4, 4));
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("RERUN");
      await rerun(f, bountyId, submissionId);
      await runRound(f, bountyId, submissionId, mix(4, 4));
      await expect(f.escrow.finalizeSubmission(bountyId, submissionId)).to.emit(f.escrow, "PayoutSent");
      expect((await f.escrow.getBounty(bountyId)).winner).to.equal(f.hunter.address);
    });

    it("a LOWER-index passing round still refuses a re-run; the waiting one expires and the pass is paid", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const earlier = await submit(f, bountyId, f.hunter2);
      const s = await submit(f, bountyId);
      await runRound(f, bountyId, s.submissionId, mix(4, 2));
      await f.escrow.finalizeSubmission(bountyId, s.submissionId);           // soft fail: awaits a re-run
      await runRound(f, bountyId, earlier.submissionId, mix(4, 4));          // the earlier one passes
      expect(await f.escrow.nextAction(bountyId, s.submissionId)).to.equal("AWAIT_EXPIRY");
      await expect(rerun(f, bountyId, s.submissionId))
        .to.be.revertedWith("another submission already passed - finalize it first");
      await expect(f.escrow.finalizeSubmission(bountyId, earlier.submissionId)).to.emit(f.escrow, "PayoutSent");
    });

    it("a round with no result (failed, closed by anyone) also re-runs, keeping the bond", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, aggId } = await submit(f, bountyId);
      await mine(2);
      await f.escrow.drawJury(bountyId, submissionId);
      await f.agg.scriptCommits(aggId, 2);                                 // too few commits
      await time.increase(301);
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("CLOSE_FAILED");
      await expect(f.escrow.connect(f.other).closeFailedRound(bountyId, submissionId))
        .to.emit(f.escrow, "RerunAwaited").withArgs(bountyId, submissionId, 1, 0, true, (v) => v > 0n);
      expect((await f.escrow.getSubmission(bountyId, submissionId)).bondHeld).to.equal(BOND);
    });
  });

  // Review 2026-11-26 #19 (accepted limitation): the escrow stores a jury the aggregator's live,
  // owner-set limits refuse; hunters check the terms first, through juryProblem, and nextAction
  // never names a start or re-run the aggregator would refuse.
  describe("a jury the aggregator refuses (juryProblem)", function () {
    it("is empty for a jury within the live limits", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      expect(await f.escrow.juryProblem(bountyId)).to.equal("");
    });

    for (const [label, jury, reason] of [
      ["timeout 0", { ...SMALL, timeout: 0 }, "timeout at or below tPlus"],
      ["timeout at T+", { ...SMALL, timeout: 155 }, "timeout at or below tPlus"],
      ["timeout above maxTimeout", { ...SMALL, timeout: 7200 }, "timeout above maxTimeout"],
      ["K above maxJury", { K: 60, M: 40, N: 40, P: 3, timeout: 300 }, "K above maxJury"],
    ]) {
      it(`${label}: named, a prepared submission is DEAD, and its start is refused`, async function () {
        const f = await loadFixture(fixture);
        const { bountyId } = await createBounty(f, { jury, quota: 3, forfeitLine: 1 });
        expect(await f.escrow.juryProblem(bountyId)).to.equal(reason);
        const p = await prepare(f, bountyId);
        expect(await f.escrow.nextAction(bountyId, p.submissionId)).to.equal("DEAD");
        await expect(start(f, bountyId, p.submissionId)).to.be.reverted;
      });
    }

    it("a limit tightened after a soft fail: the re-run is AWAIT_EXPIRY, then EXPIRE_RERUN", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const s = await submit(f, bountyId);
      await runRound(f, bountyId, s.submissionId, mix(4, 2));
      await f.escrow.finalizeSubmission(bountyId, s.submissionId);
      expect(await f.escrow.nextAction(bountyId, s.submissionId)).to.equal("RERUN");
      await f.agg.setLimits(5, 3600);                                       // maxJury below K = 6
      expect(await f.escrow.juryProblem(bountyId)).to.equal("K above maxJury");
      expect(await f.escrow.nextAction(bountyId, s.submissionId)).to.equal("AWAIT_EXPIRY");
      await time.increase(2 * HOUR + 1);
      expect(await f.escrow.nextAction(bountyId, s.submissionId)).to.equal("EXPIRE_RERUN");
    });
  });

  describe("the round's phases, as nextAction sees them", function () {
    it("DRAW, CLOSE_COMMITS after T+ with M commits, PROMOTE from C+2, then FINALIZE", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f);
      const { submissionId, aggId } = await submit(f, bountyId);
      const act = () => f.escrow.nextAction(bountyId, submissionId);
      await mine(2);
      expect(await act()).to.equal("DRAW");
      await f.escrow.drawJury(bountyId, submissionId);
      expect(await act()).to.equal("AWAIT_ORACLE");
      await f.agg.scriptCommits(aggId, 5);                                 // M = 5 of the M+ = 6
      expect(await act()).to.equal("AWAIT_ORACLE");
      await time.increase(156);                                              // past T+
      expect(await act()).to.equal("CLOSE_COMMITS");
      await f.agg.closeCommits(aggId);
      await mine(2);
      expect(await act()).to.equal("PROMOTE");
      await f.agg.promote(aggId);
      expect(await act()).to.equal("AWAIT_ORACLE");
      await f.agg.scriptReveals(aggId, mix(4, 4), JUST);
      expect(await act()).to.equal("FINALIZE");
    });

    it("a beacon bounty: the first draw starts the stage, DRAW again once the quorum is in", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { withBeacons: true });
      const { submissionId, aggId } = await submit(f, bountyId);
      expect((await f.agg.requestParams(aggId)).withBeacons).to.equal(true);
      await mine(2);
      await expect(f.escrow.drawJury(bountyId, submissionId)).to.emit(f.agg, "BeaconStageStarted");
      expect(await phase(f.agg, aggId)).to.equal(2n);
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("AWAIT_ORACLE");
      await f.agg.scriptBeacons(aggId, 2, false);
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("DRAW");
      await expect(f.escrow.drawJury(bountyId, submissionId)).to.emit(f.agg, "JuryDrawn");
      expect(await phase(f.agg, aggId)).to.equal(3n);
    });

    it("a missed beacon quorum ends the round (prepay to the arbiter pool); it re-runs with the bond kept", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { withBeacons: true });
      const { submissionId, aggId } = await submit(f, bountyId);
      await mine(2);
      await f.escrow.drawJury(bountyId, submissionId);
      await f.agg.scriptBeacons(aggId, 1, true);                           // 1 of 2, deadline passed
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("DRAW");
      await expect(f.escrow.drawJury(bountyId, submissionId))
        .to.emit(f.agg, "EvaluationFailed").withArgs(aggId, 2)
        .and.to.emit(f.agg, "RequesterRefunded").withArgs(aggId, ethers.ZeroAddress, anyValue);
      expect(await f.agg.ethOwed(ethers.ZeroAddress)).to.be.gt(0);   // the arbiter pool
      expect(await f.escrow.nextAction(bountyId, submissionId)).to.equal("CLOSE_FAILED");
      await expect(f.escrow.closeFailedRound(bountyId, submissionId)).to.emit(f.escrow, "RerunAwaited");
      expect((await f.escrow.getSubmission(bountyId, submissionId)).bondHeld).to.equal(BOND);
    });
  });

  describe("juries: each bounty's own, on one aggregator", function () {
    it("a bounty's jury reaches its request, and its re-runs (getJury)", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { jury: LARGE, quota: 5, forfeitLine: 3 });
      const { submissionId, wallet, aggId } = await submit(f, bountyId);
      expect(await f.agg.requesterOf(aggId)).to.equal(wallet);
      expect(await f.agg.getJury(aggId)).to.deep.equal([10n, 8n, 7n, 4n, 600n]);
      // the deadline runs the jury's timeout from the draw
      await mine(2);
      await f.escrow.drawJury(bountyId, submissionId);
      expect((await f.agg.getRoundInfo(aggId))[8]).to.equal(BigInt(await time.latest()) + 600n);
      await runRound(f, bountyId, submissionId, mix(7, 4));                  // 4 of 7: soft fail (R = 3)
      await f.escrow.finalizeSubmission(bountyId, submissionId);
      const value = await f.escrow.requiredPrepay(bountyId);
      await f.escrow.connect(f.hunter).rerunSubmission(bountyId, submissionId, { value });
      const again = (await f.escrow.getSubmission(bountyId, submissionId)).verdiktaAggId;
      expect(again).to.not.equal(aggId);
      expect(await f.agg.getJury(again)).to.deep.equal([10n, 8n, 7n, 4n, 600n]);
    });

    it("Q is checked against the bounty's own N", async function () {
      const f = await loadFixture(fixture);
      await expect(createBounty(f, { jury: SMALL, quota: 5, forfeitLine: 3 })).to.be.revertedWith("bad quota");
      await createBounty(f, { jury: LARGE, quota: 7, forfeitLine: 3 });     // Q = N
      await expect(createBounty(f, { jury: LARGE, quota: 8, forfeitLine: 3 })).to.be.revertedWith("bad quota");
    });

    it("two bounties with different juries run on one aggregator, each with its own jury and prepay", async function () {
      const f = await loadFixture(fixture);
      const small = await createBounty(f, { jury: SMALL });
      const large = await createBounty(f, { jury: LARGE, quota: 5, forfeitLine: 3 });
      expect(await f.escrow.requiredPrepay(small.bountyId)).to.equal(await f.agg.maxTotalFee(FEE, 0, false, 6, 3));
      expect(await f.escrow.requiredPrepay(large.bountyId)).to.equal(await f.agg.maxTotalFee(FEE, 0, false, 10, 4));
      expect(await f.escrow.requiredPrepay(large.bountyId)).to.be.gt(await f.escrow.requiredPrepay(small.bountyId));
      const a = await submit(f, small.bountyId);
      const b = await submit(f, large.bountyId, f.hunter2);
      expect(await f.agg.roundCount()).to.equal(2);
      expect((await f.agg.getJury(a.aggId)).slice(0, 4)).to.deep.equal([6n, 5n, 4n, 3n]);
      expect((await f.agg.getJury(b.aggId)).slice(0, 4)).to.deep.equal([10n, 8n, 7n, 4n]);
      await runRound(f, small.bountyId, a.submissionId, mix(4, 3));          // 3 of 4 = Q
      await runRound(f, large.bountyId, b.submissionId, mix(7, 5));          // 5 of 7 = Q
      await expect(f.escrow.finalizeSubmission(small.bountyId, a.submissionId)).to.emit(f.escrow, "PayoutSent");
      await expect(f.escrow.finalizeSubmission(large.bountyId, b.submissionId)).to.emit(f.escrow, "PayoutSent");
    });
  });

  // Review 2026-11-28, blocker 4: the largest juries answer with one number (the aggregator keeps one
  // value per answer above N = 27, and a one-number round finalizes far cheaper). A bounty says which
  // shape its package asks for (`outcomes`, 2 or 1), and only a result of that shape is a result.
  describe("one-number bounties (outcomes = 1)", function () {
    const one = (...scores) => scores.map((x) => [BigInt(x)]);

    it("createBounty refuses outcomes other than 1 or 2, and stores the bounty's", async function () {
      const f = await loadFixture(fixture);
      for (const outcomes of [0, 3, 6]) {
        const p = { ...(await createBounty(f)).params, outcomes };
        await expect(f.escrow.connect(f.creator).createBounty(p, { value: BOUNTY })).to.be.revertedWith("bad outcomes");
      }
      expect((await f.escrow.getBounty((await createBounty(f, { outcomes: 1 })).bountyId)).outcomes).to.equal(1n);
      expect((await f.escrow.getBounty((await createBounty(f)).bountyId)).outcomes).to.equal(2n);
    });

    it("the Q-of-N rule reads each juror's one number as its FUND score: pass pays, and the bond comes back", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { outcomes: 1 });
      const a = await submit(f, bountyId);
      await runRound(f, bountyId, a.submissionId, one(900_000, 850_000, 800_000, 100_000));   // 3 of 4 at the threshold
      const r = await f.escrow.getOracleResult(bountyId, a.submissionId);
      expect([r.outcome, r.passCount, r.scores.length]).to.deep.equal([2n, 3n, 1n]);   // pass
      await expect(f.escrow.finalizeSubmission(bountyId, a.submissionId)).to.emit(f.escrow, "PayoutSent");
      const s = await f.escrow.getSubmission(bountyId, a.submissionId);
      expect(s.rejection).to.equal(0n);            // no DONT_FUND score in a one-number answer
      expect(s.acceptance).to.be.greaterThan(0n);
    });

    it("soft and hard fails follow the same counts", async function () {
      const f = await loadFixture(fixture);
      const soft = await createBounty(f, { outcomes: 1 });
      const a = await submit(f, soft.bountyId);
      await runRound(f, soft.bountyId, a.submissionId, one(900_000, 850_000, 100_000, 100_000));   // 2 of 4: R = 2
      expect((await f.escrow.getOracleResult(soft.bountyId, a.submissionId)).outcome).to.equal(3n);
      const hard = await createBounty(f, { outcomes: 1 });
      const b = await submit(f, hard.bountyId);
      await runRound(f, hard.bountyId, b.submissionId, one(900_000, 100_000, 100_000, 100_000));   // 1 of 4
      expect((await f.escrow.getOracleResult(hard.bountyId, b.submissionId)).outcome).to.equal(4n);
      await expect(f.escrow.finalizeSubmission(hard.bountyId, b.submissionId)).to.emit(f.escrow, "BondForfeited");
    });

    it("a two-value result on a one-number bounty is no result; a one-number result on a two-outcome bounty is none either", async function () {
      const f = await loadFixture(fixture);
      const yes2 = [[0n, 1_000_000n], [0n, 1_000_000n], [0n, 1_000_000n], [0n, 1_000_000n]];
      const oneB = await createBounty(f, { outcomes: 1 });
      const a = await submit(f, oneB.bountyId);
      await runRound(f, oneB.bountyId, a.submissionId, yes2);
      expect((await f.escrow.getOracleResult(oneB.bountyId, a.submissionId)).outcome).to.equal(1n);   // no result
      await expect(f.escrow.finalizeSubmission(oneB.bountyId, a.submissionId)).to.emit(f.escrow, "RerunAwaited");
      // the other way: jurors' DONT_FUND scores (outcome 0) must never be read as FUND
      const twoB = await createBounty(f);
      const b = await submit(f, twoB.bountyId);
      await runRound(f, twoB.bountyId, b.submissionId, one(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      expect((await f.escrow.getOracleResult(twoB.bountyId, b.submissionId)).outcome).to.equal(1n);
    });

    it("a one-number score above the scale never counts", async function () {
      const f = await loadFixture(fixture);
      const { bountyId } = await createBounty(f, { outcomes: 1 });
      const a = await submit(f, bountyId);
      await runRound(f, bountyId, a.submissionId, one(900_000, 900_000, 900_001, 1_000_001));
      const r = await f.escrow.getOracleResult(bountyId, a.submissionId);
      expect(r.passCount).to.equal(3n);            // 1,000,001 is not counted
    });
  });
});
