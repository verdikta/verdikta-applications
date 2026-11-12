// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Minimal view of the pull ledger the escrow exposes.
interface IPullLedger {
    function withdraw() external;
}

/// @dev Test stub, adapted from example-bounty-program's mock of the same name: an actor
///      contract (maker, hunter or fee recipient) that can be toggled to reject incoming ETH.
///      Used to verify that close-outs, payouts and refunds never revert on a hostile or
///      ETH-incompatible recipient (they fall back to the pull-payment ledger instead).
///      It acts on the escrow through `act`, a plain forwarding call, so the same stub serves
///      every role and every later contract function without a typed wrapper per call.
contract MockRejectingHunter {
    bool public rejecting;

    function setRejecting(bool v) external { rejecting = v; }

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
        if (rejecting) revert("rejecting ETH");
    }
}
