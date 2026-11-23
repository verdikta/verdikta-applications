// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "../BountyEscrow.sol";

/// @dev Test stub: a payout recipient (hunter or creator) whose receive() consumes a
///      configurable amount of gas before accepting, or burns everything it is given.
///      Used to verify that the escrow's payout gas cap makes settlement cost independent
///      of the recipient, and that a recipient needing more than the cap is credited to
///      the pull ledger rather than paid directly.
contract MockGasHungryRecipient {
    uint256 public gasToConsume;   // gas the receive() burns before accepting (0 = plain)
    bool    public burnAll;        // if true, receive() loops until out of gas
    uint256 public received;       // total ETH accepted via receive()
    uint256 public lastSubId;
    uint256 public lastBudget;

    function setGasToConsume(uint256 g) external { gasToConsume = g; }
    function setBurnAll(bool v) external { burnAll = v; }

    // --- act as a hunter ---
    function prepare(address escrow, uint256 bountyId, string calldata evalCid, string calldata hunterCid) external {
        (uint256 sid, , uint256 budget) =
            BountyEscrow(payable(escrow)).prepareSubmission(bountyId, evalCid, hunterCid);
        lastSubId = sid;
        lastBudget = budget;
    }
    function start(address escrow, uint256 bountyId, uint256 subId) external {
        BountyEscrow(payable(escrow)).startPreparedSubmission{value: lastBudget}(bountyId, subId);
    }
    // --- act as a creator ---
    function createBounty(address escrow, string calldata evalCid, uint64 deadline) external payable returns (uint256) {
        BountyEscrow.CreateParams memory p = BountyEscrow.CreateParams({
            evaluationCid: evalCid,
            requestedClass: 128,
            threshold: 70,
            submissionDeadline: deadline,
            targetHunter: address(0),
            creatorDeterminationPayment: msg.value,
            arbiterDeterminationPayment: msg.value,
            creatorAssessmentWindowSize: 0,
            oracle: BountyEscrow.OracleParams({
                maxOracleFee: 2e13, alpha: 500, estimatedBaseCost: 0, maxFeeBasedScaling: 1,
                minOracleFee: 0, withBeacons: false
            }),
            jury: 0,
            quota: 1,
            forfeitLine: 0,
            bond: 0
        });
        return BountyEscrow(payable(escrow)).createBounty{value: msg.value}(p);
    }
    function claim(address escrow) external {
        BountyEscrow(payable(escrow)).withdraw();
    }

    receive() external payable {
        if (burnAll) {
            uint256 x;
            while (true) { x = x + 1; }   // runs until out of gas
        }
        uint256 start_ = gasleft();
        uint256 sink;
        while (start_ - gasleft() < gasToConsume) { sink = sink + 1; }
        received += msg.value;
    }

    // Plain funding for tests (bypasses the gas games)
    function fund() external payable {}
}
