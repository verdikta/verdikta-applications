// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "../BountyEscrow.sol";

/// @dev Test stub: a "hunter" contract that can be toggled to reject incoming ETH.
///      Used to verify that payout / refund / bounty-close never revert on a hostile or
///      ETH-incompatible recipient (they fall back to the pull-payment ledger instead).
contract MockRejectingHunter {
    bool    public rejecting;
    uint256 public lastSubId;
    address public lastWallet;
    uint256 public lastBudget;

    function setRejecting(bool v) external { rejecting = v; }

    function prepare(
        address escrow,
        uint256 bountyId,
        string calldata evalCid,
        string calldata hunterCid
    ) external {
        // 1e14 = 0.0001 ETH maxOracleFee, 1e13 = 0.00001 ETH base cost, x3 scaling.
        (uint256 sid, address w, uint256 budget) =
            BountyEscrow(payable(escrow)).prepareSubmission(
                bountyId, evalCid, hunterCid, "", 500, 1e14, 1e13, 3
            );
        lastSubId = sid;
        lastWallet = w;
        lastBudget = budget;
    }

    function start(address escrow, uint256 bountyId, uint256 subId) external {
        BountyEscrow(payable(escrow)).startPreparedSubmission{value: lastBudget}(bountyId, subId);
    }

    function claim(address escrow) external {
        BountyEscrow(payable(escrow)).withdraw();
    }

    receive() external payable {
        if (rejecting) revert("rejecting ETH");
    }
}
