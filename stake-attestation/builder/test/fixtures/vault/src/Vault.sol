// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A deliberately small vault for the builder's fixtures: deposits credit one wei too many.
contract Vault {
    address public immutable owner;
    mapping(address => uint256) public balanceOf;

    constructor() {
        owner = msg.sender;
    }

    function deposit(uint256 amount) external {
        balanceOf[msg.sender] += amount + 1;
    }
}
