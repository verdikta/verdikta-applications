// scripts/audit_balances.js
// Checks status on all jobs, with balances
// Run this way:
// ESCROW=0xa33C506f89A2D58C79F64C454464DeAEFd0e28c3 \
// hardhat > npx hardhat run --network base_sepolia scripts/audit-balances.js
const hre = require("hardhat");

async function main() {
  const ESCROW = process.env.ESCROW; // contract addr
  if (!ESCROW) throw new Error("Set ESCROW=0x...");

  const { ethers, artifacts, network } = hre;
  const provider = ethers.provider;

  const code = await provider.getCode(ESCROW);
  if (code === "0x") throw new Error(`No code at ${ESCROW} on ${network.name}`);

  const bal = await provider.getBalance(ESCROW);
  const artifact = await artifacts.readArtifact("BountyEscrow");
  const c = new ethers.Contract(ESCROW, artifact.abi, provider);

  const count = Number(await c.bountyCount());
  let sum = 0n;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const b = await c.getBounty(i);
    const statusEnum = Number(b.status); // 0 Open, 1 Awarded, 2 Cancelled
    const statusName = ["Open","Awarded","Cancelled"][statusEnum] ?? "Unknown";
    const pw = BigInt(b.payoutWei);
    sum += pw;
    rows.push({ bountyId: i, statusName, payoutWei: pw.toString(), deadline: Number(b.submissionDeadline) });
  }

  console.log({
    network: network.name,
    escrow: ESCROW,
    contractBalanceWei: bal.toString(),
    sumOfAllPayoutWei: sum.toString(),
    balanceMinusSumWei: (bal - sum).toString(),
  });
  console.table(rows);
}

main().catch(e => { console.error(e); process.exit(1); });

