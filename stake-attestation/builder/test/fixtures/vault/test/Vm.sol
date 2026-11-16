// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The one cheatcode the fixture's tests use, so the fixture needs no forge-std checkout.
interface Vm {
    function assertEq(uint256 a, uint256 b) external pure;
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
