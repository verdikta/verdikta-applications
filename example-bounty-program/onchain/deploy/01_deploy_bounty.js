const hre = require("hardhat");
// require("dotenv").config({ quiet: true });
const { saveDeployment, copyAbiToFrontend } = require("./helpers");

async function main() {
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  
  const {
    LINK_TOKEN_BASE,
    LINK_TOKEN_BASE_SEPOLIA,
    VERDIKTA_AGGREGATOR_BASE,         
    VERDIKTA_AGGREGATOR_BASE_SEPOLIA  
  } = process.env;

  // Pick LINK by network
  let link;
  let verdikta;  
  
  if (network === "base") {
    link = LINK_TOKEN_BASE;
    verdikta = VERDIKTA_AGGREGATOR_BASE; 
  } else if (network === "base_sepolia") {
    link = LINK_TOKEN_BASE_SEPOLIA;
    verdikta = VERDIKTA_AGGREGATOR_BASE_SEPOLIA;  
  } else {
    throw new Error(`Unsupported network ${network}. Use base or base_sepolia.`);
  }

  if (!link) throw new Error("Set LINK address in .env for this network");
  if (!verdikta) throw new Error("Set VERDIKTA_AGGREGATOR address in .env for this network");  

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network : ${network} (${chainId})`);
  console.log(`LINK    : ${link}`);
  console.log(`Verdikta Aggregator: ${verdikta}`);  

  // Deploy BountyEscrow
  const Escrow = await hre.ethers.getContractFactory("BountyEscrow");
  const escrow = await Escrow.deploy(link, verdikta);  
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();

  console.log(`\nBountyEscrow deployed at: ${escrowAddr}`);

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
  console.log("Verifying on BaseScan (will retry for up to 60 seconds)...");
  
  const maxAttempts = 4; // 4 attempts over 60 seconds
  const delayMs = 15000; // 15 seconds between attempts
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await hre.run("verify:verify", {
        address: escrowAddr,
        constructorArguments: [link, verdikta]
      });
      console.log("Verified successfully!");
      break; // Success! Exit the loop
    } catch (err) {
      const errorMsg = err.message || err.toString();
      
      // Check if it's the "no bytecode" error (contract not indexed yet)
      if (errorMsg.includes("has no bytecode") && attempt < maxAttempts) {
        console.log(`Attempt ${attempt}/${maxAttempts}: Contract not indexed yet. Retrying in 15s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else if (errorMsg.includes("Already Verified")) {
        console.log("Contract already verified!");
        break;
      } else {
        // Different error or last attempt
        console.log(`Verify failed (attempt ${attempt}/${maxAttempts}):`, errorMsg);
        if (attempt === maxAttempts) {
          console.log("Try verifying manually later with:");
          console.log(`  npx hardhat verify --network ${network} ${escrowAddr} "${link}" "${verdikta}"`);
        } else {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }
}


}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

