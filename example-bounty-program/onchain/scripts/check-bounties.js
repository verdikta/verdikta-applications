const { ethers } = require("hardhat");

async function main() {
  const addr = "0x7612C6eC8Fb45035Ead117445B9d1F7759723536";
  const abi = [
    "function bountyCount() view returns (uint256)", 
    "function submissionCount(uint256) view returns (uint256)"
  ];
  const contract = await ethers.getContractAt(abi, addr);
  
  const bountyCount = await contract.bountyCount();
  console.log("Total bounties on new contract:", bountyCount.toString());
  
  for (let i = 0; i < bountyCount; i++) {
    const subCount = await contract.submissionCount(i);
    console.log("Bounty #" + i + " has " + subCount.toString() + " submissions");
  }
}

main().catch(console.error);
