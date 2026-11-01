// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IPullLedger} from "./MockRejectingHunter.sol";

/// @dev Test stub, adapted from example-bounty-program's mock of the same name: a payout
///      recipient (maker, hunter or fee recipient) whose receive() consumes a configurable
///      amount of gas before accepting, or burns everything it is given. Used to verify that
///      the escrow's payout gas cap makes close-out and settlement cost independent of the
///      recipient, and that a recipient needing more than the cap is credited to the pull
///      ledger rather than paid directly. It acts on the escrow through `act`.
contract MockGasHungryRecipient {
    uint256 public gasToConsume;   // gas the receive() burns before accepting (0 = plain)
    bool    public burnAll;        // if true, receive() loops until out of gas
    uint256 public received;       // total ETH accepted via receive()

    function setGasToConsume(uint256 g) external { gasToConsume = g; }
    function setBurnAll(bool v) external { burnAll = v; }

    /// @notice Call `target` with `data`, forwarding msg.value; a revert bubbles up verbatim.
    function act(address target, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
    }

    function claim(address escrow) external {
        IPullLedger(escrow).withdraw();
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
