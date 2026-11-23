const hre = require("hardhat");
require("dotenv").config({ quiet: true }); // onchain/.env: VERDIKTA_AGGREGATORS_* (hardhat.config already loaded the secrets file)
const { saveDeployment, copyAbiToFrontend } = require("./helpers");

async function main() {
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  
  // The approved v2 aggregators, one per jury size, in jury order (a bounty's `jury` is the index):
  // small, medium, large, jumbo (verdikta-dispatcher deploy/03_config.js, AGG_CLASS). Fixed for the
  // escrow's life. Bondless Small uses the small jury.
  const list = network === "base" ? process.env.VERDIKTA_AGGREGATORS_BASE
    : network === "base_sepolia" ? process.env.VERDIKTA_AGGREGATORS_BASE_SEPOLIA
    : null;
  if (list === null) throw new Error(`Unsupported network ${network}. Use base or base_sepolia.`);
  const aggregators = parseAggregators(list);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network : ${network} (${chainId})`);
  aggregators.forEach((a, i) => console.log(`Aggregator, jury ${i} (${JURIES[i] || "?"}): ${a}`));

  // Deploy BountyEscrow
  const Escrow = await hre.ethers.getContractFactory("BountyEscrow");
  const escrow = await Escrow.deploy(aggregators);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  const deployTx = escrow.deploymentTransaction();
  const deployRc = deployTx ? await deployTx.wait() : null;
  const deploymentBlock = deployRc ? deployRc.blockNumber : null;
  // The escrow's constructor creates its read-only lens; record it so it can be verified
  // and found on explorers. Callers never need it: lens views answer at the escrow address.
  // Load-balanced RPCs can lag a block or two behind the receipt, answering eth_call with
  // empty data ("could not decode result data") — retry rather than abort after the deploy.
  async function readWithRetry(label, fn) {
    for (let i = 1; i <= 10; i++) {
      try { return await fn(); } catch (e) {
        if (i === 10) throw e;
        console.log(`  ${label}: RPC not caught up yet (${e.shortMessage || e.message}); retry ${i}/10 in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  const lensAddr = await readWithRetry("lens()", () => escrow.lens());
  // ...and the EvaluationWallet implementation every submission wallet is a clone of.
  const walletImplAddr = await readWithRetry("walletImplementation()", () => escrow.walletImplementation());
  if (deploymentBlock) console.log(`Deployment block: ${deploymentBlock}  (set server/config.js deploymentBlocks)`);

  console.log(`\nBountyEscrow deployed at: ${escrowAddr}`);
  console.log(`BountyEscrowLens (created by the escrow): ${lensAddr}`);
  console.log(`EvaluationWallet implementation (created by the escrow): ${walletImplAddr}`);

  // Save deployment JSON
  saveDeployment(network, chainId, {
    network,
    chainId,
    deployedAt: new Date().toISOString(),
    deploymentBlock,
    contracts: {
      BountyEscrow: escrowAddr,
      BountyEscrowLens: lensAddr,
      EvaluationWalletImplementation: walletImplAddr,
      VerdiktaAggregators: aggregators
    }
  });

  // Export the MERGED ABI (escrow + lens views) for your front end
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
        constructorArguments: [aggregators]
      });
      console.log("Verified successfully!");
      // The lens takes no constructor argument. Verifying it separately lets the
      // explorer's read tab show the views the escrow's own source does not list.
      try {
        await hre.run("verify:verify", {
          address: lensAddr,
          contract: "contracts/BountyEscrowLens.sol:BountyEscrowLens",
          constructorArguments: []
        });
        console.log("Lens verified successfully!");
      } catch (lensErr) {
        const m = lensErr.message || lensErr.toString();
        if (m.includes("Already Verified")) console.log("Lens already verified!");
        else console.log(`Lens verify failed (verify manually later): ${m}`);
      }
      // The wallet implementation: verifying it lets explorers show every submission's
      // minimal-proxy clone as "EvaluationWallet" with readable state.
      try {
        await hre.run("verify:verify", {
          address: walletImplAddr,
          contract: "contracts/EvaluationWallet.sol:EvaluationWallet",
          constructorArguments: [escrowAddr]
        });
        console.log("Wallet implementation verified successfully!");
      } catch (wErr) {
        const m = wErr.message || wErr.toString();
        if (m.includes("Already Verified")) console.log("Wallet implementation already verified!");
        else console.log(`Wallet implementation verify failed (verify manually later): ${m}`);
      }
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
          console.log(`  npx hardhat run deploy/verify.js --network ${network}   (reads the deployment file)`);
        } else {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }
}


}

const JURIES = ["small", "medium", "large", "jumbo"];

/** "0xA,0xB,..." -> checksummed addresses, 1..8 of them, no duplicates */
function parseAggregators(list) {
  const out = String(list || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (out.length === 0) throw new Error("Set VERDIKTA_AGGREGATORS_<NETWORK> in .env: the v2 aggregators, comma-separated, in jury order (small,medium,large,jumbo)");
  if (out.length > 8) throw new Error("At most 8 aggregators");
  const seen = new Set();
  return out.map((a) => {
    const c = hre.ethers.getAddress(a);
    if (seen.has(c)) throw new Error(`Aggregator ${c} listed twice`);
    seen.add(c);
    return c;
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

