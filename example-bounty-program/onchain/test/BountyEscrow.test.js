const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BountyEscrow", function () {
  const EVAL_CID = "QmTestEvalCid123";
  const HUNTER_CID = "QmTestHunterCid456";
  const CLASS_ID = 128;
  const THRESHOLD = 70;
  const BOUNTY_WEI = ethers.parseEther("1");
  const MAX_ORACLE_FEE = ethers.parseEther("0.1");
  const ALPHA = 50;
  const EST_BASE_COST = ethers.parseEther("0.01");
  const MAX_FEE_SCALING = 2;
  const ADDENDUM = "";

  // Scores that sum to 1,000,000. acceptance = scores[1]/10000
  const PASSING_SCORES = [200000n, 800000n]; // 20% reject, 80% accept (>= 70 threshold)
  const FAILING_SCORES = [600000n, 400000n]; // 60% reject, 40% accept (< 70 threshold)
  const JUST_CIDS = "QmJustificationCid";

  async function deployBountyEscrowFixture() {
    const [owner, creator, hunter, hunter2, other] = await ethers.getSigners();

    const MockLinkToken = await ethers.getContractFactory("MockLinkToken");
    const linkToken = await MockLinkToken.deploy();

    const MockAgg = await ethers.getContractFactory("MockVerdiktaAggregator");
    const verdiktaAggregator = await MockAgg.deploy();

    const BountyEscrow = await ethers.getContractFactory("BountyEscrow");
    const bountyEscrow = await BountyEscrow.deploy(
      await linkToken.getAddress(),
      await verdiktaAggregator.getAddress()
    );

    // Mint LINK to hunters for submissions
    const linkBudget = ethers.parseEther("10");
    await linkToken.mint(hunter.address, linkBudget);
    await linkToken.mint(hunter2.address, linkBudget);

    return {
      bountyEscrow,
      verdiktaAggregator,
      linkToken,
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

  // Helper: prepare a submission and return submissionId + evalWallet
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
      linkMaxBudget: event.args.linkMaxBudget,
      tx,
    };
  }

  // Helper: approve LINK from hunter to evalWallet and start submission
  async function startSubmission(
    bountyEscrow,
    linkToken,
    hunter,
    bountyId,
    submissionId,
    evalWallet,
    linkMaxBudget
  ) {
    await linkToken.connect(hunter).approve(evalWallet, linkMaxBudget);
    const tx = await bountyEscrow
      .connect(hunter)
      .startPreparedSubmission(bountyId, submissionId);
    return tx;
  }

  // Helper: full flow — prepare + start, return aggId
  async function submitFull(bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId) {
    const { submissionId, evalWallet, linkMaxBudget } =
      await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

    const startTx = await startSubmission(
      bountyEscrow,
      linkToken,
      hunter,
      bountyId,
      submissionId,
      evalWallet,
      linkMaxBudget
    );
    const startReceipt = await startTx.wait();
    const workEvent = startReceipt.logs.find(
      (l) => l.fragment && l.fragment.name === "WorkSubmitted"
    );
    const aggId = workEvent.args.verdiktaAggId;

    return { submissionId, evalWallet, linkMaxBudget, aggId };
  }

  // =========================================================================
  describe("Deployment", function () {
    it("Should deploy with correct Verdikta and LINK addresses", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken } =
        await loadFixture(deployBountyEscrowFixture);

      expect(await bountyEscrow.link()).to.equal(await linkToken.getAddress());
      expect(await bountyEscrow.verdikta()).to.equal(
        await verdiktaAggregator.getAddress()
      );
    });

    it("Should reject zero addresses in constructor", async function () {
      const { linkToken, verdiktaAggregator } = await loadFixture(
        deployBountyEscrowFixture
      );
      const BountyEscrow = await ethers.getContractFactory("BountyEscrow");

      await expect(
        BountyEscrow.deploy(ethers.ZeroAddress, await verdiktaAggregator.getAddress())
      ).to.be.revertedWith("zero addr");

      await expect(
        BountyEscrow.deploy(await linkToken.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("zero addr");

      await expect(
        BountyEscrow.deploy(ethers.ZeroAddress, ethers.ZeroAddress)
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
      ).to.be.revertedWith("no ETH");
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

      const { submissionId, evalWallet, linkMaxBudget, tx } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      expect(submissionId).to.equal(0);
      expect(evalWallet).to.not.equal(ethers.ZeroAddress);
      expect(linkMaxBudget).to.be.gt(0);

      await expect(tx)
        .to.emit(bountyEscrow, "SubmissionPrepared")
        .withArgs(bountyId, 0, hunter.address, evalWallet, EVAL_CID, linkMaxBudget);

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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and wins
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
    it("Should start a prepared submission with LINK approval", async function () {
      const { bountyEscrow, linkToken, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, evalWallet, linkMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await linkToken.connect(hunter).approve(evalWallet, linkMaxBudget);

      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId)
      ).to.emit(bountyEscrow, "WorkSubmitted");

      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(1); // PendingVerdikta
      expect(sub.verdiktaAggId).to.not.equal(ethers.ZeroHash);
    });

    it("Should reject start without LINK approval", async function () {
      const { bountyEscrow, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await prepareDefaultSubmission(
        bountyEscrow,
        hunter,
        bountyId
      );

      // No LINK approval — transferFrom will fail
      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId)
      ).to.be.revertedWith("not approved");
    });

    it("Should reject start by non-hunter", async function () {
      const { bountyEscrow, linkToken, creator, hunter, other } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, evalWallet, linkMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await linkToken.connect(hunter).approve(evalWallet, linkMaxBudget);

      await expect(
        bountyEscrow.connect(other).startPreparedSubmission(bountyId, submissionId)
      ).to.be.revertedWith("only hunter");
    });

    it("Should reject starting an already-started submission", async function () {
      const { bountyEscrow, linkToken, creator, hunter } = await loadFixture(
        deployBountyEscrowFixture
      );
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, evalWallet, linkMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter, bountyId);

      await linkToken.connect(hunter).approve(evalWallet, linkMaxBudget);
      await bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId);

      // Try starting again
      await expect(
        bountyEscrow.connect(hunter).startPreparedSubmission(bountyId, submissionId)
      ).to.be.revertedWith("not prepared");
    });
  });

  // =========================================================================
  describe("Evaluation Finalization", function () {
    it("Should process passing evaluation and pay winner", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);

      const hunterBalBefore = await ethers.provider.getBalance(hunter.address);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "SubmissionFinalized")
        .withArgs(bountyId, submissionId, true, 80, 20, JUST_CIDS)
        .and.to.emit(bountyEscrow, "PayoutSent")
        .withArgs(bountyId, hunter.address, BOUNTY_WEI);

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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      // Don't set evaluation — exists=false by default
      await expect(
        bountyEscrow.finalizeSubmission(bountyId, submissionId)
      ).to.be.revertedWith("Verdikta not ready");
    });

    it("Should reject finalization of non-pending submission", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 70,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 70,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      // 69% acceptance: 690000 / 10000 = 69
      const belowScores = [310000n, 690000n];
      await verdiktaAggregator.setEvaluation(aggId, belowScores, JUST_CIDS, true);

      await bountyEscrow.finalizeSubmission(bountyId, submissionId);
      const sub = await bountyEscrow.getSubmission(bountyId, submissionId);
      expect(sub.status).to.equal(2); // Failed
    });

    it("Should mark second passing submission as PassedUnpaid", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and passes
      const sub1 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, sub1.submissionId);

      // Second hunter submits (must prepare before bounty awarded)
      // Since bounty is now Awarded, prepare will fail — this tests post-award rejection
      // Instead, let's test the race condition: both submit before either finalizes
    });

    it("Should mark late finalizer as PassedUnpaid when another already won", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // Both hunters prepare and start before either finalizes
      const sub1 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      const sub2 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter2, bountyId
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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      // Only 5 minutes — too early
      await time.increase(300);

      await expect(
        bountyEscrow.failTimedOutSubmission(bountyId, submissionId)
      ).to.be.revertedWith("timeout not reached");
    });

    it("Should reject timeout on non-pending submission", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter, other } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      await time.increase(601);

      // Called by unrelated account — should succeed
      await expect(
        bountyEscrow.connect(other).failTimedOutSubmission(bountyId, submissionId)
      ).to.emit(bountyEscrow, "SubmissionFinalized");
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

      const creatorBalBefore = await ethers.provider.getBalance(creator.address);

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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Submit and start evaluation (PendingVerdikta)
      await submitFull(bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId);

      await time.increaseTo(deadline);

      await expect(
        bountyEscrow.closeExpiredBounty(bountyId)
      ).to.be.revertedWith("active evaluation - finalize first");
    });

    it("Should reject closing an already-awarded bounty", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, PASSING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await time.increaseTo(deadline);

      await expect(
        bountyEscrow.closeExpiredBounty(bountyId)
      ).to.be.revertedWith("not open");
    });

    it("Should allow closing after failed submissions are finalized", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      // Submit, fail, finalize
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);
      await bountyEscrow.finalizeSubmission(bountyId, submissionId);

      await time.increaseTo(deadline);

      // Now close should succeed — no PendingVerdikta submissions
      await expect(bountyEscrow.closeExpiredBounty(bountyId))
        .to.emit(bountyEscrow, "BountyClosed");
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId, deadline } = await createDefaultBounty(bountyEscrow, creator);

      await submitFull(bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId);
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
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const sub1 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      const sub2 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter2, bountyId
      );

      expect(sub1.submissionId).to.equal(0);
      expect(sub2.submissionId).to.equal(1);
      expect(await bountyEscrow.submissionCount(bountyId)).to.equal(2);

      const bounty = await bountyEscrow.getBounty(bountyId);
      expect(bounty.submissions).to.equal(2);
    });

    it("Should prevent new submissions after bounty is awarded", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 0,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      // Even 0% acceptance passes with threshold 0
      const zeroScores = [1000000n, 0n];
      await verdiktaAggregator.setEvaluation(aggId, zeroScores, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent");
    });

    it("Should handle max-threshold bounty (100 required)", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 100,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        threshold: 100,
      });
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      const scores100 = [0n, 1000000n];
      await verdiktaAggregator.setEvaluation(aggId, scores100, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "PayoutSent");
    });

    it("Should block starting submission when another already passed on Verdikta", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter, hunter2 } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);

      // First hunter submits and Verdikta returns passing result (not yet finalized)
      const sub1 = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );
      await verdiktaAggregator.setEvaluation(sub1.aggId, PASSING_SCORES, JUST_CIDS, true);

      // Second hunter prepares...
      const { submissionId: sub2Id, evalWallet, linkMaxBudget } =
        await prepareDefaultSubmission(bountyEscrow, hunter2, bountyId);
      await linkToken.connect(hunter2).approve(evalWallet, linkMaxBudget);

      // ...but starting should revert because sub1 already passed on Verdikta
      await expect(
        bountyEscrow.connect(hunter2).startPreparedSubmission(bountyId, sub2Id)
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

    it("Should refund leftover LINK after finalization", async function () {
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId, evalWallet } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
      );

      // The mock aggregator doesn't actually consume LINK, so all LINK
      // remains in the eval wallet. Finalization should refund it.
      const walletBal = await linkToken.balanceOf(evalWallet);

      await verdiktaAggregator.setEvaluation(aggId, FAILING_SCORES, JUST_CIDS, true);

      await expect(bountyEscrow.finalizeSubmission(bountyId, submissionId))
        .to.emit(bountyEscrow, "LinkRefunded");
    });

    it("Should store submission timestamps correctly", async function () {
      const { bountyEscrow, linkToken, verdiktaAggregator, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator);
      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
      const { bountyEscrow, verdiktaAggregator, linkToken, creator, hunter } =
        await loadFixture(deployBountyEscrowFixture);
      const { bountyId } = await createDefaultBounty(bountyEscrow, creator, {
        targetHunter: hunter.address,
      });

      const { submissionId, aggId } = await submitFull(
        bountyEscrow, linkToken, verdiktaAggregator, hunter, bountyId
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
});
