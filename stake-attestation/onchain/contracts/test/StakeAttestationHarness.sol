// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {StakeAttestation} from "../StakeAttestation.sol";
import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";

/// @dev Test harness: StakeAttestation plus setters for the bookkeeping the claim half (P2b-P2e)
///      maintains, so the listing half's refusals and transitions can be tested before those
///      nodes exist. Never deployed; the production contract has no such setter.
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

    /// @dev Stand-in for a P2c payout: moves escrow to `to`'s pull balance, so the contract's
    ///      balance still equals escrows plus pull balances.
    function harnessPayFromEscrow(uint256 listingId, address to, uint256 amount) external {
        _mustListing(listingId).escrowWei -= amount;
        withdrawable[to] += amount;
    }
}
