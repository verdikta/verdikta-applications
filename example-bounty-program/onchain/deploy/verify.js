const hre = require("hardhat");
require("dotenv").config();

// Verify a deployed BountyEscrow, its lens and its wallet implementation on the explorer. The
// escrow's constructor argument (the approved aggregators) is read back from the escrow itself.
async function main() {
  // `hardhat run` does not forward positional arguments (HH308): pass the escrow as ESCROW=0x…
  const addr = process.env.ESCROW || process.argv[2];
  if (!addr) throw new Error("Usage: ESCROW=0x… npx hardhat run deploy/verify.js --network base");
  const escrow = await hre.ethers.getContractAt("BountyEscrow", addr);
  const n = Number(await escrow.aggregatorCount());
  const aggregators = [];
  for (let i = 0; i < n; i++) aggregators.push(await escrow.aggregators(i));
  console.log(`Approved aggregators: ${aggregators.join(", ")}`);
  await hre.run("verify:verify", {
    address: addr,
    constructorArguments: [aggregators]
  });
  // The lens the escrow created in its constructor (no constructor arguments).
  const lensAddr = await escrow.lens();
  console.log(`Verifying BountyEscrowLens at ${lensAddr}`);
  await hre.run("verify:verify", {
    address: lensAddr,
    contract: "contracts/BountyEscrowLens.sol:BountyEscrowLens",
    constructorArguments: []
  });
  const walletImplAddr = await escrow.walletImplementation();
  console.log(`Verifying EvaluationWallet implementation at ${walletImplAddr}`);
  await hre.run("verify:verify", {
    address: walletImplAddr,
    contract: "contracts/EvaluationWallet.sol:EvaluationWallet",
    constructorArguments: [addr]
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
