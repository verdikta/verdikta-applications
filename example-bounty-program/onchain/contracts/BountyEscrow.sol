// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "./interfaces/ILinkToken.sol";
import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import "./EvaluationWallet.sol";

/// @title BountyEscrow
/// @notice Bounty escrow with four effective states: OPEN, EXPIRED, AWARDED, CLOSED
/// @dev No cancellation - creator can only reclaim funds after deadline via closeExpiredBounty
contract BountyEscrow {
    /// @notice On-chain storage states (3 values for gas efficiency)
    enum BountyStatus { 
        Open,    // 0: Active (maps to OPEN or EXPIRED based on deadline)
        Awarded, // 1: Winner has been paid
        Closed   // 2: Deadline passed, funds returned to creator
    }
    
    enum SubmissionStatus { 
        Prepared,         // Wallet created, awaiting LINK and start
        PendingVerdikta,  // Evaluation in progress
        Failed,           // Did not meet threshold
        PassedPaid,       // Met threshold and was paid
        PassedUnpaid      // Met threshold but someone else already won
    }

    struct Bounty {
        address creator;
        string  evaluationCid;      // IPFS CID for evaluation package (contains jury config, rubric ref, instructions)
        uint64  requestedClass;     // Verdikta class ID
        uint8   threshold;          // 0..100 acceptance threshold
        uint256 payoutWei;          // ETH locked
        uint256 createdAt;
        uint64  submissionDeadline; // Unix timestamp when submissions close
        BountyStatus status;
        address winner;
        uint256 submissions;        // count
    }

    struct Submission {
        address hunter;
        string  evaluationCid;      // Evaluation package CID (must match bounty's evaluationCid)
        string  hunterCid;          // Hunter's work product archive CID (bCID containing the actual submission)
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

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public subs;

    // ----------------- Events -----------------
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        string evaluationCid,
        uint64 classId,
        uint8 threshold,
        uint256 payoutWei,
        uint64 submissionDeadline
    );

    event BountyClosed(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountReturned
    );

    event SubmissionPrepared(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        address evalWallet,
        string evaluationCid,
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

    event PayoutSent(
        uint256 indexed bountyId, 
        address indexed winner, 
        uint256 amountWei
    );
    
    event LinkRefunded(
        uint256 indexed bountyId, 
        uint256 indexed submissionId, 
        uint256 amount
    );

    constructor(IERC20 _link, IVerdiktaAggregator _verdikta) {
        require(address(_link) != address(0) && address(_verdikta) != address(0), "zero addr");
        link = _link;
        verdikta = _verdikta;
    }

    // ------------- Bounty lifecycle -------------

    /// @notice Create a new bounty with ETH escrow
    function createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "no ETH");
        require(bytes(evaluationCid).length > 0, "empty evaluationCid");
        require(threshold <= 100, "bad threshold");
        require(submissionDeadline > block.timestamp, "deadline in past");

        bounties.push(Bounty({
            creator: msg.sender,
            evaluationCid: evaluationCid,
            requestedClass: requestedClass,
            threshold: threshold,
            payoutWei: msg.value,
            createdAt: block.timestamp,
            submissionDeadline: submissionDeadline,
            status: BountyStatus.Open,
            winner: address(0),
            submissions: 0
        }));

        bountyId = bounties.length - 1;
        emit BountyCreated(
            bountyId, 
            msg.sender, 
            evaluationCid, 
            requestedClass, 
            threshold, 
            msg.value, 
            submissionDeadline
        );
    }

    /// @notice Close an expired bounty and return funds to creator
    /// @dev Can be called by ANYONE after submissionDeadline passes
    /// @dev Requires no active evaluations (PendingVerdikta submissions)
    /// @param bountyId The bounty to close
    function closeExpiredBounty(uint256 bountyId) external {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "not open");
        require(block.timestamp >= b.submissionDeadline, "deadline not passed");
        
        // Check that no submissions are actively being evaluated
        uint256 subCount = subs[bountyId].length;
        for (uint256 i = 0; i < subCount; i++) {
            require(
                subs[bountyId][i].status != SubmissionStatus.PendingVerdikta,
                "active evaluation - finalize first"
            );
        }
        
        // All clear - return funds to creator
        b.status = BountyStatus.Closed;
        uint256 amt = b.payoutWei;
        b.payoutWei = 0;
        
        (bool ok,) = payable(b.creator).call{value: amt}("");
        require(ok, "eth send fail");
        
        emit BountyClosed(bountyId, b.creator, amt);
    }

    // ------------- Submissions & Verdikta -------------

    /// @notice STEP 1: Prepare a submission. Deploys an EvaluationWallet and records parameters.
    /// @dev The wallet address is emitted so the hunter can approve LINK to it.
    /// @dev Can only be called before the submission deadline
    /// @param bountyId The bounty to submit to
    /// @param evaluationCid The evaluation package CID (must match the bounty's stored evaluationCid)
    /// @param hunterCid The hunter's work product archive CID (bCID containing the actual submission)
    /// @param addendum Optional text addendum for the evaluation
    /// @param alpha Reputation weight (0-100)
    /// @param maxOracleFee Maximum fee per oracle
    /// @param estimatedBaseCost Estimated base cost
    /// @param maxFeeBasedScaling Maximum fee-based scaling
    function prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling
    ) external returns (uint256 submissionId, address evalWallet, uint256 linkMaxBudget) {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp < b.submissionDeadline, "deadline passed");
        require(bytes(evaluationCid).length > 0, "empty evaluationCid");
        require(bytes(hunterCid).length > 0, "empty hunterCid");
        
        // Verify evaluationCid matches the bounty's stored evaluationCid
        require(
            keccak256(bytes(evaluationCid)) == keccak256(bytes(b.evaluationCid)),
            "evaluationCid mismatch"
        );

        linkMaxBudget = verdikta.maxTotalFee(maxOracleFee);
        require(linkMaxBudget > 0, "bad budget");

        EvaluationWallet wallet = new EvaluationWallet(
            address(this), 
            msg.sender, 
            link, 
            verdikta
        );

        Submission memory s = Submission({
            hunter: msg.sender,
            evaluationCid: evaluationCid,
            hunterCid: hunterCid,
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
            evaluationCid,
            linkMaxBudget
        );

        return (submissionId, address(wallet), linkMaxBudget);
    }

    /// @notice STEP 2: After hunter has approved LINK to the EvaluationWallet,
    ///         start the Verdikta evaluation (pulls LINK into wallet, approves Verdikta, starts).
    /// @dev Can be called after deadline as long as submission was prepared before deadline
    function startPreparedSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(s.status == SubmissionStatus.Prepared, "not prepared");
        require(msg.sender == s.hunter, "only hunter");
        require(s.submittedAt < b.submissionDeadline, "submitted too late");

        EvaluationWallet wallet = EvaluationWallet(s.evalWallet);

        // Pull LINK from hunter into the wallet
        wallet.pullLinkFromHunter(s.linkMaxBudget);

        // Approve Verdikta and start evaluation
        wallet.approveVerdikta(s.linkMaxBudget);

        // CID array for Verdikta:
        // cids[0] = Evaluation package (contains jury config, rubric reference via 'additional', instructions)
        // cids[1] = Hunter's work product (bCID containing the actual submission to evaluate)
        // Note: The rubric is referenced inside the evaluation package manifest, not passed separately
        string[] memory cids = new string[](2);
        cids[0] = s.evaluationCid;
        cids[1] = s.hunterCid;

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

    /// @notice Finalize a submission by reading Verdikta results
    /// @dev If accepted and bounty still open, pay the hunter and mark bounty as Awarded
    /// @dev Can be called even after deadline (for submissions made before deadline)
    function finalizeSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");

        (uint256[] memory scores, string memory justCids, bool ok) = 
            verdikta.getEvaluation(s.verdiktaAggId);

        if (!ok) {
            // If timed out but not finalized on Verdikta, try to finalize there
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

        bool passed = _passed(acceptance, b.threshold);

        if (!passed) {
            s.status = SubmissionStatus.Failed;
            emit SubmissionFinalized(bountyId, submissionId, false, acceptance, rejection, justCids);
            _refundLeftoverLink(bountyId, submissionId);
            return;
        }

        // Passed evaluation
        emit SubmissionFinalized(bountyId, submissionId, true, acceptance, rejection, justCids);

        // Pay if bounty is still Open (first winner takes all)
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
            // Bounty already awarded or closed
            s.status = SubmissionStatus.PassedUnpaid;
        }

        _refundLeftoverLink(bountyId, submissionId);
    }

    /// @notice Force-fail a submission that's been stuck in PendingVerdikta too long
    /// @dev Can be called by anyone after 20 minutes timeout
    /// @dev Useful for submissions where Verdikta evaluation never started or oracle failed
    function failTimedOutSubmission(uint256 bountyId, uint256 submissionId) external {
        _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");
        require(block.timestamp >= s.submittedAt + 10 minutes, "timeout not reached");
        
        // Mark as failed
        s.status = SubmissionStatus.Failed;
        s.finalizedAt = block.timestamp;
        
        emit SubmissionFinalized(
            bountyId, 
            submissionId, 
            false,  // passed = false
            0,      // acceptance
            0,      // rejection
            "TIMED_OUT"
        );
        
        // Refund any LINK left in the wallet
        _refundLeftoverLink(bountyId, submissionId);
    }

    // ------------- Views -------------

    function bountyCount() external view returns (uint256) { 
        return bounties.length; 
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _mustBounty(bountyId);
    }

    function submissionCount(uint256 bountyId) external view returns (uint256) {
        return subs[bountyId].length;
    }

    function getSubmission(uint256 bountyId, uint256 submissionId) 
        external view returns (Submission memory) 
    {
        return _mustSubmission(bountyId, submissionId);
    }

    /// @notice Get the effective status of a bounty for frontend display
    /// @dev Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
    /// @return status One of four status strings
    function getEffectiveBountyStatus(uint256 bountyId) 
        external view returns (string memory) 
    {
        Bounty storage b = _mustBounty(bountyId);
        
        // Terminal states first
        if (b.status == BountyStatus.Awarded) return "AWARDED";
        if (b.status == BountyStatus.Closed) return "CLOSED";
        
        // Open enum, but check if deadline passed
        if (b.status == BountyStatus.Open) {
            if (block.timestamp >= b.submissionDeadline) {
                return "EXPIRED"; // Deadline passed, awaiting closeExpiredBounty
            }
            return "OPEN"; // Active, accepting submissions
        }
        
        return "UNKNOWN"; // Should never happen
    }

    /// @notice Check if a bounty is accepting NEW submissions
    /// @dev Returns true only if Open status AND before deadline
    function isAcceptingSubmissions(uint256 bountyId) external view returns (bool) {
        Bounty storage b = _mustBounty(bountyId);
        return b.status == BountyStatus.Open && block.timestamp < b.submissionDeadline;
    }

    /// @notice Check if a bounty can be closed (deadline passed, no active evals)
    function canBeClosed(uint256 bountyId) external view returns (bool) {
        Bounty storage b = _mustBounty(bountyId);
        
        if (b.status != BountyStatus.Open) return false;
        if (block.timestamp < b.submissionDeadline) return false;
        
        // Check for active evaluations
        uint256 subCount = subs[bountyId].length;
        for (uint256 i = 0; i < subCount; i++) {
            if (subs[bountyId][i].status == SubmissionStatus.PendingVerdikta) {
                return false;
            }
        }
        
        return true;
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

    function _mustSubmission(uint256 bountyId, uint256 submissionId) 
        internal view returns (Submission storage) 
    {
        require(submissionId < subs[bountyId].length, "bad submissionId");
        return subs[bountyId][submissionId];
    }

    /// @dev Interpret Verdikta scores: scores[0]=reject (DONT_FUND), scores[1]=accept (FUND)
    /// @dev Verdikta returns scores that sum to 1,000,000 (e.g., [120000, 880000] = 12% reject, 88% accept)
    /// @dev We normalize to 0-100 by dividing by 10,000 to match threshold scale
    function _interpretScores(uint256[] memory scores) 
        internal pure returns (uint256 accept, uint256 reject) 
    {
        require(scores.length == 2, "expected 2 scores from Verdikta");
        
        // Two scores from Verdikta: [DONT_FUND, FUND]
        // scores[0] = DONT_FUND (rejection score)
        // scores[1] = FUND (acceptance score)
        // Normalize from 0-1000000 to 0-100
        reject = scores[0] / 10000;
        accept = scores[1] / 10000;
        
        // Clamp to [0,100] just in case
        if (accept > 100) accept = 100;
        if (reject > 100) reject = 100;
        
        return (accept, reject);
    }

    /// @dev Pass rule: acceptance must meet or exceed threshold
    function _passed(uint256 acceptance, uint256 threshold) 
        internal pure returns (bool) 
    {
        return acceptance >= threshold;
    }

    receive() external payable {}
}

