// StakeAttestation (and its test harness) link the external library ClaimLogic, which holds the
// claim functions' bodies (contracts/libraries/ClaimLogic.sol): deploy it, then a linked factory.
const { ethers } = require("hardhat");

async function linkedFactory(name) {
  const lib = await (await ethers.getContractFactory("ClaimLogic")).deploy();
  return ethers.getContractFactory(name, { libraries: { ClaimLogic: await lib.getAddress() } });
}

module.exports = { linkedFactory };
