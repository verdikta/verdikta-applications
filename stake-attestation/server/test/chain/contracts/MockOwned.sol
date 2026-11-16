// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title MockOwned
/// @notice A deployment with an owner() (EIP-173's read), for the control-proof tests (node P8).
contract MockOwned {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function transferOwnership(address next) external {
        owner = next;
    }
}

/// @notice A deployment with no owner(): only its deployer can prove control of it.
contract MockOwnerless {
    uint256 public value = 1;
}

/// @notice A deployment whose owner() answers something that is not an address.
contract MockBadOwner {
    function owner() external pure returns (uint256) {
        return type(uint256).max;
    }
}
