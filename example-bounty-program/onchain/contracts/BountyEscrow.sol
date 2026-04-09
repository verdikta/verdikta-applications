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
        Prepared,               // 0: Wallet created, awaiting LINK and start
        PendingVerdikta,        // 1: Evaluation in progress
        Failed,                 // 2: Did not meet threshold
        PassedPaid,             // 3: Met threshold and was paid
        PassedUnpaid,           // 4: Met threshold but someone else already won
        PendingCreatorApproval  // 5: Awaiting creator approval during window
    }

    struct Bounty {
        address creator;
        string  evaluationCid;      // IPFS CID for evaluation package (contains jury config, rubric ref, instructions)
        uint64  requestedClass;     // Verdikta class ID
        uint8   threshold;          // 0..100 acceptance threshold
        uint256 payoutWei;          // ETH locked (max of two payment amounts)
        uint256 createdAt;
        uint64  submissionDeadline; // Unix timestamp when submissions close
        BountyStatus status;
        address winner;
        uint256 submissions;        // count
        address targetHunter;       // address(0) = open to all, otherwise only this address can submit
        uint256 creatorDeterminationPayment;  // Payment if creator approves
        uint256 arbiterDeterminationPayment;  // Payment if arbiters approve via Verdikta
        uint64  creatorAssessmentWindowSize;  // Window duration in seconds (0 = no window)
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
        uint64  creatorWindowEnd;   // Timestamp when creator window expires (0 if no window)
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

    event CreatorApproved(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        uint256 amountPaid
    );

    event CreatorRefunded(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountRefunded
    );

    constructor(IERC20 _link, IVerdiktaAggregator _verdikta) {
        require(address(_link) != address(0) && address(_verdikta) != address(0), "zero addr");
        link = _link;
        verdikta = _verdikta;
    }

    // ------------- Bounty lifecycle -------------

    /// @notice Create a bounty with ETH escrow (backward-compatible, no creator window)
    /// @param targetHunter The only address allowed to submit; address(0) = open to all
    function createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter
    ) external payable returns (uint256 bountyId) {
        return _createBounty(
            evaluationCid, requestedClass, threshold, submissionDeadline,
            targetHunter, msg.value, msg.value, 0
        );
    }

    /// @notice Create a bounty with creator approval window and split payment amounts
    /// @param targetHunter The only address allowed to submit; address(0) = open to all
    /// @param creatorDeterminationPayment Payment amount if creator approves during window
    /// @param arbiterDeterminationPayment Payment amount if arbiters approve via Verdikta
    /// @param creatorAssessmentWindowSize Window duration in seconds after submission (0 = no window)
    function createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter,
        uint256 creatorDeterminationPayment,
        uint256 arbiterDeterminationPayment,
        uint64  creatorAssessmentWindowSize
    ) external payable returns (uint256 bountyId) {
        return _createBounty(
            evaluationCid, requestedClass, threshold, submissionDeadline,
            targetHunter, creatorDeterminationPayment, arbiterDeterminationPayment,
            creatorAssessmentWindowSize
        );
    }

    function _createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter,
        uint256 creatorDeterminationPayment,
        uint256 arbiterDeterminationPayment,
        uint64  creatorAssessmentWindowSize
    ) internal returns (uint256 bountyId) {
        require(creatorDeterminationPayment > 0, "no creator payment");
        require(arbiterDeterminationPayment > 0, "no arbiter payment");
        require(
            msg.value == _max(creatorDeterminationPayment, arbiterDeterminationPayment),
            "ETH must equal max payment"
        );
        require(bytes(evaluationCid).length > 0, "empty evaluationCid");
        require(threshold <= 100, "bad threshold");
        require(submissionDeadline > block.timestamp, "deadline in past");
        require(
            creatorAssessmentWindowSize > 0 || creatorDeterminationPayment == arbiterDeterminationPayment,
            "window required when payments differ"
        );

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
            submissions: 0,
            targetHunter: targetHunter,
            creatorDeterminationPayment: creatorDeterminationPayment,
            arbiterDeterminationPayment: arbiterDeterminationPayment,
            creatorAssessmentWindowSize: creatorAssessmentWindowSize
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
    /// @dev If the bounty has a creator assessment window, status starts as PendingCreatorApproval.
    /// @dev Otherwise, status starts as Prepared (classic behavior).
    /// @dev Can only be called before the submission deadline
    /// @param bountyId The bounty to submit to
    /// @param evaluationCid The evaluation package CID (must match the bounty's stored evaluationCid)
    /// @param hunterCid The hunter's work product archive CID (bCID containing the actual submission)
    /// @param addendum Optional text addendum for the evaluation
    /// @param alpha Reputation weight (0-1000, see ReputationKeeper)
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
        if (b.targetHunter != address(0)) {
            require(msg.sender == b.targetHunter, "bounty is targeted");
        }
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

        bool hasWindow = b.creatorAssessmentWindowSize > 0;

        Submission memory s = Submission({
            hunter: msg.sender,
            evaluationCid: evaluationCid,
            hunterCid: hunterCid,
            evalWallet: address(wallet),
            verdiktaAggId: bytes32(0),
            status: hasWindow
                ? SubmissionStatus.PendingCreatorApproval
                : SubmissionStatus.Prepared,
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
            addendum: addendum,
            creatorWindowEnd: hasWindow
                ? uint64(block.timestamp) + b.creatorAssessmentWindowSize
                : 0
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

    /// @notice Creator approves a submission during the assessment window
    /// @dev Pays creatorDeterminationPayment to hunter, refunds excess to creator
    /// @dev Blocked if any earlier submission is unresolved (PendingCreatorApproval or PendingVerdikta)
    function creatorApproveSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(msg.sender == b.creator, "only creator");
        require(b.status == BountyStatus.Open, "bounty not open");
        require(s.status == SubmissionStatus.PendingCreatorApproval, "not pending creator approval");
        require(block.timestamp <= s.creatorWindowEnd, "window expired");
        require(
            !_hasEarlierUnresolvedSubmission(bountyId, submissionId),
            "earlier submission unresolved"
        );

        uint256 pay = b.creatorDeterminationPayment;
        uint256 refund = b.payoutWei - pay;

        b.payoutWei = 0;
        b.status = BountyStatus.Awarded;
        b.winner = s.hunter;
        s.status = SubmissionStatus.PassedPaid;
        s.finalizedAt = block.timestamp;

        (bool okPay,) = payable(s.hunter).call{value: pay}("");
        require(okPay, "eth payout failed");

        emit CreatorApproved(bountyId, submissionId, s.hunter, pay);
        emit PayoutSent(bountyId, s.hunter, pay);

        if (refund > 0) {
            (bool okRefund,) = payable(b.creator).call{value: refund}("");
            require(okRefund, "refund to creator failed");
            emit CreatorRefunded(bountyId, b.creator, refund);
        }
    }

    /// @notice STEP 2: After LINK is approved to the EvaluationWallet,
    ///         start the Verdikta evaluation (pulls LINK, approves Verdikta, starts).
    /// @dev For Prepared submissions (no window): only the hunter can call, LINK from hunter.
    /// @dev For PendingCreatorApproval submissions (window expired): anyone can call, LINK from caller.
    /// @dev Can be called after deadline as long as submission was prepared before deadline
    /// @dev Reverts if any existing submission has already passed evaluation (first-to-pass wins)
    function startPreparedSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(b.status == BountyStatus.Open, "bounty not open");

        bool fromCreatorWindow = s.status == SubmissionStatus.PendingCreatorApproval;

        if (fromCreatorWindow) {
            // After window expires, anyone can start arbitration and fund LINK
            require(block.timestamp > s.creatorWindowEnd, "creator window still open");
        } else {
            require(s.status == SubmissionStatus.Prepared, "not prepared");
            require(msg.sender == s.hunter, "only hunter");
        }

        require(s.submittedAt < b.submissionDeadline, "submitted too late");

        // Check if any existing submission has already passed on Verdikta
        // This prevents wasting LINK when someone else already won
        _requireNoPassingSubmission(bountyId, b.threshold);

        EvaluationWallet wallet = EvaluationWallet(s.evalWallet);

        // Pull LINK: from hunter for Prepared, from msg.sender for PendingCreatorApproval
        if (fromCreatorWindow) {
            wallet.pullLinkFrom(msg.sender, s.linkMaxBudget);
        } else {
            wallet.pullLinkFromHunter(s.linkMaxBudget);
        }

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
    /// @dev If accepted and bounty still open, pay arbiterDeterminationPayment and refund excess to creator
    /// @dev For windowed bounties, payment blocked if earlier submission is unresolved
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

        // Pay if bounty is still Open AND submission has priority
        if (b.status == BountyStatus.Open) {
            bool blocked;
            if (b.creatorAssessmentWindowSize > 0) {
                // Windowed bounties: priority ordering by submission index
                blocked = _hasEarlierUnresolvedSubmission(bountyId, submissionId);
            } else {
                // Non-windowed bounties: first-to-complete-evaluation wins
                blocked = _hasOtherPassingSubmission(bountyId, submissionId, b.threshold);
            }

            if (!blocked) {
                uint256 pay = b.arbiterDeterminationPayment;
                uint256 refund = b.payoutWei - pay;

                b.payoutWei = 0;
                b.status = BountyStatus.Awarded;
                b.winner = s.hunter;

                (bool okPay,) = payable(s.hunter).call{value: pay}("");
                require(okPay, "eth payout failed");
                s.status = SubmissionStatus.PassedPaid;

                emit PayoutSent(bountyId, s.hunter, pay);

                if (refund > 0) {
                    (bool okRefund,) = payable(b.creator).call{value: refund}("");
                    require(okRefund, "refund to creator failed");
                    emit CreatorRefunded(bountyId, b.creator, refund);
                }
            } else {
                // Another submission has priority or already passed
                s.status = SubmissionStatus.PassedUnpaid;
            }
        } else {
            // Bounty already awarded or closed
            s.status = SubmissionStatus.PassedUnpaid;
        }

        _refundLeftoverLink(bountyId, submissionId);
    }

    /// @notice Force-fail a submission that's been stuck in PendingVerdikta too long
    /// @dev Can be called by anyone after 10 minutes timeout
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

    /// @dev Check that no existing submission has already passed evaluation on Verdikta
    /// @dev This queries Verdikta directly since scores aren't stored until finalization
    function _requireNoPassingSubmission(uint256 bountyId, uint256 threshold) internal view {
        uint256 subCount = subs[bountyId].length;

        for (uint256 i = 0; i < subCount; i++) {
            Submission storage existing = subs[bountyId][i];

            // Skip non-pending submissions (already finalized or just prepared)
            if (existing.status != SubmissionStatus.PendingVerdikta) {
                continue;
            }

            // Query Verdikta for this submission's evaluation result
            (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(existing.verdiktaAggId);

            // If evaluation is complete, check if it passed
            if (ok && scores.length == 2) {
                uint256 acceptance = scores[1] / 10000; // Normalize to 0-100
                if (acceptance > 100) acceptance = 100;

                if (acceptance >= threshold) {
                    revert("another submission already passed - finalize it first");
                }
            }
        }
    }

    /// @dev Check if any OTHER submission (not the current one) has already passed on Verdikta
    /// @dev Used at finalization for non-windowed bounties to ensure "first to complete evaluation wins"
    function _hasOtherPassingSubmission(
        uint256 bountyId,
        uint256 currentSubmissionId,
        uint256 threshold
    ) internal view returns (bool) {
        uint256 subCount = subs[bountyId].length;

        for (uint256 i = 0; i < subCount; i++) {
            // Skip the current submission we're finalizing
            if (i == currentSubmissionId) {
                continue;
            }

            Submission storage other = subs[bountyId][i];

            // Check if already finalized as passed
            if (other.status == SubmissionStatus.PassedPaid ||
                other.status == SubmissionStatus.PassedUnpaid) {
                return true;
            }

            // Check if pending but already completed with passing score on Verdikta
            if (other.status == SubmissionStatus.PendingVerdikta) {
                (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(other.verdiktaAggId);

                if (ok && scores.length == 2) {
                    uint256 acceptance = scores[1] / 10000; // Normalize to 0-100
                    if (acceptance > 100) acceptance = 100;

                    if (acceptance >= threshold) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// @dev Check if any earlier submission (lower index) is still unresolved
    /// @dev Used for windowed bounties to enforce priority ordering at payment time
    function _hasEarlierUnresolvedSubmission(
        uint256 bountyId,
        uint256 submissionId
    ) internal view returns (bool) {
        for (uint256 i = 0; i < submissionId; i++) {
            SubmissionStatus st = subs[bountyId][i].status;
            if (st == SubmissionStatus.PendingCreatorApproval ||
                st == SubmissionStatus.PendingVerdikta) {
                return true;
            }
        }
        return false;
    }

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

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    receive() external payable {}
}
