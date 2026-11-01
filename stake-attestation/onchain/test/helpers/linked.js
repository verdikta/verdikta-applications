// StakeAttestation (and its test harness) link external libraries: ClaimLogic, which holds the
// claim functions' bodies, and RecordLogic, which reads the record (contracts/libraries/). Deploy
// every library the artifact links, then return a factory linked to them. The deploy script
// (deploy/01_deploy_stake_attestation.js) does the same, ClaimLogic first.
const hre = require("hardhat");
const { ethers } = hre;

// The libraries `name` links, as the compiler recorded them (linkReferences): ClaimLogic first,
// then the rest by name.
async function linkedLibraries(name) {
  const artifact = await hre.artifacts.readArtifact(name);
  const libs = [...new Set(Object.values(artifact.linkReferences).flatMap((l) => Object.keys(l)))];
  return libs.sort((a, b) => (a === "ClaimLogic" ? -1 : b === "ClaimLogic" ? 1 : a < b ? -1 : 1));
}

async function linkedFactory(name) {
  const libraries = {};
  for (const lib of await linkedLibraries(name)) {
    libraries[lib] = await (await (await ethers.getContractFactory(lib)).deploy()).getAddress();
  }
  return ethers.getContractFactory(name, { libraries });
}

module.exports = { linkedFactory, linkedLibraries };
