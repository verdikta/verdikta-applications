// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "./interfaces/ILinkToken.sol";
import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import "./EvaluationWallet.sol";

/// @title VerdiktaBountyEscrow
/// @notice Bounty escrow that: (1) locks ETH, (2) prepares a submission wallet,
///         (3) starts Verdikta after hunter approves LINK to that wallet,
///         (4) finalizes by reading Verdikta scores and auto-paying if passed.
contract VerdiktaBountyEscrow {
    enum BountyStatus { Open, Awarded, Cancelled }
    enum SubmissionStatus { Prepared, PendingVerdikta, Failed, PassedPaid, PassedUnpaid }

    struct Bounty {
        address creator;
        string  rubricCid;          // IPFS CID for rubric JSON
        uint64  requestedClass;     // Verdikta class ID
        uint8   threshold;          // 0..100 acceptance threshold
        uint256 payoutWei;          // ETH locked
        uint256 createdAt;
        BountyStatus status;
        address winner;
        uint256 submissions;        // count
    }

    struct Submission {
        address hunter;
        string  deliverableCid;
        address evalWallet;
        bytes32 verdiktaAggId;      // set once started
        SubmissionStatus status;
        uint256 acceptance;         // stored acceptance (0..100)
        uint256 rejection;          // stored rejection (0..100)
        string  justificationCids;  // Verdikta result, if any
        uint256 submittedAt;
        uint256 finalizedAt;
        uint256 linkMaxBudget;      // LINK budget computed from maxOracleFee
        uint256 maxOracleFee;       // echo
        uint256 alpha;              // echo
        uint256 estimatedBaseCost;  // echo
        uint256 maxFeeBasedScaling; // echo
        string  addendum;           // echo
    }

    IERC20 public immutable link;
    IVerdiktaAggregator public immutable verdikta;

    uint256 public cancelLockSeconds = 1 days;

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public subs;

    // ----------------- Events -----------------
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        string rubricCid,
        uint64 classId,
        uint8 threshold,
        uint256 payoutWei
    );

    event BountyCancelled(uint256 indexed bountyId);

    event SubmissionPrepared(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        address evalWallet,
        string deliverableCid,
        uint256 linkMaxBudget
    );

    event WorkSubmitted(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bytes32 verdiktaAggId
    );

    event SubmissionFinalized(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bool passed,
        uint256 acceptance,
        uint256 rejection,
        string justificationCids
    );

    event PayoutSent(uint256 indexed bountyId, address indexed winner, uint256 amountWei);
    event LinkRefunded(uint256 indexed bountyId, uint256 indexed submissionId, uint256 amount);

    constructor(IERC20 _link, IVerdiktaAggregator _verdikta) {
        require(address(_link) != address(0) && address(_verdikta) != address(0), "zero addr");
        link = _link;
        verdikta = _verdikta;
    }

    // ------------- Bounty lifecycle -------------

    function createBounty(
        string calldata rubricCid,
        uint64  requestedClass,
        uint8   threshold
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "no ETH");
        require(bytes(rubricCid).length > 0, "empty rubric");
        require(threshold <= 100, "bad threshold");

        bounties.push(Bounty({
            creator: msg.sender,
            rubricCid: rubricCid,
            requestedClass: requestedClass,
            threshold: threshold,
            payoutWei: msg.value,
            createdAt: block.timestamp,
            status: BountyStatus.Open,
            winner: address(0),
            submissions: 0
        }));

        bountyId = bounties.length - 1;
        emit BountyCreated(bountyId, msg.sender, rubricCid, requestedClass, threshold, msg.value);
    }

    function cancelBounty(uint256 bountyId) external {
        Bounty storage b = _mustBounty(bountyId);
        require(msg.sender == b.creator, "not creator");
        require(b.status == BountyStatus.Open, "not open");
        require(block.timestamp >= b.createdAt + cancelLockSeconds, "locked");

        b.status = BountyStatus.Cancelled;
        uint256 amt = b.payoutWei;
        b.payoutWei = 0;

        (bool ok,) = payable(b.creator).call{value: amt}("");
        require(ok, "eth send fail");
        emit BountyCancelled(bountyId);
    }

    // ------------- Submissions & Verdikta -------------

    /// @notice STEP 1: Prepare a submission. Deploys an EvaluationWallet and records parameters.
    ///         The wallet address is emitted so the hunter can approve LINK to it.
    function prepareSubmission(
        uint256 bountyId,
        string calldata deliverableCid,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling
    ) external returns (uint256 submissionId, address evalWallet, uint256 linkMaxBudget) {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty closed");
        require(bytes(deliverableCid).length > 0, "empty deliverable");

        linkMaxBudget = verdikta.maxTotalFee(maxOracleFee);
        require(linkMaxBudget > 0, "bad budget");

        EvaluationWallet wallet = new EvaluationWallet(address(this), msg.sender, link, verdikta);

        Submission memory s = Submission({
            hunter: msg.sender,
            deliverableCid: deliverableCid,
            evalWallet: address(wallet),
            verdiktaAggId: bytes32(0),
            status: SubmissionStatus.Prepared,
            acceptance: 0,
            rejection: 0,
            justificationCids: "",
            submittedAt: block.timestamp,
            finalizedAt: 0,
            linkMaxBudget: linkMaxBudget,
            maxOracleFee: maxOracleFee,
            alpha: alpha,
            estimatedBaseCost: estimatedBaseCost,
            maxFeeBasedScaling: maxFeeBasedScaling,
            addendum: addendum
        });

        subs[bountyId].push(s);
        submissionId = subs[bountyId].length - 1;
        b.submissions += 1;

        emit SubmissionPrepared(
            bountyId,
            submissionId,
            msg.sender,
            address(wallet),
            deliverableCid,
            linkMaxBudget
        );

        return (submissionId, address(wallet), linkMaxBudget);
    }

    /// @notice STEP 2: After hunter has approved LINK to the EvaluationWallet,
    ///         start the Verdikta evaluation (pulls LINK into wallet, approves Verdikta, starts).
    function startPreparedSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(s.status == SubmissionStatus.Prepared, "not prepared");
        require(msg.sender == s.hunter, "only hunter");

        EvaluationWallet wallet = EvaluationWallet(s.evalWallet);

        // Pull LINK from hunter into the wallet (requires ERC-20 approval to the wallet)
        wallet.pullLinkFromHunter(s.linkMaxBudget);

        // Approve Verdikta and start evaluation (wallet will be msg.sender to Verdikta)
        wallet.approveVerdikta(s.linkMaxBudget);

        string[] memory cids;
        cids[0] = s.deliverableCid;
        cids[1] = b.rubricCid;

        bytes32 aggId = wallet.startEvaluation(
            cids,
            s.addendum,
            s.alpha,
            s.maxOracleFee,
            s.estimatedBaseCost,
            s.maxFeeBasedScaling,
            b.requestedClass
        );

        s.verdiktaAggId = aggId;
        s.status = SubmissionStatus.PendingVerdikta;

        emit WorkSubmitted(bountyId, submissionId, aggId);
    }

    /// @notice Finalize a submission by reading Verdikta. If accepted and bounty open,
    ///         pay the hunter and close the bounty. Refund leftover LINK in any case.
    function finalizeSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");

        (uint256[] memory scores, string memory justCids, bool ok) = verdikta.getEvaluation(s.verdiktaAggId);

        if (!ok) {
            // If timed out but not finalized on Verdikta, try to finalize there and retry read.
            try verdikta.finalizeEvaluationTimeout(s.verdiktaAggId) {
                (scores, justCids, ok) = verdikta.getEvaluation(s.verdiktaAggId);
            } catch { /* ignore */ }
        }
        require(ok, "Verdikta not ready");

        (uint256 acceptance, uint256 rejection) = _interpretScores(scores);
        s.acceptance = acceptance;
        s.rejection  = rejection;
        s.justificationCids = justCids;
        s.finalizedAt = block.timestamp;

        bool passed = _passed(acceptance, rejection, b.threshold);

        if (!passed) {
            s.status = SubmissionStatus.Failed;
            emit SubmissionFinalized(bountyId, submissionId, false, acceptance, rejection, justCids);
            _refundLeftoverLink(bountyId, submissionId);
            return;
        }

        // Passed
        emit SubmissionFinalized(bountyId, submissionId, true, acceptance, rejection, justCids);

        if (b.status == BountyStatus.Open) {
            uint256 pay = b.payoutWei;
            b.payoutWei = 0;
            b.status = BountyStatus.Awarded;
            b.winner = s.hunter;

            (bool okPay,) = payable(s.hunter).call{value: pay}("");
            require(okPay, "eth payout failed");
            s.status = SubmissionStatus.PassedPaid;

            emit PayoutSent(bountyId, s.hunter, pay);
        } else {
            s.status = SubmissionStatus.PassedUnpaid; // someone else already won
        }

        _refundLeftoverLink(bountyId, submissionId);
    }

    // ------------- Views -------------

    function bountyCount() external view returns (uint256) { return bounties.length; }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _mustBounty(bountyId);
    }

    function submissionCount(uint256 bountyId) external view returns (uint256) {
        return subs[bountyId].length;
    }

    function getSubmission(uint256 bountyId, uint256 submissionId) external view returns (Submission memory) {
        return _mustSubmission(bountyId, submissionId);
    }

    // ------------- Admin knobs -------------

    function setCancelLock(uint256 seconds_) external {
        require(seconds_ >= 1 hours && seconds_ <= 7 days, "unreasonable");
        cancelLockSeconds = seconds_;
    }

    // ------------- Internals -------------

    function _refundLeftoverLink(uint256 bountyId, uint256 submissionId) private {
        Submission storage s = subs[bountyId][submissionId];
        uint256 before = IERC20(link).balanceOf(s.evalWallet);
        EvaluationWallet(s.evalWallet).refundLeftoverLink();
        uint256 afterBal = IERC20(link).balanceOf(s.evalWallet);
        uint256 delta = before > afterBal ? before - afterBal : 0;
        emit LinkRefunded(bountyId, submissionId, delta);
    }

    function _mustBounty(uint256 bountyId) internal view returns (Bounty storage) {
        require(bountyId < bounties.length, "bad bountyId");
        return bounties[bountyId];
    }

    function _mustSubmission(uint256 bountyId, uint256 submissionId) internal view returns (Submission storage) {
        require(submissionId < subs[bountyId].length, "bad submissionId");
        return subs[bountyId][submissionId];
    }

    /// @dev Interpret Verdikta scores where typically scores[0]=accept, scores[1]=reject, sum ≈100.
    function _interpretScores(uint256[] memory scores) internal pure returns (uint256 accept, uint256 reject) {
        if (scores.length == 0) return (0, 0);
        if (scores.length == 1) {
            uint256 a = scores[0];
            if (a > 100) a = 100;
            // best-effort reject complement if caller expects two numbers
            uint256 r = 100 > a ? 100 - a : 0;
            return (a, r);
        }
        // take first two; clamp to [0,100]
        accept = scores[0] > 100 ? 100 : scores[0];
        reject = scores[1] > 100 ? 100 : scores[1];
        return (accept, reject);
    }

    /// @dev Pass rule: acceptance >= threshold AND acceptance >= rejection.
    function _passed(uint256 acceptance, uint256 rejection, uint256 threshold) internal pure returns (bool) {
        return (acceptance >= threshold) && (acceptance >= rejection);
    }

    receive() external payable {}
}

