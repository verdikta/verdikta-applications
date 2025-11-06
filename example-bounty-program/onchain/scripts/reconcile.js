// scripts/reconcile.js
// Checks on jobs
// Run this way:
// JOB_ID=3 ESCROW=0xa33C506f89A2D58C79F64C454464DeAEFd0e28c3 npx hardhat run --network base_sepolia scripts/reconcile_safe.js
//

const hre = require("hardhat");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function main() {
  const JOB_ID = Number(need("JOB_ID"));      // UI 1-based
  const ESCROW = need("ESCROW");              // contract address
  if (!Number.isInteger(JOB_ID) || JOB_ID <= 0) throw new Error("JOB_ID must be a positive integer");
  const bountyId = JOB_ID - 1;

  const { ethers, artifacts, network } = hre;
  const provider = ethers.provider;

  // 1) Make sure there is bytecode at the address on THIS network
  const code = await provider.getCode(ESCROW);
  if (code === "0x") {
    console.error(`No contract code at ${ESCROW} on network "${network.name}". Check --network or address.`);
    process.exit(2);
  }

  // 2) Load ABI and contract
  const artifact = await artifacts.readArtifact("BountyEscrow");
  const contract = new ethers.Contract(ESCROW, artifact.abi, provider);

  // 3) Try bountyCount() first
  let count;
  try {
    count = Number(await contract.bountyCount());
  } catch (e) {
    console.error("Calling bountyCount() failed. ABI may not match this address.");
    console.error(e);
    process.exit(3);
  }
  console.log(`bountyCount = ${count}`);

  if (bountyId >= count) {
    console.error(`Requested bountyId ${bountyId} (from JOB_ID=${JOB_ID}) is out of range 0..${count-1}.`);
    console.error("If your API uses 1-based jobId, confirm the mapping (jobId ↔ bountyId).");
    process.exit(4);
  }

  // 4) Read the bounty
  try {
    const b = await contract.getBounty(bountyId);
    const now = Math.floor(Date.now()/1000);
    const s = Number(b.status); // 0 Open, 1 Awarded, 2 Cancelled
    const mapped = s===0 ? (now >= Number(b.submissionDeadline) ? "CLOSED" : "OPEN")
                 : s===1 ? "COMPLETED"
                 : "CLOSED";
    console.log({
      network: network.name,
      jobId: JOB_ID,
      bountyId,
      onChainStatusEnum: s,
      onChainStatusName: ["Open","Awarded","Cancelled"][s] ?? "Unknown",
      payoutWei: b.payoutWei.toString(),
      submissionDeadline: Number(b.submissionDeadline),
      mappedApiStatus: mapped,
      winner: b.winner,
    });
  } catch (e) {
    console.error("getBounty() reverted or could not be decoded.");
    console.error("Likely causes: out-of-range id, wrong ABI for this address, or wrong network.");
    console.error(e);
    process.exit(5);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

