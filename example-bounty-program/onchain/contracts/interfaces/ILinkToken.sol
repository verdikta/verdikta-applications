// Minimal interface definition for Chainlink LINK Token. Not deployed. Just used for ABI.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool success);
    function transferFrom(address from, address to, uint256 value) external returns (bool success);
    function approve(address spender, uint256 value) external returns (bool success);
    function allowance(address owner, address spender) external view returns (uint256 remaining);
    function balanceOf(address owner) external view returns (uint256 balance);
}
