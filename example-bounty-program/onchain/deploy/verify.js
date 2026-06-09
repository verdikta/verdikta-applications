const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const addr = process.argv[2];
  if (!addr) throw new Error("Usage: npx hardhat run deploy/verify.js --network base <address>");
  const verdikta = hre.network.name === "base"
    ? process.env.VERDIKTA_AGGREGATOR_BASE
    : process.env.VERDIKTA_AGGREGATOR_BASE_SEPOLIA;
  await hre.run("verify:verify", {
    address: addr,
    constructorArguments: [verdikta]
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

