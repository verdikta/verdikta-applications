const hre = require("hardhat");
require("dotenv").config();
const { saveDeployment, copyAbiToFrontend } = require("./helpers");

async function main() {
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  const {
    VERDIKTA_AGGREGATOR,
    LINK_BASE_MAINNET,
    LINK_BASE_SEPOLIA
  } = process.env;

  if (!VERDIKTA_AGGREGATOR) {
    throw new Error("Please set VERDIKTA_AGGREGATOR in .env");
  }

  // Pick LINK by network
  let link;
  if (network === "base") {
    link = LINK_BASE_MAINNET;
  } else if (network === "base-sepolia") {
    link = LINK_BASE_SEPOLIA;
  } else {
    throw new Error(`Unsupported network ${network}. Use base or base-sepolia.`);
  }
  if (!link) throw new Error("Set LINK address in .env for this network");

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network : ${network} (${chainId})`);
  console.log(`LINK    : ${link}`);
  console.log(`Verdikta: ${VERDIKTA_AGGREGATOR}`);

  // Deploy BountyEscrow
  const Escrow = await hre.ethers.getContractFactory("BountyEscrow");
  const escrow = await Escrow.deploy(link, VERDIKTA_AGGREGATOR);
  await escrow.waitForDeployment();

  const escrowAddr = await escrow.getAddress();
  console.log(`\n✅ BountyEscrow deployed at: ${escrowAddr}`);

  // Save deployment JSON
  saveDeployment(network, chainId, {
    network,
    chainId,
    deployedAt: new Date().toISOString(),
    contracts: {
      BountyEscrow: escrowAddr,
      LINK: link,
      VerdiktaAggregator: VERDIKTA_AGGREGATOR
    }
  });

  // Export ABI for your front end
  copyAbiToFrontend("BountyEscrow");

  // Optional: verify automatically if API key is present
  if (process.env.BASESCAN_API_KEY) {
    console.log("⏳ Verifying on BaseScan...");
    try {
      await hre.run("verify:verify", {
        address: escrowAddr,
        constructorArguments: [link, VERDIKTA_AGGREGATOR]
      });
      console.log("🔎 Verified!");
    } catch (err) {
      console.log("⚠️  Verify failed:", err.message || err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

