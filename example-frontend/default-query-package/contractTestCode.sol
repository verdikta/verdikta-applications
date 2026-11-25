pragma solidity ^0.8.0;

contract Test {
    function transfer(address to) public {
        // Vulnerable to reentrancy attack
        to.call{value: 100}("");
    }
}
