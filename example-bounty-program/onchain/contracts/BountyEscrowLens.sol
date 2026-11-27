// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import {BountyEscrow} from "./BountyEscrow.sol";
import {BountyRules} from "./BountyRules.sol";

/// @dev The beacon contract's view the aggregator reads (verdikta-dispatcher JuryBeacons.result):
///      state 2 = the quorum is in (draw), 3 = missed (the next draw ends the round).
interface IJuryBeaconsView {
    function result(address aggregator, bytes32 aggId)
        external view returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees);
}

/// @title BountyEscrowLens
/// @notice The BountyEscrow's read-only convenience views, kept in a separate contract so the
///         escrow's runtime bytecode stays under the EIP-170 size limit. Pure reads: no state,
///         no owner, no way to write anything.
/// @dev Two ways to call it, same answers:
///   1. AT THE ESCROW ADDRESS, with the escrow's merged ABI (escrow + lens). The escrow's
///      fallback forwards every selector it does not implement itself to this contract via a
///      STATICCALL-guarded delegatecall (see BountyEscrow.fallback / lensDelegate). Callers
///      need no second address and see no difference from a view living in the escrow.
///   2. Directly at this contract's address (`BountyEscrow.lens()`), e.g. from a block
///      explorer's read tab, where the escrow's verified source does not list these views.
///
///   Every read goes through the escrow's own external getters (getBounty, getSubmission,
///   activeEvaluations, ...), never raw storage slots, so there is no storage layout to keep in
///   sync between the two contracts. `escrow` is an immutable — part of the code, not
///   storage — so it is intact when this code runs under delegatecall. The aggregator is read
///   from the escrow (aggregator()), and a round's jury from the aggregator (getJury).
///
///   Created exactly once, by the escrow's constructor (msg.sender at construction IS the
///   escrow). There is no setter anywhere: the pair is fixed for life, like every other rule
///   of the escrow.
contract BountyEscrowLens {
    BountyEscrow public immutable escrow;

    /// @notice Page size cap for getBounties.
    uint256 public constant MAX_BATCH = 100;

    /// @notice A submission's current round as the aggregator sees it, and what the escrow's rule
    ///         (BountyRules) makes of it.
    struct OracleResult {
        bool started;              // a round has been started (an aggregation id exists)
        bool hasResult;            // the round has a result (finalizeSubmission will judge it)
        uint8 phase;               // the aggregator's phase (IVerdiktaAggregator); 0 if not started
        uint8 outcome;             // BountyRules.Outcome: 0 not ready, 1 no result, 2 pass, 3 soft fail, 4 hard fail
        uint8 rounds;              // rounds started for this submission (at most MAX_ROUNDS)
        uint256 passCount;         // scores >= threshold in this round's result (Q-of-N)
        uint256 deadline;          // the round's deadline (0 until drawn); settle is due after it
        uint256 requestTime;       // when the round was requested (draws stop a day later)
        uint256[] scores;          // the aggregated scores (see escrow.SCORE_SCALE()), empty if none
        string justificationCids;  // the result's justification CIDs, empty if none
    }

    constructor() {
        escrow = BountyEscrow(payable(msg.sender));
    }

    /// @dev Reached when the escrow forwards a selector that neither contract implements
    ///      (a mistyped function name, or an ABI from another release). A readable reason
    ///      instead of the empty revert data a missing selector would otherwise produce.
    fallback() external {
        revert("unknown function");
    }

    // ------------- Bounty views -------------

    /// @notice Get the effective status of a bounty for frontend display
    /// @dev Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
    /// @return status One of four status strings
    function getEffectiveBountyStatus(uint256 bountyId)
        external view returns (string memory)
    {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);

        // Terminal states first
        if (b.status == BountyEscrow.BountyStatus.Awarded) return "AWARDED";
        if (b.status == BountyEscrow.BountyStatus.Closed) return "CLOSED";

        // Open enum, but check if deadline passed
        if (b.status == BountyEscrow.BountyStatus.Open) {
            if (block.timestamp >= b.submissionDeadline) {
                return "EXPIRED"; // Deadline passed, awaiting closeExpiredBounty
            }
            return "OPEN"; // Active, accepting submissions
        }

        return "UNKNOWN"; // Should never happen
    }

    /// @notice Would prepareSubmission succeed for this bounty RIGHT NOW (ignoring who calls)?
    /// @dev Open, before the effective prepare cutoff (see prepareCutoff — on windowed bounties
    ///      the creator window must still fit before the deadline), and on windowed bounties
    ///      below MAX_SUBMISSIONS_PER_BOUNTY. Does NOT consider targetHunter: on a targeted
    ///      bounty only that address can prepare — compare it yourself.
    function isAcceptingSubmissions(uint256 bountyId) external view returns (bool) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        if (b.status != BountyEscrow.BountyStatus.Open) return false;
        if (block.timestamp > _prepareCutoff(b)) return false;
        if (b.creatorAssessmentWindowSize > 0 &&
            escrow.submissionCount(bountyId) >= escrow.MAX_SUBMISSIONS_PER_BOUNTY()) return false;
        return true;
    }

    /// @notice Check if a bounty can be closed (deadline passed, no active evals)
    function canBeClosed(uint256 bountyId) external view returns (bool) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);

        if (b.status != BountyEscrow.BountyStatus.Open) return false;
        if (block.timestamp < b.submissionDeadline) return false;

        // Nothing in evaluation or awaiting a re-run: closeExpiredBounty requires the pending
        // list to be empty (activeEvaluations alone misses AwaitingRerun submissions).
        return escrow.pendingSubmissionIds(bountyId).length == 0;
    }

    /// @notice The last timestamp at which prepareSubmission can succeed for this bounty:
    ///         deadline - 1 for plain bounties; on windowed bounties the creator window must
    ///         end at least two seconds before the deadline (one second to start), so it is
    ///         deadline - window - 2. May already be in the past. 0 if the bounty is not Open.
    function prepareCutoff(uint256 bountyId) external view returns (uint256) {
        return _prepareCutoff(escrow.getBounty(bountyId));
    }

    function _prepareCutoff(BountyEscrow.Bounty memory b) internal pure returns (uint256) {
        if (b.status != BountyEscrow.BountyStatus.Open) return 0;
        uint256 d = b.submissionDeadline;
        uint256 w = b.creatorAssessmentWindowSize;
        if (w == 0) return d - 1;
        return d > w + 2 ? d - w - 2 : 0;
    }

    /// @notice What startPreparedSubmission takes RIGHT NOW: requiredPrepay plus the hunter bond.
    function startValue(uint256 bountyId) external view returns (uint256) {
        return escrow.requiredPrepay(bountyId) + escrow.getBounty(bountyId).bond;
    }

    // ------------- Agent-facing views -------------
    // These exist so an agent can drive the whole lifecycle with ONLY the escrow's merged ABI
    // and a plain RPC: batch reads instead of one call per item, the oracle result without
    // the aggregator's ABI, and a single "what should I do now" answer per submission.

    /// @notice Every submission of a bounty in one call. Bounded by MAX_SUBMISSIONS_PER_BOUNTY
    ///         on windowed bounties only; a non-windowed bounty has no prepare cap, so an
    ///         indexer should prefer getSubmissionsPage there (this call is fine for the
    ///         ordinary handful of submissions, but a junk-flooded bounty can exceed an RPC
    ///         provider's eth_call gas allowance).
    function getSubmissions(uint256 bountyId)
        external view returns (BountyEscrow.Submission[] memory out)
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        uint256 n = escrow.submissionCount(bountyId);
        out = new BountyEscrow.Submission[](n);
        for (uint256 i = 0; i < n; i++) out[i] = escrow.getSubmission(bountyId, i);
    }

    /// @notice Up to MAX_BATCH submissions of a bounty starting at `start` (clamped to what
    ///         exists). An empty array means `start` is past the end. Page with
    ///         start += result.length; submission id == start + index.
    function getSubmissionsPage(uint256 bountyId, uint256 start, uint256 count)
        external view returns (BountyEscrow.Submission[] memory out)
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        uint256 n = escrow.submissionCount(bountyId);
        if (start >= n) return new BountyEscrow.Submission[](0);
        if (count > MAX_BATCH) count = MAX_BATCH;
        uint256 end = start + count;
        if (end > n) end = n;
        out = new BountyEscrow.Submission[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = escrow.getSubmission(bountyId, i);
    }

    /// @notice Up to MAX_BATCH bounties starting at `start` (clamped to what exists). An
    ///         empty array means `start` is past the end. Page with start += result.length.
    function getBounties(uint256 start, uint256 count)
        external view returns (BountyEscrow.Bounty[] memory out)
    {
        uint256 n = escrow.bountyCount();
        if (start >= n) return new BountyEscrow.Bounty[](0);
        if (count > MAX_BATCH) count = MAX_BATCH;
        uint256 end = start + count;
        if (end > n) end = n;
        out = new BountyEscrow.Bounty[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = escrow.getBounty(i);
    }

    /// @notice The oracle's view of a submission's current round, proxied so callers need no
    ///         aggregator ABI (see OracleResult).
    function getOracleResult(uint256 bountyId, uint256 submissionId)
        external view returns (OracleResult memory r)
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        BountyEscrow.Submission memory s = escrow.getSubmission(bountyId, submissionId);
        r.rounds = s.rounds;
        if (s.verdiktaAggId == bytes32(0)) return r;
        IVerdiktaAggregator agg = escrow.aggregator();
        r.started = true;
        BountyRules.Verdict memory v = BountyRules.judge(agg, s.verdiktaAggId, b.threshold, b.quota, b.forfeitLine);
        r.hasResult = v.hasResult;
        r.outcome = uint8(v.outcome);
        r.passCount = v.passCount;
        r.justificationCids = v.justificationCids;
        (r.scores, , ) = agg.getEvaluation(s.verdiktaAggId);
        (r.phase, , , , , , , , r.deadline, , , r.requestTime) = agg.getRoundInfo(s.verdiktaAggId);
    }

    /// @notice What can be done with a submission RIGHT NOW — the on-chain "diagnose".
    /// @dev Every label is the call that will SUCCEED now (not merely the state the submission
    ///      is in). Returns one of:
    ///   "START"          — startPreparedSubmission is callable (Prepared: by the hunter;
    ///                      expired-window PendingCreatorApproval: by anyone) — attach startValue()
    ///   "AWAIT_SLOT"     — a start or re-run would revert "evaluation slots full": wait for any
    ///                      round of the bounty to resolve
    ///   "AWAIT_CREATOR"  — in its creator window; only the creator can act (creatorApproveSubmission)
    ///   "DRAW"           — escrow.drawJury(bountyId, submissionId): the round is undrawn (from two
    ///                      blocks after its start), or its beacon stage has ended
    ///   "CLOSE_COMMITS"  — aggregator.closeCommits(aggId): T+ has passed with at least M commits
    ///   "PROMOTE"        — aggregator.promote(aggId): the commit phase is closed (from two blocks on,
    ///                      while blockhash(C+1) is in the 8,191-block history)
    ///   "AWAIT_ORACLE"   — the round is in progress (beacons, commits or reveals): wait
    ///   "AWAIT_EARLIER"  — a PASSING result exists but finalize would revert "earlier submission
    ///                      pending": a lower-index submission by another hunter still holds
    ///                      priority. Retry once it resolves (anyone may finalize, close or expire it)
    ///   "FINALIZE"       — call finalizeSubmission: the round has a result. A pass is paid (on an
    ///                      Awarded/Closed bounty it becomes PassedUnpaid), a soft fail awaits a
    ///                      re-run, a hard fail forfeits the bond
    ///   "CLOSE_FAILED"   — call closeFailedRound: the round failed, was cancelled, is past its
    ///                      deadline with no result, or can never be drawn
    ///   "RERUN"          — rerunSubmission (hunter or bond funder) with requiredPrepay()
    ///   "AWAIT_EXPIRY"   — awaiting a re-run that would revert (a LOWER-index round already
    ///                      passes, so it will be paid first): wait for the window, then EXPIRE_RERUN
    ///   "EXPIRE_RERUN"   — call expireRerun: the re-run window has closed (or can no longer re-run)
    ///   "RECOVER_REFUND" — resolved, but unspent prepay is still recoverable: recoverLeftoverEth
    ///   "DONE"           — resolved, nothing left to do
    ///   "DEAD"           — cannot be started (any more): deadline passed, bounty not open, or an
    ///                      in-flight round already passes (that one, or an earlier one, will be paid)
    function nextAction(uint256 bountyId, uint256 submissionId) external view returns (string memory) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        BountyEscrow.Submission memory s = escrow.getSubmission(bountyId, submissionId);
        BountyEscrow.SubmissionStatus st = s.status;
        bool open = b.status == BountyEscrow.BountyStatus.Open;
        IVerdiktaAggregator agg = escrow.aggregator();

        if (st == BountyEscrow.SubmissionStatus.Prepared ||
            st == BountyEscrow.SubmissionStatus.PendingCreatorApproval) {
            if (st == BountyEscrow.SubmissionStatus.PendingCreatorApproval &&
                block.timestamp <= s.creatorWindowEnd) {
                return open ? "AWAIT_CREATOR" : "DEAD";
            }
            if (!open || block.timestamp >= b.submissionDeadline) return "DEAD";
            if (_anyPassing(bountyId, b, agg, type(uint256).max)) return "DEAD";
            if (escrow.activeEvaluations(bountyId) >= escrow.MAX_ACTIVE_EVALUATIONS()) return "AWAIT_SLOT";
            return "START";
        }
        if (st == BountyEscrow.SubmissionStatus.PendingVerdikta) {
            BountyRules.Verdict memory v = BountyRules.judge(agg, s.verdiktaAggId, b.threshold, b.quota, b.forfeitLine);
            if (v.hasResult) {
                if (open && v.outcome == BountyRules.Outcome.Pass &&
                    _earlierPendingByOther(bountyId, submissionId, s.hunter)) {
                    return "AWAIT_EARLIER";
                }
                return "FINALIZE";
            }
            return _roundAction(agg, s.verdiktaAggId);
        }
        if (st == BountyEscrow.SubmissionStatus.AwaitingRerun) {
            if (block.timestamp > s.rerunDeadline || !open || block.timestamp >= b.submissionDeadline) {
                return "EXPIRE_RERUN";
            }
            if (s.rounds >= escrow.MAX_ROUNDS()) return "EXPIRE_RERUN";   // unreachable: never awaits then
            if (_anyPassing(bountyId, b, agg, submissionId)) return "AWAIT_EXPIRY";
            if (escrow.activeEvaluations(bountyId) >= escrow.MAX_ACTIVE_EVALUATIONS()) return "AWAIT_SLOT";
            return "RERUN";
        }
        // Resolved: Failed / PassedPaid / PassedUnpaid
        if (s.funder != address(0) &&
            (agg.ethOwed(s.evalWallet) > 0 || s.evalWallet.balance > 0)) {
            return "RECOVER_REFUND";
        }
        return "DONE";
    }

    /// @dev The call that moves a round without a result forward right now (see nextAction).
    function _roundAction(IVerdiktaAggregator agg, bytes32 aggId) internal view returns (string memory) {
        (uint8 phase, uint256 reqBlock, bytes32 sealedHash, uint256 closeBlock, , , , ,
         uint256 deadline, uint256 windowEnd, uint256 commits, uint256 reqTime) = agg.getRoundInfo(aggId);
        if (phase == BountyRules.PH_FAILED || phase == BountyRules.PH_CANCELLED) return "CLOSE_FAILED";
        if (phase == BountyRules.PH_DRAW || phase == BountyRules.PH_BEACON) {
            // cancelUnsealed's condition (and drawJury's 1-day limit, DRAW_GRACE)
            bool cancellable = sealedHash == bytes32(0)
                ? block.number > reqBlock + 1 + 8191
                : block.timestamp > reqTime + 1 days;
            if (cancellable) return "CLOSE_FAILED";
            if (block.timestamp > reqTime + 1 days) return "AWAIT_ORACLE";   // unsealed: cancel later
            if (phase == BountyRules.PH_DRAW) return block.number >= reqBlock + 2 ? "DRAW" : "AWAIT_ORACLE";
            try IJuryBeaconsView(agg.beacons()).result(address(agg), aggId) returns (
                uint8 state, bytes32, uint256, address[] memory
            ) {
                return state == 2 || state == 3 ? "DRAW" : "AWAIT_ORACLE";
            } catch {
                return "AWAIT_ORACLE";
            }
        }
        if (block.timestamp > deadline) return "CLOSE_FAILED";            // settle is due
        if (phase == BountyRules.PH_COMMIT) {
            (, uint8 m, , , ) = agg.getJury(aggId);
            return block.timestamp > windowEnd && commits >= m ? "CLOSE_COMMITS" : "AWAIT_ORACLE";
        }
        if (phase == BountyRules.PH_CLOSING) {
            // promote reads blockhash(C+1), readable for 8,191 blocks (SeedExpired after): then the
            // round can only fail at its deadline (CLOSE_FAILED above). A block early at that end, as a
            // transaction lands in the block after the one this view reads.
            return block.number >= closeBlock + 2 && block.number < closeBlock + 1 + 8191 ? "PROMOTE" : "AWAIT_ORACLE";
        }
        return "AWAIT_ORACLE";                                            // reveal
    }

    // ------------- Internals (mirror the escrow's rules; views only) -------------

    /// @dev Does any round in flight of the bounty, at an index below `below`, already pass
    ///      (BountyRules, Q-of-N)? (BountyEscrow._requireNoPassingSubmission's condition: `below`
    ///      is type(uint256).max for a first start, the submission's own index for a re-run.)
    function _anyPassing(uint256 bountyId, BountyEscrow.Bounty memory b, IVerdiktaAggregator agg, uint256 below)
        internal view returns (bool)
    {
        uint256[] memory pending = escrow.pendingSubmissionIds(bountyId);
        for (uint256 i = 0; i < pending.length; i++) {
            if (pending[i] >= below) continue;
            BountyEscrow.Submission memory e = escrow.getSubmission(bountyId, pending[i]);
            if (e.status == BountyEscrow.SubmissionStatus.PendingVerdikta &&
                BountyRules.passes(agg, e.verdiktaAggId, b.threshold, b.quota, b.forfeitLine)) return true;
        }
        return false;
    }

    /// @dev Does a lower-index submission by another hunter still hold priority (in evaluation or
    ///      awaiting a re-run)? (BountyEscrow._hasEarlierPendingByOther's condition.)
    function _earlierPendingByOther(uint256 bountyId, uint256 submissionId, address hunter)
        internal view returns (bool)
    {
        uint256[] memory pending = escrow.pendingSubmissionIds(bountyId);
        for (uint256 i = 0; i < pending.length; i++) {
            uint256 id = pending[i];
            if (id < submissionId && escrow.getSubmission(bountyId, id).hunter != hunter) return true;
        }
        return false;
    }
}
