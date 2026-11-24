const hre = require("hardhat");
require("dotenv").config({ quiet: true }); // onchain/.env: VERDIKTA_AGGREGATOR_* (hardhat.config already loaded the secrets file)
const { saveDeployment, copyAbiToFrontend } = require("./helpers");

async function main() {
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  
  // The v2 aggregator (verdikta-dispatcher beacon branch): one deployment serves every jury size,
  // since each bounty carries its own jury (K, M, N, P, timeout) and sends it with every request.
  // Fixed for the escrow's life.
  const suffix = network === "base" ? "BASE" : network === "base_sepolia" ? "BASE_SEPOLIA" : null;
  if (suffix === null) throw new Error(`Unsupported network ${network}. Use base or base_sepolia.`);
  const aggregator = parseAggregator(suffix);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network : ${network} (${chainId})`);
  console.log(`Aggregator: ${aggregator}`);

  // Deploy BountyEscrow
  const Escrow = await hre.ethers.getContractFactory("BountyEscrow");
  const escrow = await Escrow.deploy(aggregator);
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
      VerdiktaAggregator: aggregator
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
        constructorArguments: [aggregator]
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
          constructorArguments: [escrowAddr, aggregator]
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

/** VERDIKTA_AGGREGATOR_<NETWORK> -> one checksummed address. The old per-jury list
 *  (VERDIKTA_AGGREGATORS_<NETWORK>) is still read when it holds exactly one address. */
function parseAggregator(suffix) {
  const one = String(process.env[`VERDIKTA_AGGREGATOR_${suffix}`] || "").trim();
  const old = String(process.env[`VERDIKTA_AGGREGATORS_${suffix}`] || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (one) return hre.ethers.getAddress(one);
  if (old.length === 1) return hre.ethers.getAddress(old[0]);
  if (old.length > 1) {
    throw new Error(`VERDIKTA_AGGREGATORS_${suffix} lists ${old.length} aggregators: the escrow now takes ONE ` +
      `(each bounty carries its jury). Set VERDIKTA_AGGREGATOR_${suffix} to the v2 aggregator.`);
  }
  throw new Error(`Set VERDIKTA_AGGREGATOR_${suffix} in .env: the v2 aggregator address`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

