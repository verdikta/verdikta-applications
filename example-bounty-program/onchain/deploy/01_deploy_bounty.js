const hre = require("hardhat");
require("dotenv").config();
const { saveDeployment, copyAbiToFrontend } = require("./helpers");

async function main() {
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  
  const {
    LINK_TOKEN_BASE,
    LINK_TOKEN_BASE_SEPOLIA,
    VERDIKTA_AGGREGATOR_BASE,         // Added
    VERDIKTA_AGGREGATOR_BASE_SEPOLIA  // Added
  } = process.env;

  // Pick LINK by network
  let link;
  let verdikta;  // Added
  
  if (network === "base") {
    link = LINK_TOKEN_BASE;
    verdikta = VERDIKTA_AGGREGATOR_BASE;  // Added
  } else if (network === "base_sepolia") {
    link = LINK_TOKEN_BASE_SEPOLIA;
    verdikta = VERDIKTA_AGGREGATOR_BASE_SEPOLIA;  // Added
  } else {
    throw new Error(`Unsupported network ${network}. Use base or base_sepolia.`);
  }

  if (!link) throw new Error("Set LINK address in .env for this network");
  if (!verdikta) throw new Error("Set VERDIKTA_AGGREGATOR address in .env for this network");  // Added

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network : ${network} (${chainId})`);
  console.log(`LINK    : ${link}`);
  console.log(`Verdikta: ${verdikta}`);  // Changed from VERDIKTA_AGGREGATOR

  // Deploy BountyEscrow
  const Escrow = await hre.ethers.getContractFactory("BountyEscrow");
  const escrow = await Escrow.deploy(link, verdikta);  // Changed from VERDIKTA_AGGREGATOR
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();

  console.log(`\n BountyEscrow deployed at: ${escrowAddr}`);

  // Save deployment JSON
  saveDeployment(network, chainId, {
    network,
    chainId,
    deployedAt: new Date().toISOString(),
    contracts: {
      BountyEscrow: escrowAddr,
      LINK: link,
      VerdiktaAggregator: verdikta  // Changed from VERDIKTA_AGGREGATOR
    }
  });

  // Export ABI for your front end
  copyAbiToFrontend("BountyEscrow");

  // Optional: verify automatically if API key is present
  if (process.env.BASESCAN_API_KEY) {
    console.log("Verifying on BaseScan...");
    try {
      await hre.run("verify:verify", {
        address: escrowAddr,
        constructorArguments: [link, verdikta]  // Changed from VERDIKTA_AGGREGATOR
      });
      console.log("Verified!");
    } catch (err) {
      console.log("Verify failed:", err.message || err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

