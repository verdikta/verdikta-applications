// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IPullLedger} from "./MockRejectingHunter.sol";

/// @dev Test stub, adapted from example-bounty-program's mock of the same name: an actor
///      contract that, when paid, immediately re-enters the escrow with a configurable call and
///      records the outcome. Used to prove the nonReentrant guard fires on the ETH-moving entry
///      points and that the original payment still lands (the recipient does not revert).
contract MockReentrantRecipient {
    address public target;
    bytes   public attack;
    bool    public attempted;
    bool    public attackOk;
    bytes32 public attackReasonHash;   // keccak256 of the raw revert data of the re-entrant call

    function setAttack(address _target, bytes calldata data) external {
        target = _target;
        attack = data;
        attempted = false;
    }

    /// @notice Call `to` with `data`, forwarding msg.value; a revert bubbles up verbatim.
    function act(address to, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: msg.value}(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
    }

    function claim(address escrow) external {
        IPullLedger(escrow).withdraw();
    }

    receive() external payable {
        if (attack.length > 0 && !attempted) {
            attempted = true;
            (bool ok, bytes memory ret) = target.call(attack);
            attackOk = ok;
            attackReasonHash = keccak256(ret);
        }
    }
}
