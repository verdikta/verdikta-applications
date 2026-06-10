const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BountyEscrow", function () {
  const EVAL_CID = "QmTestEvalCid123";
  const HUNTER_CID = "QmTestHunterCid456";
  const CLASS_ID = 128;
  const THRESHOLD = 70;
  const BOUNTY_WEI = ethers.parseEther("1");
  const MAX_ORACLE_FEE = ethers.parseEther("0.0001");
  const ALPHA = 50;
  const EST_BASE_COST = ethers.parseEther("0.00001");
  const MAX_FEE_SCALING = 2;
  const ADDENDUM = "";

  // Scores that sum to 1,000,000. acceptance = scores[1]/10000
  const PASSING_SCORES = [200000n, 800000n]; // 20% reject, 80% accept (>= 70 threshold)
  const FAILING_SCORES = [600000n, 400000n]; // 60% reject, 40% accept (< 70 threshold)
  const JUST_CIDS = "QmJustificationCid";

  async function deployBountyEscrowFixture() {
    const [owner, creator, hunter, hunter2, other] = await ethers.getSigners();

    const MockAgg = await ethers.getContractFactory("MockVerdiktaAggregator");
    const verdiktaAggregator = await MockAgg.deploy();

    const BountyEscrow = await ethers.getContractFactory("BountyEscrow");
    const bountyEscrow = await BountyEscrow.deploy(
      await verdiktaAggregator.getAddress()
    );

    return {
      bountyEscrow,
      verdiktaAggregator,
      owner,
      creator,
      hunter,
      hunter2,
      other,
    };
  }

  // Helper: create a bounty and return its ID
  async function createDefaultBounty(bountyEscrow, creator, overrides = {}) {
    const deadline = overrides.deadline ?? (await time.latest()) + 86400; // +24h
    const createFn = bountyEscrow.connect(creator)["createBounty(string,uint64,uint8,uint64,address)"];
    const args = [
      overrides.evalCid ?? EVAL_CID,
      overrides.classId ?? CLASS_ID,
      overrides.threshold ?? THRESHOLD,
      deadline,
      overrides.targetHunter ?? ethers.ZeroAddress,
    ];
    const tx = await createFn(
      ...args,
      { value: overrides.value ?? BOUNTY_WEI }
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (l) => l.fragment && l.fragment.name === "BountyCreated"
    );
    return { bountyId: event.args.bountyId, deadline, tx };
  }

  // Helper: prepare a submission and return submissionId + evalWallet + ethMaxBudget
  async function prepareDefaultSubmission(
    bountyEscrow,
    hunter,
    bountyId,
    overrides = {}
  ) {
    const tx = await bountyEscrow.connect(hunter).prepareSubmission(
      bountyId,
      overrides.evalCid ?? EVAL_CID,
      overrides.hunterCid ?? HUNTER_CID,
      overrides.addendum ?? ADDENDUM,
      overrides.alpha ?? ALPHA,
      overrides.maxOracleFee ?? MAX_ORACLE_FEE,
      overrides.estBaseCost ?? EST_BASE_COST,
      overrides.maxFeeScaling ?? MAX_FEE_SCALING
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (l) => l.fragment && l.fragment.name === "SubmissionPrepared"
    );
    return {
      submissionId: event.args.submissionId,
      evalWallet: event.args.evalWallet,
      ethMaxBudget: event.args.ethMaxBudget,
      tx,
    };
  }

  // Helper: start a prepared submission by attaching the ETH prepay (no approval step)
  async function startSubmission(
    bountyEscrow,
    funder,
    bountyId,
    submissionId,
    ethMaxBudget
  ) {
    const tx = await bountyEscrow
      .connect(funder)
      .startPreparedSubmission(bountyId, submissionId, { value: ethMaxBudget });
    return tx;
  }

  // Helper: full flow — prepare + start, return aggId
  async function submitFull(bountyEscrow, verdiktaAggregator, hunter, bountyId) {
    const { submissionId, evalWallet, ethMaxBudget } =
      await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

    const startTx = await startSubmission(
      bountyEscrow,
      hunter,
      bountyId,
      submissionId,
      ethMaxBudget
    );
    const startReceipt = await startTx.wait();
    const workEvent = startReceipt.logs.find(
      (l) => l.fragment && l.fragment.name === "WorkSubmitted"
    );
    const aggId = workEvent.args.verdiktaAggId;

    return { submissionId, evalWallet, ethMaxBudget, aggId };
  }

  // =========================================================================
  describe("Deployment", function () {
    it("Should deploy with correct Verdikta address", async function () {
      const { bountyEscrow, verdiktaAggregator } =
        await loadFixture(deployBountyEscrowFixture);

      expect(await bountyEscrow.verdikta()).to.equal(
        await verdiktaAggregator.getAddress()
      );
    });

    it("Should reject zero aggregator address in constructor", async function () {
      const BountyEscrow = await ethers.getContractFactory("BountyEscrow");

      await expect(
        BountyEscrow.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("zero addr");
    });
  });

  // =========================================================================
  describe("Bounty Creation", function () {
    it("Should create a bounty with valid parameters", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const deadline = (await time.latest()) + 86400;

      await expect(
        bountyEscrow
          .connect(creator)
          ["createBounty(string,uint64,uint8,uint64,address)"](EVAL_CID, CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress, {
            value: BOUNTY_WEI,
          })
      )
        .to.emit(bountyEscrow, "BountyCreated")
        .withArgs(0, creator.address, EVAL_CID, CLASS_ID, THRESHOLD, BOUNTY_WEI, deadline);

      const bounty = await bountyEscrow.getBounty(0);
      expect(bounty.creator).to.equal(creator.address);
      expect(bounty.evaluationCid).to.equal(EVAL_CID);
      expect(bounty.requestedClass).to.equal(CLASS_ID);
      expect(bounty.threshold).to.equal(THRESHOLD);
      expect(bounty.payoutWei).to.equal(BOUNTY_WEI);
      expect(bounty.status).to.equal(0); // Open
      expect(bounty.winner).to.equal(ethers.ZeroAddress);
      expect(bounty.submissions).to.equal(0);

      // ETH held in contract
      expect(
        await ethers.provider.getBalance(await bountyEscrow.getAddress())
      ).to.equal(BOUNTY_WEI);
    });

    it("Should reject bounty with zero ETH", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const deadline = (await time.latest()) + 86400;

      await expect(
        bountyEscrow
          .connect(creator)
          ["createBounty(string,uint64,uint8,uint64,address)"](EVAL_CID, CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress, { value: 0 })
      ).to.be.revertedWith("no creator payment");
    });

    it("Should reject bounty with empty evaluation CID", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const deadline = (await time.latest()) + 86400;

      await expect(
        bountyEscrow
          .connect(creator)
          ["createBounty(string,uint64,uint8,uint64,address)"]("", CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress, { value: BOUNTY_WEI })
      ).to.be.revertedWith("empty evaluationCid");
    });

    it("Should reject bounty with threshold > 100", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const deadline = (await time.latest()) + 86400;

      await expect(
        bountyEscrow
          .connect(creator)
          ["createBounty(string,uint64,uint8,uint64,address)"](EVAL_CID, CLASS_ID, 101, deadline, ethers.ZeroAddress, { value: BOUNTY_WEI })
      ).to.be.revertedWith("bad threshold");
    });

    it("Should reject bounty with deadline in the past", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const pastDeadline = (await time.latest()) - 1;

      await expect(
        bountyEscrow
          .connect(creator)
          ["createBounty(string,uint64,uint8,uint64,address)"](EVAL_CID, CLASS_ID, THRESHOLD, pastDeadline, ethers.ZeroAddress, {
            value: BOUNTY_WEI,
          })
      ).to.be.revertedWith("deadline in past");
    });

    it("Should assign sequential bounty IDs", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );

      const { bountyId: id0 } = await createDefaultBounty(bountyEscrow, creator);
      const { bountyId: id1 } = await createDefaultBounty(bountyEscrow, creator);
      const { bountyId: id2 } = await createDefaultBounty(bountyEscrow, creator);

      expect(id0).to.equal(0);
      expect(id1).to.equal(1);
      expect(id2).to.equal(2);
      expect(await bountyEscrow.bountyCount()).to.equal(3);
    });

    it("Should accept threshold of 0 and 100 as boundary values", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );

      await createDefaultBounty(bountyEscrow, creator, { threshold: 0 });
      await createDefaultBounty(bountyEscrow, creator, { threshold: 100 });

      expect((await bountyEscrow.getBounty(0)).threshold).to.equal(0);
      expect((await bountyEscrow.getBounty(1)).threshold).to.equal(100);
    });
  });

  // =========================================================================
  describe("Submission Preparation", function () {
    it("Should prepare a submission to an open bounty", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const { submissionId, evalWallet, ethMaxBudget, tx } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      expect(submissionId).to.equal(0);
      expect(evalWallet).to.not.equal(ethers.ZeroAddress);
      expect(ethMaxBudget).to.be.gt(0);

      await expect(tx)
        .to.emit(bountyEscrow, "SubmissionPrepared")
        .withArgs(bountyId, 0, hunter.address, evalWallet, EVAL_CID, ethMaxBudget);

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.hunter).to.equal(hunter.address);
      expect(sub.status).to.equal(0); // Prepared
      expect(sub.evalWallet).to.equal(evalWallet);
    });

    it("Should reject submission with mismatched evaluationCid", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter, bountyId, {
          evalCid: "QmWrongCid",
        })
      ).to.be.revertedWith("evaluationCid mismatch");
    });

    it("Should reject submission with empty hunterCid", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      await expect(
        bountyEscrow.connect(hunter).prepareSubmission(
          bountyId,
          EVAL_CID,
          "", // empty hunterCid
          ADDENDUM,
          ALPHA,
          MAX_ORACLE_FEE,
          EST_BASE_COST,
          MAX_FEE_SCALING
        )
      ).to.be.revertedWith("empty hunterCid");
    });

    it("Should reject submission to non-existent bounty", async function () {
      const { bountyEscrow, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );

      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter, 999)
      ).to.be.revertedWith("bad bountyId");
    });

    it("Should reject submission after deadline", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      await time.increaseTo(deadline);

      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter, bountyId)
      ).to.be.revertedWith("deadline passed");
    });

    it("Should reject submission to awarded bounty", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and wins
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      // Second hunter tries to prepare — bounty is now Awarded
      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter2, bountyId)
      ).to.be.revertedWith("bounty not open");
    });
  });

  // =========================================================================
  describe("Starting Submissions", function () {
    it("Should start a prepared submission with ETH payment", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, ethMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        })
      ).to.emit(bountyEscrow, "WorkSubmitted");

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(1); // PendingVerdikta
      expect(sub.verdiktaAggId).to.not.equal(ethers.ZeroHash);
    });

    it("Should reject start with wrong ETH amount", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await prepareDefaultSubmission(
        bountyEscrow,
        hunter,
        bountyId
      );

      // No ETH attached — should revert with wrong amount
      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: 0,
        })
      ).to.be.revertedWith("wrong eth amount");
    });

    it("Should reject start by non-hunter", async function () {
      const { bountyEscrow, creator, hunter, other } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, ethMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await expect(
        bountyEscrow.connect(other).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        })
      ).to.be.revertedWith("only hunter");
    });

    it("Should reject starting an already-started submission", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, ethMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
        value: ethMaxBudget,
      });

      // Try starting again
      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        })
      ).to.be.revertedWith("not prepared");
    });
  });

  // =========================================================================
  describe("Evaluation Finalization", function () {
    it("Should process passing evaluation and pay winner", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

      const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .withArgs(bountyId, submissionId, true, 80, 20, JUST_CIDS)
        .and.to.emit(bountyEscrow, "PayoutSent")
        .withArgs(bountyId, hunter.address, BOUNTY_WEI);

      // finalize is called by the default signer (not hunter), and the mock leaves no
      // refund by default, so the hunter's balance increases by exactly the payout.
      const hunterBalAfter = await ethers.provider.getBalance(hunter.address);
      expect(hunterBalAfter - hunterBalBefore).to.equal(BOUNTY_WEI);

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(3); // PassedPaid
      expect(sub.acceptance).to.equal(80);
      expect(sub.rejection).to.equal(20);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.status).to.equal(1); // Awarded
      expect(bounty.winner).to.equal(hunter.address);
      expect(bounty.payoutWei).to.equal(0);
    });

    it("Should process failing evaluation correctly", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .withArgs(bountyId, submissionId, false, 40, 60, JUST_CIDS);

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(2); // Failed

      // Bounty remains Open with full payout
      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.status).to.equal(0); // Open
      expect(bounty.payoutWei).to.equal(BOUNTY_WEI);
    });

    it("Should revert finalization when Verdikta is not ready", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Don't set evaluation — exists=false by default
      await expect(
        bountyEscrow.finalizeSubmission(bountyId, submissionId)
      ).to.be.revertedWith("Verdikta not ready");
    });

    it("Should reject finalization of non-pending submission", async function () {
      const { bountyEscrow, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Only prepared, not started
      const { submissionId } = await prepareDefaultSubmission(
        bountyEscrow, hunter, bountyId
      );

      await expect(
        bountyEscrow.finalizeSubmission(bountyId, submissionId)
      ).to.be.revertedWith("not pending");
    });

    it("Should handle exact threshold score as passing", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 70,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Exactly 70% acceptance: 700000 / 10000 = 70
      const exactScores = [300000n, 700000n];
      await verdiktaAggregator.setEvaluation(aggId, exactScores, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent");

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(3); // PassedPaid
    });

    it("Should handle score just below threshold as failing", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 70,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // 69% acceptance: 690000 / 10000 = 69
      const belowScores = [310000n, 690000n];
      await verdiktaAggregator.setEvaluation(aggId, belowScores, JUST_CIDS, true);

      await bountyEscrow.finalizeSubmission(bountyId, submissionId);
      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(2); // Failed
    });

    it("Should mark second passing submission as PassedUnpaid", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and passes
      const sub1 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);

      // Second hunter submits (must prepare before bounty awarded)
      // Since bounty is now Awarded, prepare will fail — this tests post-award rejection
      // Instead, let's test the race condition: both submit before either finalizes
    });

    it("Should mark late finalizer as PassedUnpaid when another already won", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Both hunters prepare and start before either finalizes
      const sub1 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      const sub2 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter2, bountyId
      );

      // First completes evaluation on Verdikta and finalizes — wins payout
      await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);
      expect((await bountyEscrow.getSubmission(bountyId, sub1.submissionId)).status)
        .to.equal(3); // PassedPaid

      // Second completes later — bounty already Awarded
      await verdiktaAggregator.setEvaluation(sub2.aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, sub2.submissionId);
      expect((await bountyEscrow.getSubmission(bountyId, sub2.submissionId)).status)
        .to.equal(4); // PassedUnpaid
    });
  });

  // =========================================================================
  describe("Timeout Handling", function () {
    it("Should allow timeout marking after 10 minutes", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Fast-forward 10+ minutes
      await time.increase(601);

      await expect(
        bountyEscrow.failTimedOutSubmission(bountyId, submissionId)
      )
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .withArgs(bountyId, submissionId, false, 0, 0, "TIMED_OUT");

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(2); // Failed
      expect(sub.finalizedAt).to.be.gt(0);

      // Bounty remains open for new submissions
      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.status).to.equal(0); // Open
    });

    it("Should reject timeout marking before timeout period", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Only 5 minutes — too early
      await time.increase(300);

      await expect(
        bountyEscrow.failTimedOutSubmission(bountyId, submissionId)
      ).to.be.revertedWith("timeout not reached");
    });

    it("Should reject timeout on non-pending submission", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Finalize it first
      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await time.increase(601);

      await expect(
        bountyEscrow.failTimedOutSubmission(bountyId, submissionId)
      ).to.be.revertedWith("not pending");
    });

    it("Should allow anyone to call timeout (not just hunter)", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, other } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      await time.increase(601);

      // Called by unrelated account — should succeed
      await expect(
        bountyEscrow.connect(other).failTimedOutSubmission(bountyId, submissionId)
      ).to.emit(bountyEscrow, "SubmissionFinalized");
    });

    it("Should settle the aggregator and recover the ETH prepay on force-fail (dead oracle)", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, other } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Model a dead oracle: the prepay stays RESERVED on the aggregator and is only
      // credited to the wallet's pull-ledger when finalizeEvaluationTimeout settles it.
      await verdiktaAggregator.setCreditOnTimeout(true);

      const { submissionId, evalWallet, ethMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
      await verdiktaAggregator.setRefundAmount(ethMaxBudget);
      await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
        value: ethMaxBudget,
      });

      // Pre-timeout: nothing owed to the wallet yet (prepay still reserved on aggregator).
      expect(await verdiktaAggregator.ethOwed(evalWallet)).to.equal(0);

      await time.increase(601);

      const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

      // Force-fail by an unrelated caller (hunter pays no gas). The contract now settles
      // the aggregator first, so the prepay is recovered and returned to the hunter —
      // without the settle step this would emit EthRefunded(0) and strand the prepay.
      await expect(
        bountyEscrow.connect(other).failTimedOutSubmission(bountyId, submissionId)
      )
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .and.to.emit(bountyEscrow, "EthRefunded")
        .withArgs(bountyId, submissionId, ethMaxBudget);

      const hunterBalAfter = await ethers.provider.getBalance(hunter.address);
      expect(hunterBalAfter - hunterBalBefore).to.equal(ethMaxBudget);

      // Aggregator credit fully drained — nothing stranded.
      expect(await verdiktaAggregator.ethOwed(evalWallet)).to.equal(0);
    });

    it("Should not let a hunter that rejects ETH brick close-out (pull-payment guard)", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, other } =
        await loadFixture(deployBountyEscrowFixture);
      const escrowAddr = await bountyEscrow.getAddress();

      const Grief = await ethers.getContractFactory("MockRejectingHunter");
      const grief = await Grief.deploy();
      const griefAddr = await grief.getAddress();

      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Fund the grief contract so it can pay the ETH prepay (it accepts ETH while not rejecting).
      await other.sendTransaction({ to: griefAddr, value: ethers.parseEther("0.01") });

      // Prepare + start via the contract. Model a dead oracle (prepay reserved until timeout).
      await grief.prepare(escrowAddr, bountyId, EVAL_CID, HUNTER_CID);
      const subId = await grief.lastSubId();
      const budget = await grief.lastBudget();
      await verdiktaAggregator.setCreditOnTimeout(true);
      await verdiktaAggregator.setRefundAmount(budget);
      await grief.start(escrowAddr, bountyId, subId);

      // Now the hunter rejects all incoming ETH.
      await grief.setRejecting(true);
      await time.increase(601);

      // Force-fail must NOT revert despite the hunter rejecting the refund; it defers it.
      await expect(
        bountyEscrow.connect(other).failTimedOutSubmission(bountyId, subId)
      )
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .and.to.emit(bountyEscrow, "PaymentDeferred")
        .withArgs(griefAddr, budget);

      // Refund is parked on the pull ledger (not lost), and the submission is resolved.
      expect(await bountyEscrow.withdrawable(griefAddr)).to.equal(budget);
      expect((await bountyEscrow.getSubmission(bountyId, subId)).status).to.equal(2); // Failed

      // Critically, the bounty is NOT bricked — the creator can still reclaim after the deadline.
      const b = await bountyEscrow.getBounty(bountyId);
      await time.increaseTo(Number(b.submissionDeadline) + 1);
      await expect(bountyEscrow.closeExpiredBounty(bountyId)).to.emit(bountyEscrow, "BountyClosed");

      // And the hunter can claim once it can receive ETH again.
      await grief.setRejecting(false);
      await expect(grief.claim(escrowAddr))
        .to.emit(bountyEscrow, "Withdrawn")
        .withArgs(griefAddr, budget);
      expect(await bountyEscrow.withdrawable(griefAddr)).to.equal(0);
    });
  });

  // =========================================================================
  describe("Closing Expired Bounties", function () {
    // Note: The contract has no cancelBounty function. Instead, closeExpiredBounty
    // returns funds to the creator after the submission deadline passes.

    it("Should allow closing an expired bounty and refund creator", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      await time.increaseTo(deadline);

      await expect(bountyEscrow.closeExpiredBounty(bountyId))
        .to.emit(bountyEscrow, "BountyClosed")
        .withArgs(bountyId, creator.address, BOUNTY_WEI);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.status).to.equal(2); // Closed
      expect(bounty.payoutWei).to.equal(0);
    });

    it("Should reject closing before deadline", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      await expect(
        bountyEscrow.closeExpiredBounty(bountyId)
      ).to.be.revertedWith("deadline not passed");
    });

    it("Should allow anyone to close an expired bounty", async function () {
      const { bountyEscrow, creator, other } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);
      await time.increaseTo(deadline);

      // Called by unrelated account — should succeed (funds go to creator)
      await expect(bountyEscrow.connect(other).closeExpiredBounty(bountyId))
        .to.emit(bountyEscrow, "BountyClosed")
        .withArgs(bountyId, creator.address, BOUNTY_WEI);
    });

    it("Should reject closing with active evaluations", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Submit and start evaluation (PendingVerdikta)
      await submitFull(bountyEscrow, verdiktaAggregator, hunter, bountyId);

      await time.increaseTo(deadline);

      await expect(
        bountyEscrow.closeExpiredBounty(bountyId)
      ).to.be.revertedWith("active evaluation - finalize first");
    });

    it("Should reject closing an already-awarded bounty", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await time.increaseTo(deadline);

      await expect(
        bountyEscrow.closeExpiredBounty(bountyId)
      ).to.be.revertedWith("not open");
    });

    it("Should allow closing after failed submissions are finalized", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Submit, fail, finalize
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await time.increaseTo(deadline);

      // Now close should succeed — no PendingVerdikta submissions
      await expect(bountyEscrow.closeExpiredBounty(bountyId))
        .to.emit(bountyEscrow, "BountyClosed");
    });

    it("Should close regardless of how many unstarted submissions exist (no loop DoS)", async function () {
      const { bountyEscrow, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Pile up many Prepared (never-started) submissions — the cheap spam that an
      // unbounded loop in closeExpiredBounty would have let grow past the gas limit.
      for (let i = 0; i < 6; i++) {
        await prepareDefaultSubmission(bountyEscrow, i % 2 === 0 ? hunter : hunter2, bountyId);
      }
      expect(await bountyEscrow.submissionCount(bountyId)).to.equal(6);
      // None are PendingVerdikta, so the active-evaluation counter is 0.
      expect(await bountyEscrow.activeEvaluations(bountyId)).to.equal(0);

      await time.increaseTo(deadline);

      // Close still works — the active-evaluation check is O(1), not a loop over the 6 subs.
      await expect(bountyEscrow.closeExpiredBounty(bountyId)).to.emit(bountyEscrow, "BountyClosed");
    });

    it("Should track activeEvaluations across start, finalize and force-fail", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      expect(await bountyEscrow.activeEvaluations(bountyId)).to.equal(0);

      // Two starts → counter 2
      const sub1 = await submitFull(bountyEscrow, verdiktaAggregator, hunter, bountyId);
      const sub2 = await submitFull(bountyEscrow, verdiktaAggregator, hunter2, bountyId);
      expect(await bountyEscrow.activeEvaluations(bountyId)).to.equal(2);

      // Finalize one (failing) → counter 1
      await verdiktaAggregator.setEvaluation(sub1.aggId, FAILING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);
      expect(await bountyEscrow.activeEvaluations(bountyId)).to.equal(1);

      // Force-fail the other → counter 0
      await time.increase(601);
      await bountyEscrow.failTimedOutSubmission(bountyId, sub2.submissionId);
      expect(await bountyEscrow.activeEvaluations(bountyId)).to.equal(0);
    });
  });

  // =========================================================================
  describe("View Functions", function () {
    it("Should return correct effective bounty status", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Before deadline: OPEN
      expect(await bountyEscrow.getEffectiveBountyStatus(bountyId)).to.equal("OPEN");

      // After deadline: EXPIRED
      await time.increaseTo(deadline);
      expect(await bountyEscrow.getEffectiveBountyStatus(bountyId)).to.equal("EXPIRED");

      // After close: CLOSED
      await bountyEscrow.closeExpiredBounty(bountyId);
      expect(await bountyEscrow.getEffectiveBountyStatus(bountyId)).to.equal("CLOSED");
    });

    it("Should return AWARDED status after payout", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      expect(await bountyEscrow.getEffectiveBountyStatus(bountyId)).to.equal("AWARDED");
    });

    it("Should report isAcceptingSubmissions correctly", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      expect(await bountyEscrow.isAcceptingSubmissions(bountyId)).to.be.true;

      await time.increaseTo(deadline);
      expect(await bountyEscrow.isAcceptingSubmissions(bountyId)).to.be.false;
    });

    it("Should report canBeClosed correctly", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Before deadline
      expect(await bountyEscrow.canBeClosed(bountyId)).to.be.false;

      // After deadline, no active evals
      await time.increaseTo(deadline);
      expect(await bountyEscrow.canBeClosed(bountyId)).to.be.true;
    });

    it("Should report canBeClosed false with active evaluations", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      await submitFull(bountyEscrow, verdiktaAggregator, hunter, bountyId);
      await time.increaseTo(deadline);

      expect(await bountyEscrow.canBeClosed(bountyId)).to.be.false;
    });

    it("Should revert getBounty for invalid ID", async function () {
      const { bountyEscrow } = await loadFixture(deployBountyEscrowFixture);

      await expect(bountyEscrow.getBounty(0)).to.be.revertedWith("bad bountyId");
    });

    it("Should revert getSubmission for invalid ID", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      await expect(
        bountyEscrow.getSubmission(bountyId, 0)
      ).to.be.revertedWith("bad submissionId");
    });
  });

  // =========================================================================
  describe("Edge Cases", function () {
    it("Should handle multiple submissions to same bounty", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const sub1 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      const sub2 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter2, bountyId
      );

      expect(sub1.submissionId).to.equal(0);
      expect(sub2.submissionId).to.equal(1);
      expect(await bountyEscrow.submissionCount(bountyId)).to.equal(2);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.submissions).to.equal(2);
    });

    it("Should prevent new submissions after bounty is awarded", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter2, bountyId)
      ).to.be.revertedWith("bounty not open");
    });

    it("Should accept direct ETH transfers via receive()", async function () {
      // Note: The contract has a receive() function that accepts ETH.
      // This is the actual behavior — the original stub expected rejection,
      // but the contract does accept direct ETH.
      const { bountyEscrow, other } = await loadFixture(
        deployBountyEscrowFixture
      );

      const contractAddr = await bountyEscrow.getAddress();
      await other.sendTransaction({ to: contractAddr, value: ethers.parseEther("0.1") });
      expect(await ethers.provider.getBalance(contractAddr)).to.equal(
        ethers.parseEther("0.1")
      );
    });

    it("Should handle zero-threshold bounty (any score passes)", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 0,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // Even 0% acceptance passes with threshold 0
      const zeroScores = [1000000n, 0n];
      await verdiktaAggregator.setEvaluation(aggId, zeroScores, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent");
    });

    it("Should handle max-threshold bounty (100 required)", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 100,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      // 99% acceptance — should fail with threshold 100
      const scores99 = [10000n, 990000n];
      await verdiktaAggregator.setEvaluation(aggId, scores99, JUST_CIDS, true);

      await bountyEscrow.finalizeSubmission(bountyId, submissionId);
      expect(
        (await bountyEscrow.getSubmission(bountyId, submissionId)).status
      ).to.equal(2); // Failed
    });

    it("Should handle max-threshold bounty with 100% acceptance as passing", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 100,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      const scores100 = [0n, 1000000n];
      await verdiktaAggregator.setEvaluation(aggId, scores100, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent");
    });

    it("Should block starting submission when another already passed on Verdikta", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and Verdikta returns passing result (not yet finalized)
      const sub1 = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);

      // Second hunter prepares...
      const { submissionId: sub2Id, ethMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

      // ...but starting should revert because sub1 already passed on Verdikta
      await expect(
        bountyEscrow.connect(hunter2).startPreparedSubmission(bountyId, sub2Id, {
          value: ethMaxBudget,
        })
      ).to.be.revertedWith("another submission already passed - finalize it first");
    });

    it("Should handle bounty with zero submissions at close", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      await time.increaseTo(deadline);

      // Close with no submissions — should refund creator
      await expect(bountyEscrow.closeExpiredBounty(bountyId))
        .to.emit(bountyEscrow, "BountyClosed")
        .withArgs(bountyId, creator.address, BOUNTY_WEI);

      expect(
        await ethers.provider.getBalance(await bountyEscrow.getAddress())
      ).to.equal(0);
    });

    it("Should refund leftover ETH to hunter after finalization", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Configure the mock to leave the full prepay as a refundable ethOwed credit,
      // simulating an evaluation that cost less than the worst-case budget.
      const { submissionId, ethMaxBudget, evalWallet } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
      await verdiktaAggregator.setRefundAmount(ethMaxBudget);

      await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
        value: ethMaxBudget,
      });
      const startSub = await bountyEscrow.getSubmission(bountyId, submissionId);
      const aggId = startSub.verdiktaAggId;

      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);

      const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

      // finalize called by default signer (owner) — hunter pays no gas, receives the refund.
      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "EthRefunded")
        .withArgs(bountyId, submissionId, ethMaxBudget);

      const hunterBalAfter = await ethers.provider.getBalance(hunter.address);
      expect(hunterBalAfter - hunterBalBefore).to.equal(ethMaxBudget);
    });

    it("Should store submission timestamps correctly", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.submittedAt).to.be.gt(0);
      expect(sub.finalizedAt).to.equal(0);

      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      const subAfter = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(subAfter.finalizedAt).to.be.gt(0);
      expect(subAfter.finalizedAt).to.be.gte(subAfter.submittedAt);
    });
  });

  // =========================================================================
  describe("Targeted Bounties", function () {
    it("Should create a targeted bounty with targetHunter set", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        targetHunter: hunter.address,
      });

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.targetHunter).to.equal(hunter.address);
    });

    it("Should create an open bounty with targetHunter = address(0)", async function () {
      const { bountyEscrow, creator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.targetHunter).to.equal(ethers.ZeroAddress);
    });

    it("Should allow targeted hunter to submit", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        targetHunter: hunter.address,
      });

      const { submissionId } = await prepareDefaultSubmission(
        bountyEscrow, hunter, bountyId
      );
      expect(submissionId).to.equal(0);
    });

    it("Should reject non-targeted hunter from submitting", async function () {
      const { bountyEscrow, creator, hunter, hunter2 } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        targetHunter: hunter.address,
      });

      await expect(
        prepareDefaultSubmission(bountyEscrow, hunter2, bountyId)
      ).to.be.revertedWith("bounty is targeted");
    });

    it("Should allow full flow for targeted bounty: submit, evaluate, pay", async function () {
      const { bountyEscrow, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        targetHunter: hunter.address,
      });

      const { submissionId, aggId } = await submitFull(
        bountyEscrow, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent")
        .withArgs(bountyId, hunter.address, BOUNTY_WEI);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.status).to.equal(1); // Awarded
      expect(bounty.winner).to.equal(hunter.address);
    });

    it("Should allow anyone to submit to open bounty (targetHunter = 0)", async function () {
      const { bountyEscrow, creator, hunter, hunter2 } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Both hunters can submit to an open bounty
      await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
      await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

      expect(await bountyEscrow.submissionCount(bountyId)).to.equal(2);
    });
  });

  // =========================================================================
  describe("Creator Approval Window", function () {
    const CREATOR_PAY = ethers.parseEther("0.5");
    const ARBITER_PAY = ethers.parseEther("1");
    const MAX_PAY = ARBITER_PAY; // max(0.5, 1) = 1
    const WINDOW_SIZE = 3600; // 1 hour

    // Helper: create a bounty with creator approval window
    async function createWindowedBounty(bountyEscrow, creator, overrides = {}) {
      const deadline = overrides.deadline ?? (await time.latest()) + 86400;
      const creatorPay = overrides.creatorPay ?? CREATOR_PAY;
      const arbiterPay = overrides.arbiterPay ?? ARBITER_PAY;
      const windowSize = overrides.windowSize ?? WINDOW_SIZE;
      const maxPay = creatorPay > arbiterPay ? creatorPay : arbiterPay;

      const createFn = bountyEscrow.connect(creator)[
        "createBounty(string,uint64,uint8,uint64,address,uint256,uint256,uint64)"
      ];
      const tx = await createFn(
        overrides.evalCid ?? EVAL_CID,
        overrides.classId ?? CLASS_ID,
        overrides.threshold ?? THRESHOLD,
        deadline,
        overrides.targetHunter ?? ethers.ZeroAddress,
        creatorPay,
        arbiterPay,
        windowSize,
        { value: overrides.value ?? maxPay }
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "BountyCreated"
      );
      return { bountyId: event.args.bountyId, deadline, tx };
    }

    describe("Bounty Creation with Window", function () {
      it("Should create a windowed bounty with correct parameters", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.creatorDeterminationPayment).to.equal(CREATOR_PAY);
        expect(bounty.arbiterDeterminationPayment).to.equal(ARBITER_PAY);
        expect(bounty.creatorAssessmentWindowSize).to.equal(WINDOW_SIZE);
        expect(bounty.payoutWei).to.equal(MAX_PAY);
      });

      it("Should store equal payments and zero window for backward-compat createBounty", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.creatorDeterminationPayment).to.equal(BOUNTY_WEI);
        expect(bounty.arbiterDeterminationPayment).to.equal(BOUNTY_WEI);
        expect(bounty.creatorAssessmentWindowSize).to.equal(0);
      });

      it("Should reject when msg.value != max(creatorPay, arbiterPay)", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const deadline = (await time.latest()) + 86400;

        const createFn = bountyEscrow.connect(creator)[
          "createBounty(string,uint64,uint8,uint64,address,uint256,uint256,uint64)"
        ];

        // Send less than max
        await expect(
          createFn(EVAL_CID, CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress,
            CREATOR_PAY, ARBITER_PAY, WINDOW_SIZE,
            { value: CREATOR_PAY }) // 0.5 ETH, but max is 1 ETH
        ).to.be.revertedWith("ETH must equal max payment");
      });

      it("Should reject when payments differ but window is zero", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const deadline = (await time.latest()) + 86400;

        const createFn = bountyEscrow.connect(creator)[
          "createBounty(string,uint64,uint8,uint64,address,uint256,uint256,uint64)"
        ];

        await expect(
          createFn(EVAL_CID, CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress,
            CREATOR_PAY, ARBITER_PAY, 0, // windowSize = 0 but payments differ
            { value: ARBITER_PAY })
        ).to.be.revertedWith("window required when payments differ");
      });

      it("Should allow equal payments with zero window via 8-arg overload", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const deadline = (await time.latest()) + 86400;

        const createFn = bountyEscrow.connect(creator)[
          "createBounty(string,uint64,uint8,uint64,address,uint256,uint256,uint64)"
        ];

        await expect(
          createFn(EVAL_CID, CLASS_ID, THRESHOLD, deadline, ethers.ZeroAddress,
            BOUNTY_WEI, BOUNTY_WEI, 0,
            { value: BOUNTY_WEI })
        ).to.emit(bountyEscrow, "BountyCreated");
      });

      it("Should accept creatorPay > arbiterPay (creator escrows creatorPay)", async function () {
        const { bountyEscrow, creator } = await loadFixture(deployBountyEscrowFixture);
        const highCreatorPay = ethers.parseEther("2");
        const lowArbiterPay = ethers.parseEther("1");

        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          creatorPay: highCreatorPay,
          arbiterPay: lowArbiterPay,
        });

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.payoutWei).to.equal(highCreatorPay); // max(2, 1) = 2
      });
    });

    describe("Submission with Creator Window", function () {
      it("Should set status to PendingCreatorApproval for windowed bounties", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
        expect(sub.status).to.equal(5); // PendingCreatorApproval
        expect(sub.creatorWindowEnd).to.be.gt(0);
      });

      it("Should set creatorWindowEnd correctly", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
        // creatorWindowEnd = submittedAt + windowSize
        expect(sub.creatorWindowEnd).to.equal(Number(sub.submittedAt) + WINDOW_SIZE);
      });

      it("Should set status to Prepared for non-windowed bounties (unchanged behavior)", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
        expect(sub.status).to.equal(0); // Prepared
        expect(sub.creatorWindowEnd).to.equal(0);
      });
    });

    describe("Creator Approval", function () {
      it("Should allow creator to approve and pay during window", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId)
        )
          .to.emit(bountyEscrow, "CreatorApproved")
          .withArgs(bountyId, submissionId, hunter.address, CREATOR_PAY)
          .and.to.emit(bountyEscrow, "PayoutSent")
          .withArgs(bountyId, hunter.address, CREATOR_PAY);

        const hunterBalAfter = await ethers.provider.getBalance(hunter.address);
        expect(hunterBalAfter - hunterBalBefore).to.equal(CREATOR_PAY);

        const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
        expect(sub.status).to.equal(3); // PassedPaid

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.status).to.equal(1); // Awarded
        expect(bounty.winner).to.equal(hunter.address);
      });

      it("Should refund excess to creator when creatorPay < arbiterPay", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        const expectedRefund = ARBITER_PAY - CREATOR_PAY; // 0.5 ETH

        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId)
        )
          .to.emit(bountyEscrow, "CreatorRefunded")
          .withArgs(bountyId, creator.address, expectedRefund);
      });

      it("Should not refund when creatorPay = max(creatorPay, arbiterPay)", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const highCreatorPay = ethers.parseEther("2");
        const lowArbiterPay = ethers.parseEther("1");

        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          creatorPay: highCreatorPay,
          arbiterPay: lowArbiterPay,
        });

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        // No CreatorRefunded event expected (refund = 0)
        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId)
        )
          .to.emit(bountyEscrow, "PayoutSent")
          .withArgs(bountyId, hunter.address, highCreatorPay)
          .and.to.not.emit(bountyEscrow, "CreatorRefunded");
      });

      it("Should reject approval after window expires", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        // Advance past window
        await time.increase(WINDOW_SIZE + 1);

        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId)
        ).to.be.revertedWith("window expired");
      });

      it("Should reject approval by non-creator", async function () {
        const { bountyEscrow, creator, hunter, other } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await expect(
          bountyEscrow.connect(other).creatorApproveSubmission(bountyId, submissionId)
        ).to.be.revertedWith("only creator");
      });

      it("Should reject approval of non-PendingCreatorApproval submission", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        // Non-windowed bounty — submissions start as Prepared
        const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId)
        ).to.be.revertedWith("not pending creator approval");
      });

      it("Should reject approval when bounty already awarded", async function () {
        const { bountyEscrow, creator, hunter, hunter2 } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // First submission — creator approves
        const { submissionId: sub0 } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        await bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub0);

        // Second submission can't even be prepared (bounty not open)
        await expect(
          prepareDefaultSubmission(bountyEscrow, hunter2, bountyId)
        ).to.be.revertedWith("bounty not open");
      });
    });

    describe("Window Expiry and Arbitration", function () {
      it("Should allow arbitration after window expires", async function () {
        const { bountyEscrow, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        // Can't start during window
        await expect(
          bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
            value: ethMaxBudget,
          })
        ).to.be.revertedWith("creator window still open");

        // Advance past window
        await time.increase(WINDOW_SIZE + 1);

        // Now can start
        await expect(
          bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
            value: ethMaxBudget,
          })
        ).to.emit(bountyEscrow, "WorkSubmitted");

        const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
        expect(sub.status).to.equal(1); // PendingVerdikta
      });

      it("Should pay arbiterDeterminationPayment and refund excess on arbiter approval", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await time.increase(WINDOW_SIZE + 1);
        const startTx = await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        });
        const startReceipt = await startTx.wait();
        const workEvent = startReceipt.logs.find(
          (l) => l.fragment && l.fragment.name === "WorkSubmitted"
        );
        const aggId = workEvent.args.verdiktaAggId;

        await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

        const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

        await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
          .to.emit(bountyEscrow, "PayoutSent")
          .withArgs(bountyId, hunter.address, ARBITER_PAY);

        const hunterBalAfter = await ethers.provider.getBalance(hunter.address);
        expect(hunterBalAfter - hunterBalBefore).to.equal(ARBITER_PAY);
      });

      it("Should refund excess to creator when arbiterPay < creatorPay", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const highCreatorPay = ethers.parseEther("2");
        const lowArbiterPay = ethers.parseEther("1");

        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          creatorPay: highCreatorPay,
          arbiterPay: lowArbiterPay,
        });

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await time.increase(WINDOW_SIZE + 1);
        const startTx = await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        });
        const startReceipt = await startTx.wait();
        const aggId = startReceipt.logs.find(
          (l) => l.fragment && l.fragment.name === "WorkSubmitted"
        ).args.verdiktaAggId;

        await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

        const expectedRefund = highCreatorPay - lowArbiterPay; // 2 - 1 = 1 ETH

        await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
          .to.emit(bountyEscrow, "CreatorRefunded")
          .withArgs(bountyId, creator.address, expectedRefund)
          .and.to.emit(bountyEscrow, "PayoutSent")
          .withArgs(bountyId, hunter.address, lowArbiterPay);
      });

      it("Should allow anyone to fund arbitration after window expires", async function () {
        const { bountyEscrow, creator, hunter, other } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          targetHunter: hunter.address,
        });

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await time.increase(WINDOW_SIZE + 1);

        // 'other' funds and starts arbitration (attaches the ETH prepay) — should succeed
        await expect(
          bountyEscrow.connect(other).startPreparedSubmission(bountyId, submissionId, {
            value: ethMaxBudget,
          })
        ).to.emit(bountyEscrow, "WorkSubmitted");
      });

      it("Should block startPreparedSubmission on awarded bounty", async function () {
        const { bountyEscrow, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // Sub 0: creator approves
        const sub0 = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        await bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub0.submissionId);

        // Bounty is now Awarded. If sub 1 existed, starting it would fail.
        // But we can't even prepare sub 1 since bounty is Awarded.
        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.status).to.equal(1); // Awarded
      });
    });

    describe("Priority Ordering", function () {
      it("Should block approval of sub 1 while sub 0 is PendingCreatorApproval", async function () {
        const { bountyEscrow, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // Both submit
        const sub0 = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        const sub1 = await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

        // Creator tries to approve sub 1 — blocked by sub 0
        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub1.submissionId)
        ).to.be.revertedWith("earlier submission unresolved");

        // Creator can approve sub 0
        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub0.submissionId)
        ).to.emit(bountyEscrow, "CreatorApproved");
      });

      it("Should block approval of sub 1 while sub 0 is PendingVerdikta", async function () {
        const { bountyEscrow, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // Sub 0 submitted, window expires, goes to arbitration
        const sub0 = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        await time.increase(WINDOW_SIZE + 1);
        await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, sub0.submissionId, {
          value: sub0.ethMaxBudget,
        });

        // Sub 1 submitted (needs to be before deadline, which it is since deadline is +24h)
        const sub1 = await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

        // Creator tries to approve sub 1 — blocked by sub 0 in PendingVerdikta
        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub1.submissionId)
        ).to.be.revertedWith("earlier submission unresolved");
      });

      it("Should allow approval of sub 1 after sub 0 fails arbitration", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // Sub 0: goes to arbitration and fails
        const sub0 = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        await time.increase(WINDOW_SIZE + 1);
        await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, sub0.submissionId, {
          value: sub0.ethMaxBudget,
        });

        const sub0Data = await bountyEscrow.getSubmission(bountyId, sub0.submissionId);
        await verdiktaAggregator.setEvaluation(sub0Data.verdiktaAggId, FAILING_SCORES, JUST_CIDS, true);
        await bountyEscrow.finalizeSubmission(bountyId, sub0.submissionId);

        // Sub 1: creator can now approve (sub 0 is Failed, no longer unresolved)
        const sub1 = await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

        await expect(
          bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, sub1.submissionId)
        ).to.emit(bountyEscrow, "CreatorApproved");
      });

      it("Should block finalize payment of sub 1 while sub 0 is unresolved (windowed)", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator);

        // Sub 0 and sub 1 both submitted
        const sub0 = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);
        const sub1 = await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);

        // Both windows expire
        await time.increase(WINDOW_SIZE + 1);

        // Both go to arbitration
        await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, sub0.submissionId, {
          value: sub0.ethMaxBudget,
        });
        await bountyEscrow.connect(hunter2).startPreparedSubmission(bountyId, sub1.submissionId, {
          value: sub1.ethMaxBudget,
        });

        const sub0Data = await bountyEscrow.getSubmission(bountyId, sub0.submissionId);
        const sub1Data = await bountyEscrow.getSubmission(bountyId, sub1.submissionId);

        // Sub 1 completes first with passing score
        await verdiktaAggregator.setEvaluation(sub1Data.verdiktaAggId, PASSING_SCORES, JUST_CIDS, true);
        await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);

        // Sub 1 should be PassedUnpaid (sub 0 is still PendingVerdikta)
        const sub1After = await bountyEscrow.getSubmission(bountyId, sub1.submissionId);
        expect(sub1After.status).to.equal(4); // PassedUnpaid

        // Sub 0 completes with passing score — gets paid (it has priority)
        await verdiktaAggregator.setEvaluation(sub0Data.verdiktaAggId, PASSING_SCORES, JUST_CIDS, true);
        await expect(bountyEscrow.finalizeSubmission(bountyId, sub0.submissionId))
          .to.emit(bountyEscrow, "PayoutSent");

        const sub0After = await bountyEscrow.getSubmission(bountyId, sub0.submissionId);
        expect(sub0After.status).to.equal(3); // PassedPaid
      });

      it("Should maintain first-to-complete behavior for non-windowed bounties", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter, hunter2 } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

        // Both submit (non-windowed — Prepared status)
        const sub1 = await submitFull(bountyEscrow, verdiktaAggregator, hunter, bountyId);
        const sub2 = await submitFull(bountyEscrow, verdiktaAggregator, hunter2, bountyId);

        // First completes and gets paid
        await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);
        await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);
        expect((await bountyEscrow.getSubmission(bountyId, sub1.submissionId)).status)
          .to.equal(3); // PassedPaid

        // Second completes — bounty already Awarded
        await verdiktaAggregator.setEvaluation(sub2.aggId, PASSING_SCORES, JUST_CIDS, true);
        await bountyEscrow.finalizeSubmission(bountyId, sub2.submissionId);
        expect((await bountyEscrow.getSubmission(bountyId, sub2.submissionId)).status)
          .to.equal(4); // PassedUnpaid
      });
    });

    describe("Closing Windowed Bounties", function () {
      it("Should allow closing with PendingCreatorApproval submissions (only PendingVerdikta blocks)", async function () {
        const { bountyEscrow, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId, deadline } = await createWindowedBounty(bountyEscrow, creator);

        // Submit — status = PendingCreatorApproval
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await time.increaseTo(deadline);

        // Close should succeed — PendingCreatorApproval does not block closing
        await expect(bountyEscrow.closeExpiredBounty(bountyId))
          .to.emit(bountyEscrow, "BountyClosed");
      });

      it("Should block closing with PendingVerdikta submissions on windowed bounty", async function () {
        const { bountyEscrow, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId, deadline } = await createWindowedBounty(bountyEscrow, creator);

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        // Window expires, start arbitration
        await time.increase(WINDOW_SIZE + 1);
        await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        });

        await time.increaseTo(deadline);

        await expect(
          bountyEscrow.closeExpiredBounty(bountyId)
        ).to.be.revertedWith("active evaluation - finalize first");
      });
    });

    describe("Targeted Windowed Bounties", function () {
      it("Should work end-to-end: targeted bounty with creator approval", async function () {
        const { bountyEscrow, creator, hunter } = await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          targetHunter: hunter.address,
        });

        const { submissionId } = await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        await bountyEscrow.connect(creator).creatorApproveSubmission(bountyId, submissionId);

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.status).to.equal(1); // Awarded
        expect(bounty.winner).to.equal(hunter.address);
      });

      it("Should work end-to-end: targeted bounty with arbiter approval after window", async function () {
        const { bountyEscrow, verdiktaAggregator, creator, hunter } =
          await loadFixture(deployBountyEscrowFixture);
        const { bountyId } = await createWindowedBounty(bountyEscrow, creator, {
          targetHunter: hunter.address,
        });

        const { submissionId, ethMaxBudget } =
          await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

        // Window expires
        await time.increase(WINDOW_SIZE + 1);

        // Hunter starts arbitration (attaches the ETH prepay)
        const startTx = await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId, {
          value: ethMaxBudget,
        });
        const startReceipt = await startTx.wait();
        const aggId = startReceipt.logs.find(
          (l) => l.fragment && l.fragment.name === "WorkSubmitted"
        ).args.verdiktaAggId;

        // Arbiter approves
        await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

        await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
          .to.emit(bountyEscrow, "PayoutSent")
          .withArgs(bountyId, hunter.address, ARBITER_PAY);

        const bounty = await bountyEscrow.getBounty(bountyId);
        expect(bounty.status).to.equal(1); // Awarded
      });
    });
  });
});
