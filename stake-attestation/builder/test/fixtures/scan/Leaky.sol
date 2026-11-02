// SPDX-License-Identifier: MIT
// The baseline scan's Docker test fixture: one planted instance of each rule in scan-rules/solidity.yml,
// and, in Checked, the same calls written safely, which must raise nothing.
pragma solidity ^0.8.20;

interface IERC20 { function transfer(address to, uint256 v) external returns (bool); function transferFrom(address f, address to, uint256 v) external returns (bool); }

contract Leaky {
    mapping(address => uint256) public balances;
    address public owner;
    IERC20 public token;

    constructor() { owner = msg.sender; }

    function deposit() external payable { balances[msg.sender] += msg.value; }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
        balances[msg.sender] = 0;
    }

    function withdraw2(uint256 amount) external {
        payable(msg.sender).call{value: amount}("");
        balances[msg.sender] -= amount;
    }

    function sweep(address to) external {
        require(tx.origin == owner, "owner");
        payable(to).transfer(address(this).balance);
    }

    function pay(address to, uint256 v) external {
        token.transfer(to, v);
        token.transferFrom(msg.sender, to, v);
    }

    function lottery() external view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(block.timestamp, msg.sender))) % 10;
    }

    function lottery2() external view returns (uint256) {
        return uint256(blockhash(block.number - 1)) % 10;
    }

    function run(address impl, bytes calldata data) external {
        (bool ok, ) = impl.delegatecall(data);
        require(ok);
    }

    function kill() external { selfdestruct(payable(msg.sender)); }

    function rawSend(address to) external { to.call(""); }
}

contract Puller {
    IERC20 public token;
    function pull(address from, address to, uint256 v) external {
        token.transferFrom(from, to, v);
    }
    function pullSelf(address to, uint256 v) external {
        require(token.transferFrom(msg.sender, to, v), "tf");
    }
    function sendIt(address payable to) external {
        to.call{value: 1}("");
        (bool ok, ) = to.call("");
        require(ok);
    }
}

contract Checked {
    IERC20 public token;
    function a(address to, uint256 v) external returns (bool) {
        bool ok = token.transfer(to, v);
        if (!token.transfer(to, v)) revert();
        return token.transfer(to, v);
    }
    function b(address payable to) external {
        (bool ok, bytes memory data) = to.call("");
        require(ok && data.length == 0);
        if (!payable(to).send(1)) revert();
    }
}
