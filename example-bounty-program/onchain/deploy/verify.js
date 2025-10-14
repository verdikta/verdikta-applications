const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const addr = process.argv[2];
  if (!addr) throw new Error("Usage: npx hardhat run deploy/verify.js --network base <address>");
  await hre.run("verify:verify", {
    address: addr,
    constructorArguments: [
      process.env.LINK_BASE_MAINNET || process.env.LINK_BASE_SEPOLIA,
      process.env.VERDIKTA_AGGREGATOR
    ]
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

