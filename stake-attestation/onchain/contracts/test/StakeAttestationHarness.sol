// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {StakeAttestation} from "../StakeAttestation.sol";
import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";
import {ClaimLogic} from "../libraries/ClaimLogic.sol";

/// @dev Test harness: StakeAttestation plus setters for the bookkeeping the claim half (P2b-P2e)
///      maintains, so the listing half's refusals and transitions, and the claim lifecycle's
///      commit order, can be tested without running a claim through an aggregator round (the
///      settlement tests, P2c, use the real finalize and settle). Never deployed; the
///      production contract has no such setter.
contract StakeAttestationHarness is StakeAttestation {
    constructor(
        IVerdiktaAggregator verdikta_,
        address initialOwner,
        address feeRecipient_,
        uint256 listingFeeWei_
    ) StakeAttestation(verdikta_, initialOwner, feeRecipient_, listingFeeWei_) {}

    function harnessSetPendingClaims(uint256 listingId, uint256 n) external {
        _mustListing(listingId).pendingClaims = n;
    }

    function harnessSetOwed(uint256 listingId, uint256 owedWei) external {
        _mustListing(listingId).owedWei = owedWei;
    }

    function harnessSetState(uint256 listingId, ListingState s) external {
        _mustListing(listingId).state = s;
    }

    /// @dev Stand-in for a settlement payout: moves escrow to `to`'s pull balance, so the
    ///      contract's balance still equals escrows plus pull balances.
    function harnessPayFromEscrow(uint256 listingId, address to, uint256 amount) external {
        _mustListing(listingId).escrowWei -= amount;
        withdrawable[to] += amount;
    }

    /// @dev Stand-in for settle: the claim is Settled and leaves the commit-order queue through
    ///      the same ClaimLogic.resolve hook settle uses. Moves no funds.
    function harnessResolve(uint256 claimId) external {
        Claim storage c = _mustClaim(claimId);
        require(c.state != ClaimState.Settled && c.state != ClaimState.Expired, "already resolved");
        c.state = ClaimState.Settled;
        ClaimLogic.resolve(_claims, c, _listings[c.listingId]);
    }

    /// @dev Stand-in for settle recording a valid finding, which later requests carry (§13.3).
    function harnessAddValidFinding(uint256 listingId, uint256 claimId) external {
        _validFindings[listingId].push(claimId);
    }
}
