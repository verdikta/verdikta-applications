#!/usr/bin/env node
// scripts/test-single-cid.js
// Use: AGG=0x<a v2 aggregator> npx hardhat run scripts/test-single-cid.js --network base_sepolia
// Sends one request straight to a v2 aggregator and drives the round as a requester must: drawJury
// from block B+2, closeCommits after T+ if needed, promote from C+2, then polls for the result.
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const pause = ms => new Promise(r => setTimeout(r, ms));

const AGGREGATOR = process.env.AGG;   // a v2 aggregator (verdikta-dispatcher beacon branch)

// Test with just your deliverable CID
const CIDS     = ["QmRLB6LYe6VER6UQDoX7wt4LmKATHbGA81ny5vgRMbfrtX","QmXv5UDj9Sj7KBdet5375sEUFptKPsdjp345v1ztRUq4Tj"];
// const CIDS     = ["QmeY9cjdQJ1yvT5pcVmXfFwNwehEnLm12qpQZA2UiTmQ1D","QmXmMr5pTMRwb6nKeuF8UGwsmsDXXxfyMBfARzLyUzMSy2"];
// const CIDS     = ["QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH","QmZDcGhsupB8xF4B2Soe2ugo43ALYuXuSn6GbSx6cGtTiL"];
// const CIDS = ["QmS6DqMsodYgwKa2eFmUA5gxeKiYsv9FaiFANTrGMQgQgs"];
// const CIDS = ["QmS6DqMsodYgwKa2eFmUA5gxeKiYsv9FaiFANTrGMQgQgs","QmVjqNc4SxJWdmVPPrpDgaNFK8SUZ1LkxePetz91PvK4qF"];
// const ADDENDUM = "Thank you for giving me the opportunity to submit this work. You can find it below in the references section."; // Empty - no addendum
const ADDENDUM = "Just noise."; // Empty - no addendum

const JOB_CLASS = 717;
// const JOB_CLASS = 3030;
// const JOB_CLASS = 128;
// const JOB_CLASS = 2020;
const MAX_ORACLE_FEE = ethers.parseUnits("0.00002", 18); // ETH wei (clamped on-chain to 0.0004 ceiling)
const ESTIMATE_BASE_FEE = ethers.parseUnits("0.000001", 18);
const MAX_FEE_SCALING = 5;
const ALPHA = 500;
const MIN_FEE = 0n;            // fee floor (item 8); 0 = none
const WITH_BEACONS = false;    // item 9's beacon flag (Jumbo)

const POLL_INTERVAL = 15_000; // 15 seconds
const MAX_POLLS = 60; // 15 minutes total

async function getSigner() {
  const [cfg] = await hre.ethers.getSigners();
  if (cfg) return cfg;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("No signer available");
  return new hre.ethers.Wallet(pk, hre.ethers.provider);
}

(async () => {
  if (!AGGREGATOR) throw new Error("Set AGG=0x<v2 aggregator>");
  const signer = await getSigner();
  console.log("Using signer:", await signer.getAddress());
  console.log("Network:", hre.network.name);

const aggAbi = [
  "function requestAIEvaluationWithApproval(string[] cids, string addendum, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons) payable returns (bytes32)",
  "function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons) view returns (uint256)",
  "function ethOwed(address account) view returns (uint256)",
  "function drawJury(bytes32 aggId)",
  "function closeCommits(bytes32 aggId)",
  "function promote(bytes32 aggId)",
  "function getEvaluation(bytes32 aggId) view returns (uint256[], string, bool)",
  "function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)",
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)"
];
const PHASES = ["?", "draw", "beacons", "commit", "closing", "reveal", "final", "settled", "failed", "cancelled"];


  const agg = new hre.ethers.Contract(AGGREGATOR, aggAbi, signer);

  const me = await signer.getAddress();

  // Size the ETH prepay: worst-case fee minus any existing pull-payment credit.
  const [ethBal, maxTotal, credit] = await Promise.all([
    hre.ethers.provider.getBalance(me),
    agg.maxTotalFee(MAX_ORACLE_FEE, MIN_FEE, WITH_BEACONS),
    agg.ethOwed(me),
  ]);
  const value = maxTotal > credit ? maxTotal - credit : 0n;   // msg.value first, credit covers the rest
  console.log(`ETH balance: ${ethers.formatEther(ethBal)} ETH`);
  console.log(`Worst-case prepay (maxTotalFee): ${ethers.formatEther(maxTotal)} ETH`);
  console.log(`Existing ethOwed credit: ${ethers.formatEther(credit)} ETH`);
  console.log(`Attaching msg.value: ${ethers.formatEther(value)} ETH`);

  // Send request
  console.log("\nSending request...");
  console.log("CIDs:", CIDS);
  console.log("Addendum:", ADDENDUM || "(empty)");

  const tx = await agg.requestAIEvaluationWithApproval(
    CIDS,
    ADDENDUM,
    ALPHA,
    MAX_ORACLE_FEE,
    MIN_FEE,
    ESTIMATE_BASE_FEE,
    MAX_FEE_SCALING,
    JOB_CLASS,
    WITH_BEACONS,
    { value }
  );
  console.log("Transaction:", tx.hash);
  
  const rcpt = await tx.wait(1);
  console.log("✓ Confirmed in block:", rcpt.blockNumber);

  // Extract aggId
  const ev = rcpt.logs
    .map(l => { try { return agg.interface.parseLog(l); } catch { return null; } })
    .find(l => l && l.name === "RequestAIEvaluation");

  if (!ev) {
    console.log("ERROR: RequestAIEvaluation event not found");
    process.exit(1);
  }

  const aggId = ev.args.aggRequestId;
  console.log("\n✓ AggId:", aggId);
  console.log("\nDriving the round and polling (every 15 seconds)...");

  // The step that moves the round on, if any: simulate first, send only what will succeed.
  async function step(name) {
    try {
      await agg[name].staticCall(aggId);
    } catch {
      return false;
    }
    const t = await agg[name](aggId);
    await t.wait(1);
    console.log(`  sent ${name} (${t.hash})`);
    return true;
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await pause(POLL_INTERVAL);
    
    console.log(`\n[${i + 1}/${MAX_POLLS}] Checking...`);
    
    try {
      const info = await agg.getRoundInfo(aggId);
      const phase = Number(info.phase);
      console.log(`  phase: ${phase} (${PHASES[phase] || "?"}), commits: ${info.commits}`);
      if (phase === 1 || phase === 2) await step("drawJury");          // from B+2; again after beacons
      else if (phase === 3) await step("closeCommits");                  // only after T+ with >= M
      else if (phase === 4) await step("promote");                       // from C+2
      const isFailed = phase === 8 || phase === 9;
      const [scores, justCids, hasResponses] = await agg.getEvaluation(aggId);
      
      console.log(`  valid result: ${hasResponses}`);
      console.log(`  scores.length: ${scores.length}`);
      
      if (scores.length > 0) {
        console.log(`  scores: [${scores.map(x => x.toString()).join(", ")}]`);
      }
      
      if (justCids) {
        console.log(`  justifications: "${justCids}"`);
      }
      
      if (hasResponses && scores.length > 0) {
        const allZero = scores.every(x => x === 0n);
        if (!allZero) {
          console.log("\n✅ SUCCESS!");
          console.log("Final scores:", scores.map(x => x.toString()));
          console.log("Justifications:", justCids);
          process.exit(0);
        }
      }
      
      if (isFailed) {
        console.log("\n❌ FAILED - Evaluation failed");
        process.exit(1);
      }
      
      console.log("  Still pending...");
      
    } catch (err) {
      console.log("  Error checking:", err.message);
    }
  }

  console.log("\n⏱️  TIMEOUT - No response after", MAX_POLLS * POLL_INTERVAL / 1000, "seconds");
  process.exit(1);

})().catch(err => {
  console.error("Error:", err);
  process.exitCode = 1;
});

