// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../src/Vault.sol";
import {Base} from "./Vm.sol";

contract VaultTest is Base {
    function test_deposit_credits() public {
        Vault v = new Vault();
        v.deposit(1);
        require(v.balanceOf(address(this)) > 0, "no credit");
    }

    function test_owner_is_deployer() public {
        Vault v = new Vault();
        require(v.owner() == address(this), "owner");
    }
}
