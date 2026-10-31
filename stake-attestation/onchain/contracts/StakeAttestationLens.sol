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
///   shared ClaimRules library, so the answers match what the contract enforces. `host` and
///   `verdikta` are immutables (code, not storage), so they hold under delegatecall too.
///   Created once by the host's constructor (msg.sender at construction is the host); no setter.
contract StakeAttestationLens {
    StakeAttestation public immutable host;
    IVerdiktaAggregator public immutable verdikta;

    constructor(IVerdiktaAggregator verdikta_) {
        host = StakeAttestation(msg.sender);
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

    function _revealableAt(StakeAttestation.Claim memory c, StakeAttestation.Listing memory l)
        private pure returns (uint256)
    {
        return ClaimRules.revealableAt(c.disclosedAt, c.fixWindowEnd, c.disclosedAfterRoll, l.rolledAt);
    }

    function _liveFee(StakeAttestation.Listing memory l) private view returns (uint256) {
        return verdikta.maxTotalFee(ClaimRules.effectiveFee(l.oracle.maxOracleFee, verdikta.maxOracleFee()));
    }
}
