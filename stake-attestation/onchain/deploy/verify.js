// Verify a StakeAttestation deployment on BaseScan, as example-bounty-program's deploy/verify.js:
//
//   ETHERSCAN_API_KEY=... npx hardhat run deploy/verify.js --network base_sepolia
//
// Reads deployments/<chainId>-<network>.json, which 01_deploy_stake_attestation.js wrote, and
// verifies the two libraries, StakeAttestation (with its constructor arguments and links), the
// lens and the EvaluationWallet implementation.
const hre = require("hardhat");
const { readDeployment } = require("./helpers");
const { verifyDeployment } = require("./01_deploy_stake_attestation");

async function main() {
  if (!process.env.ETHERSCAN_API_KEY) throw new Error("Set ETHERSCAN_API_KEY in the environment");
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const out = readDeployment(chainId, hre.network.name);
  await verifyDeployment(hre, out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
