const hre = require("hardhat");
require("dotenv").config();

async function main() {
  console.log("🚀 Deploying BountyEscrow contract...\n");

  // Get deployer account
  const [deployer] = await hre.ethers.getSigners();
  console.log("📝 Deploying from account:", deployer.address);
  console.log("💰 Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString(), "\n");

  // Get contract addresses from environment
  const verdiktaAggregatorAddress = process.env.VERDIKTA_AGGREGATOR_ADDRESS;
  const linkTokenAddress = process.env.LINK_TOKEN_ADDRESS;

  if (!verdiktaAggregatorAddress || verdiktaAggregatorAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("VERDIKTA_AGGREGATOR_ADDRESS not set in .env");
  }

  if (!linkTokenAddress || linkTokenAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("LINK_TOKEN_ADDRESS not set in .env");
  }

  console.log("📋 Using configuration:");
  console.log("   Verdikta Aggregator:", verdiktaAggregatorAddress);
  console.log("   LINK Token:", linkTokenAddress);
  console.log("   Network:", hre.network.name, "\n");

  // TODO: Deploy BountyEscrow contract
  // 1. Get contract factory
  // 2. Deploy with constructor parameters
  // 3. Wait for deployment
  // 4. Log deployment details
  // 5. If on testnet/mainnet, verify on block explorer

  console.log("❌ TODO: Implement contract deployment");
  console.log("\nSteps to implement:");
  console.log("1. Get BountyEscrow contract factory");
  console.log("2. Deploy with verdiktaAggregatorAddress and linkTokenAddress");
  console.log("3. Wait for deployment confirmation");
  console.log("4. Log contract address");
  console.log("5. Verify contract on Basescan (if not local network)");

  // Example deployment code (commented out):
  /*
  const BountyEscrow = await hre.ethers.getContractFactory("BountyEscrow");
  const bountyEscrow = await BountyEscrow.deploy(
    verdiktaAggregatorAddress,
    linkTokenAddress
  );

  await bountyEscrow.waitForDeployment();
  const address = await bountyEscrow.getAddress();

  console.log("✅ BountyEscrow deployed to:", address);

  // Wait for block confirmations before verification
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\n⏳ Waiting for block confirmations...");
    await bountyEscrow.deploymentTransaction().wait(5);

    console.log("🔍 Verifying contract on Basescan...");
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: [verdiktaAggregatorAddress, linkTokenAddress],
    });
  }
  */
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });



