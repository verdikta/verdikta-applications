// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import {StakeAttestation} from "./StakeAttestation.sol";
import {ClaimRules} from "./libraries/ClaimRules.sol";

/// @title StakeAttestationLens
/// @notice StakeAttestation's derived, read-only views, kept in a separate contract so the main
///         contract's runtime bytecode stays under the EIP-170 limit as later nodes add
///         settlement, disputes and the record. Pure reads: no state, no owner, no way to write.
/// @dev Mirrors example-bounty-program's BountyEscrowLens. Two ways to call it, same answers:
///   1. AT THE StakeAttestation ADDRESS, with the merged ABI (contract + lens): the contract's
///      fallback forwards every selector it does not implement to this code through a
///      STATICCALL-guarded delegatecall (StakeAttestation.fallback / lensDelegate).
///   2. Directly at this contract's address (StakeAttestation.lens()), e.g. from an explorer.
///   Every read goes through the host's external getters (getClaim, getListing), never raw
///   storage, so there is no storage layout to keep in step; the time and fee rules are the
///   shared ClaimRules library, so the answers match what the contract enforces. The record
///   (recordByHash, recordPage) is read by the host's linked RecordLogic through recordData and
///   decoded here. `host` and `verdikta` are immutables (code, not storage), so they hold under
///   delegatecall too.
///   Created once by the host's constructor (msg.sender at construction is the host); no setter.
contract StakeAttestationLens {
    StakeAttestation public immutable host;
    IVerdiktaAggregator public immutable verdikta;

    constructor(IVerdiktaAggregator verdikta_) {
        host = StakeAttestation(payable(msg.sender));
        verdikta = verdikta_;
    }

    /// @dev Reached when the host forwards a selector neither contract implements: a readable
    ///      reason instead of empty revert data.
    fallback() external {
        revert("unknown function");
    }

    /// @notice A claim's state as of now. The stored state, except that a Committed claim whose
    ///         fix window has ended (by time, release or roll-forward) is Revealable. Revealable
    ///         says nothing about commit order: a revealable claim still waits for every earlier
    ///         claim on its listing to be settled or expired (see claimTimes.revealDeadline).
    function claimState(uint256 claimId) external view returns (StakeAttestation.ClaimState) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        if (c.state != StakeAttestation.ClaimState.Committed) return c.state;
        StakeAttestation.Listing memory l = host.getListing(c.listingId);
        return block.timestamp >= _revealableAt(c, l)
            ? StakeAttestation.ClaimState.Revealable
            : StakeAttestation.ClaimState.Committed;
    }

    /// @notice The deadlines that govern a claim.
    /// @return discloseDeadline committedAt + DISCLOSE_WINDOW: disclose before it; an undisclosed
    ///                          claim may be expired from it on
    /// @return revealableAt     when the fix window ends (0 while undisclosed)
    /// @return revealDeadline   reveal before it; an unrevealed claim may be expired from it on.
    ///                          0 while it is unknown: undisclosed, or an earlier claim on the
    ///                          listing is still unresolved (decision D5: the clock waits)
    function claimTimes(uint256 claimId)
        external view returns (uint256 discloseDeadline, uint256 revealableAt, uint256 revealDeadline)
    {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        StakeAttestation.Listing memory l = host.getListing(c.listingId);
        discloseDeadline = uint256(c.committedAt) + ClaimRules.DISCLOSE_WINDOW;
        if (c.disclosedAt == 0) return (discloseDeadline, 0, 0);
        revealableAt = _revealableAt(c, l);
        if (l.headClaim == claimId) {
            revealDeadline = ClaimRules.revealDeadline(revealableAt, l.headSince, l.revealWindow);
        }
    }

    /// @notice What commit() takes now: the listing's bond plus the aggregator's live
    ///         maxTotalFee for the listing's (clamped) oracle fee. More is accepted and kept as
    ///         prepay; it funds the evaluation and its unspent part comes back.
    function commitPrice(uint256 listingId) external view returns (uint256) {
        StakeAttestation.Listing memory l = host.getListing(listingId);
        return l.bondWei + _liveFee(l);
    }

    /// @notice The ETH reveal() needs on top of the claim's prepay now (erratum E3): the live
    ///         maxTotalFee less the prepay, or 0 when the prepay already covers it.
    function revealTopUp(uint256 claimId) external view returns (uint256) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        uint256 live = _liveFee(host.getListing(c.listingId));
        return live > c.prepayWei ? live - c.prepayWei : 0;
    }

    /// @notice How a jury vector would settle under a listing's terms: the rule finalize and
    ///         settle apply (ClaimRules.judge and awardFor), for a site or tool to preview.
    /// @return wellFormed false when the vector is no verdict (finalize would fail the round)
    /// @return outcome    the settled outcome (INVALID when not wellFormed)
    /// @return awardWei   the award the outcome earns: awards[class] at or above
    ///                    lowestClassCounted, else 0 (what settle pays, before any shortfall)
    function judgeVector(uint256 listingId, uint256[] calldata vector)
        external view returns (bool wellFormed, StakeAttestation.Outcome outcome, uint256 awardWei)
    {
        StakeAttestation.Listing memory l = host.getListing(listingId);
        uint8 o;
        (wellFormed, o) = ClaimRules.judge(vector);
        outcome = StakeAttestation.Outcome(o);
        if (wellFormed) awardWei = ClaimRules.awardFor(l.awards, uint8(l.lowestClassCounted), o);
    }

    /// @notice When settle() accepts a Judged claim: at once (judgedAt) for INVALID and
    ///         DUPLICATE, at the end of the dispute window for a valid outcome, at once
    ///         (disputeEndedAt) once a dispute of it ended. 0 for a claim that is not Judged
    ///         (a Disputed claim waits for its dispute round's finalize).
    function settleableAt(uint256 claimId) external view returns (uint256) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        if (c.state != StakeAttestation.ClaimState.Judged) return 0;
        if (c.dispute != StakeAttestation.DisputeResult.None) return c.disputeEndedAt;
        if (uint8(c.outcome) < ClaimRules.LOW) return c.judgedAt;
        return uint256(c.judgedAt) + host.getListing(c.listingId).disputeWindow;
    }

    /// @notice What dispute() takes now: the aggregator's live maxTotalFee for the listing's
    ///         (clamped) disputeMaxOracleFee. More is accepted; it funds the dispute's request
    ///         and its unspent part comes back to the maker.
    function disputeFee(uint256 listingId) external view returns (uint256) {
        StakeAttestation.Listing memory l = host.getListing(listingId);
        return verdikta.maxTotalFee(ClaimRules.effectiveFee(l.oracle.disputeMaxOracleFee, verdikta.maxOracleFee()));
    }

    /// @notice The maker may dispute the claim before this time: judgedAt + disputeWindow for a
    ///         Judged, valid, undisputed claim; 0 when no dispute is possible (not Judged,
    ///         INVALID or DUPLICATE, or disputed already: one dispute per claim).
    function disputeDeadline(uint256 claimId) external view returns (uint256) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        if (
            c.state != StakeAttestation.ClaimState.Judged || uint8(c.outcome) < ClaimRules.LOW
                || c.dispute != StakeAttestation.DisputeResult.None
        ) return 0;
        return uint256(c.judgedAt) + host.getListing(c.listingId).disputeWindow;
    }

    /// @notice A RoundFailed claim's re-trigger window (erratum E6): the hunter may retrigger
    ///         before this time, and anyone may expire the claim from it on (the bond to the
    ///         maker if a round ran, roundStarted; else back to the hunter). 0 unless RoundFailed.
    function retriggerDeadline(uint256 claimId) external view returns (uint256) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        if (c.state != StakeAttestation.ClaimState.RoundFailed) return 0;
        return ClaimRules.retriggerDeadline(c.failedAt, host.getListing(c.listingId).revealWindow);
    }

    /// @notice The ETH retrigger() needs now: the live maxTotalFee less the prepay a refused
    ///         submission left held (a round that ran spent its prepay, so a fresh one is due in
    ///         full). 0 for a claim that is not RoundFailed.
    function retriggerTopUp(uint256 claimId) external view returns (uint256) {
        StakeAttestation.Claim memory c = host.getClaim(claimId);
        if (c.state != StakeAttestation.ClaimState.RoundFailed) return 0;
        uint256 held = c.requestId == bytes32(0) ? c.prepayWei : 0;
        uint256 live = _liveFee(host.getListing(c.listingId));
        return live > held ? live - held : 0;
    }

    /// @notice Whether lateClaim (decision D6) takes a claim on the listing now: its stake ended,
    ///         Rolled, or Closed after it opened. commitPrice quotes what it takes, as for a commit.
    function acceptsLateClaims(uint256 listingId) external view returns (bool) {
        StakeAttestation.Listing memory l = host.getListing(listingId);
        return l.state == StakeAttestation.ListingState.Rolled
            || (l.state == StakeAttestation.ListingState.Closed && l.openedAt != 0);
    }

    // ------------------------------------------------------------------
    //                    the record (design §4.1, §13.4; P2e)
    // ------------------------------------------------------------------

    /// @notice The record of an artifact hash: every listing of it that opened, in opening
    ///         order (one never funded had no stake; listingsByHash lists it), each with its
    ///         state, times, lapsed, invited, award table, bond, escrow, owed, value at risk,
    ///         lineage with the neighbours' hashes and its own counts; `active` (those not
    ///         Closed); the artifact's kind; the history summed over them (claims, pending,
    ///         settled by outcome, released, undisclosed, unrevealed, no verdict, disputes and
    ///         their results, and `later`: late claims, their outcomes and expiries); every
    ///         valid finding (class, paid, owed, revealed-at, settled-at, bcid, dispute result,
    ///         late or not) and every bad-disclosure flag (with the claim's state and outcome).
    ///         Facts only: labels are computed off-chain.
    ///         Gas grows with the history (a few storage reads per listing, finding and flag);
    ///         page a long one with recordPage.
    function recordByHash(bytes32 artifactHash) external view returns (StakeAttestation.Record memory) {
        return _record(artifactHash, 0, type(uint256).max, 0, type(uint256).max);
    }

    /// @notice recordByHash for a page: the listings [listingOffset, listingOffset +
    ///         listingLimit) of the hash, their summed history, and of the findings and the
    ///         flags the entries [itemOffset, itemOffset + itemLimit) of each list's
    ///         concatenation over those listings (listing order, then settlement or flag order).
    ///         findingCount and flagCount are the lists' totals over the page's listings, so a
    ///         client pages items until itemOffset reaches both; listingCount is the hash's, so
    ///         it pages listings until listingOffset reaches it, summing the histories.
    function recordPage(
        bytes32 artifactHash,
        uint256 listingOffset,
        uint256 listingLimit,
        uint256 itemOffset,
        uint256 itemLimit
    ) external view returns (StakeAttestation.Record memory) {
        return _record(artifactHash, listingOffset, listingLimit, itemOffset, itemLimit);
    }

    function _record(
        bytes32 artifactHash,
        uint256 listingOffset,
        uint256 listingLimit,
        uint256 itemOffset,
        uint256 itemLimit
    ) private view returns (StakeAttestation.Record memory) {
        return abi.decode(
            host.recordData(artifactHash, listingOffset, listingLimit, itemOffset, itemLimit), (StakeAttestation.Record)
        );
    }

    function _revealableAt(StakeAttestation.Claim memory c, StakeAttestation.Listing memory l)
        private pure returns (uint256)
    {
        return ClaimRules.revealableAt(c.disclosedAt, c.fixWindowEnd, c.disclosedAfterRoll, l.rolledAt);
    }

    function _liveFee(StakeAttestation.Listing memory l) private view returns (uint256) {
        return verdikta.maxTotalFee(ClaimRules.effectiveFee(l.oracle.maxOracleFee, verdikta.maxOracleFee()));
    }
}
