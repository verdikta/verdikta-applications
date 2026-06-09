#!/usr/bin/env node
// scripts/test-single-cid.js
// Use: npx hardhat run scripts/test-single-cid.js --network base_sepolia
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const pause = ms => new Promise(r => setTimeout(r, ms));

const AGGREGATOR = "0xe8a385E473EA710c5a88Cc72681a16a26fe380e4"; // Base Sepolia (ETH-funded)

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
const MAX_ORACLE_FEE = ethers.parseUnits("0.0001", 18); // ETH wei (clamped on-chain to 0.0004 ceiling)
const ESTIMATE_BASE_FEE = ethers.parseUnits("0.000001", 18);
const MAX_FEE_SCALING = 5;
const ALPHA = 500;

const POLL_INTERVAL = 30_000; // 30 seconds
const MAX_POLLS = 12; // 6 minutes total

async function getSigner() {
  const [cfg] = await hre.ethers.getSigners();
  if (cfg) return cfg;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("No signer available");
  return new hre.ethers.Wallet(pk, hre.ethers.provider);
}

(async () => {
  const signer = await getSigner();
  console.log("Using signer:", await signer.getAddress());
  console.log("Network:", hre.network.name);

const aggAbi = [
  "function requestAIEvaluationWithApproval(string[] memory cids, string memory addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseFee, uint256 maxFeeScaling, uint64 jobClass) public payable returns (bytes32)",
  "function maxTotalFee(uint256 requestedMaxOracleFee) external view returns (uint256)",
  "function ethOwed(address account) external view returns (uint256)",
  "function getEvaluation(bytes32 reqId) public view returns (uint256[] memory, string memory, bool)",
  "function isFailed(bytes32 aggId) external view returns (bool)",
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)"
];


  const agg = new hre.ethers.Contract(AGGREGATOR, aggAbi, signer);

  const me = await signer.getAddress();

  // Size the ETH prepay: worst-case fee minus any existing pull-payment credit.
  const [ethBal, maxTotal, credit] = await Promise.all([
    hre.ethers.provider.getBalance(me),
    agg.maxTotalFee(MAX_ORACLE_FEE),
    agg.ethOwed(me),
  ]);
  const value = maxTotal > credit ? maxTotal - credit : 0n;
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
    ESTIMATE_BASE_FEE,
    MAX_FEE_SCALING,
    JOB_CLASS,
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
  console.log("\nPolling for results (checking every 30 seconds)...");

  // Poll for results
  for (let i = 0; i < MAX_POLLS; i++) {
    await pause(POLL_INTERVAL);
    
    console.log(`\n[${i + 1}/${MAX_POLLS}] Checking...`);
    
    try {
      const [scores, justCids, hasResponses] = await agg.getEvaluation(aggId);
      const isFailed = await agg.isFailed(aggId);
      
      console.log(`  hasResponses: ${hasResponses}`);
      console.log(`  failed: ${isFailed}`);
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

