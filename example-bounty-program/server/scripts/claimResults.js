#!/usr/bin/env node
/**
 * Claim Results Script
 *
 * Finalizes all outstanding submissions that have completed Verdikta evaluation.
 * This is the CLI equivalent of clicking "Claim Results" in the GUI.
 *
 * Usage:
 *   node scripts/claimResults.js
 *   node scripts/claimResults.js --passed-only
 *   node scripts/claimResults.js --dry-run
 *   node scripts/claimResults.js --bounty-id 2
 *
 * Environment Variables Required:
 *   PRIVATE_KEY - Private key for signing transactions
 *   NETWORK - Network to use (base or base-sepolia)
 *   BOUNTY_ESCROW_ADDRESS_BASE / BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA - Contract addresses
 */

const path = require('path');
const fs = require('fs');

// Load main .env first
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Load secrets file if it exists
const secretsPath = path.join(__dirname, '..', '..', '..', '..', 'secrets', '.env.secrets');
if (fs.existsSync(secretsPath)) {
  require('dotenv').config({ path: secretsPath, override: true });
  console.log('✓ Loaded secrets from:', secretsPath);
}

const { ethers } = require('ethers');

// Use server config for network-aware settings
const { config: serverConfig } = require('../config');

// =============================================================================
// CONFIGURATION
// =============================================================================

const buildApiUrl = () => {
  if (process.env.API_URL) return process.env.API_URL;
  const host = process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost');
  // Use network-specific ports: base=5005, base-sepolia=5006
  const port = serverConfig.network === 'base' ? 5005 : 5006;
  return `http://${host}:${port}`;
};

const CONFIG = {
  apiUrl: buildApiUrl(),
  rpcUrl: serverConfig.rpcUrl,
  contractAddress: serverConfig.bountyEscrowAddress,
  privateKey: process.env.PRIVATE_KEY,
  network: serverConfig.network,
  botApiKey: process.env.BOT_API_KEY,
};

// =============================================================================
// CONTRACT ABIS
// =============================================================================

const BOUNTY_ESCROW_ABI = [
  'function bountyCount() view returns (uint256)',
  'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))',
  'function submissionCount(uint256 bountyId) view returns (uint256)',
  'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))',
  'function finalizeSubmission(uint256 bountyId, uint256 submissionId)',
  'function verdikta() view returns (address)',
];

const VERDIKTA_ABI = [
  'function getEvaluation(bytes32 requestId) view returns (uint256[] likelihoods, string justificationCID, bool exists)',
];

// Status enums matching the contract
const BOUNTY_STATUS = ['Open', 'Awarded', 'Closed'];
const SUBMISSION_STATUS = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    bountyId: null,
    passedOnly: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
      case '-d':
        options.dryRun = true;
        break;
      case '--bounty-id':
      case '-b':
        options.bountyId = parseInt(args[++i]);
        break;
      case '--passed-only':
      case '-p':
        options.passedOnly = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Claim Results Script

Finalizes all outstanding submissions that have completed Verdikta evaluation.
This is the CLI equivalent of clicking "Claim Results" in the GUI.

Usage:
  node scripts/claimResults.js [options]

Options:
  --dry-run, -d          Show what would be finalized without executing
  --bounty-id, -b <id>   Only process a specific bounty (on-chain ID)
  --passed-only, -p      Only finalize submissions that passed (saves gas)
  --help, -h             Show this help message

Examples:
  node scripts/claimResults.js
  node scripts/claimResults.js --dry-run
  node scripts/claimResults.js --bounty-id 2
  node scripts/claimResults.js --passed-only
`);
}

// =============================================================================
// MAIN LOGIC
// =============================================================================

async function getWallet() {
  if (!CONFIG.privateKey) {
    throw new Error('PRIVATE_KEY not set');
  }
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  return new ethers.Wallet(CONFIG.privateKey, provider);
}

async function findPendingSubmissions(contract, verdikta, targetBountyId = null) {
  const pending = [];
  const bountyCount = await contract.bountyCount();

  console.log(`Scanning ${bountyCount} bounties...`);

  for (let bountyId = 0; bountyId < bountyCount; bountyId++) {
    // Skip if targeting a specific bounty
    if (targetBountyId !== null && bountyId !== targetBountyId) {
      continue;
    }

    try {
      const bounty = await contract.getBounty(bountyId);
      const bountyStatus = Number(bounty.status);

      // Skip closed/awarded bounties (though we might still finalize for record-keeping)
      // Actually, we should still check - submissions might need finalization even after awarded

      const subCount = await contract.submissionCount(bountyId);

      for (let subId = 0; subId < subCount; subId++) {
        try {
          const sub = await contract.getSubmission(bountyId, subId);
          const status = Number(sub.status);

          // Only interested in PendingVerdikta (status 1)
          if (status !== 1) {
            continue;
          }

          // Check if Verdikta has a result
          const aggId = sub.verdiktaAggId;
          if (!aggId || aggId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            continue;
          }

          try {
            const [scores, justCid, exists] = await verdikta.getEvaluation(aggId);

            if (exists && scores && scores.length >= 2) {
              const acceptance = Number(scores[1]) / 10000; // Normalize to 0-100
              const rejection = Number(scores[0]) / 10000;
              const threshold = Number(bounty.threshold);
              const passed = acceptance >= threshold;

              pending.push({
                bountyId,
                submissionId: subId,
                hunter: sub.hunter,
                acceptance,
                rejection,
                threshold,
                passed,
                justCid,
                bountyStatus: BOUNTY_STATUS[bountyStatus] || `Unknown(${bountyStatus})`,
              });
            }
          } catch (verdiktaError) {
            // Verdikta query failed - evaluation might not be ready yet
            continue;
          }
        } catch (subError) {
          continue;
        }
      }
    } catch (bountyError) {
      continue;
    }
  }

  return pending;
}

async function finalizeSubmission(contract, bountyId, submissionId, dryRun) {
  if (dryRun) {
    console.log(`    [DRY RUN] Would call finalizeSubmission(${bountyId}, ${submissionId})`);
    return { success: true, dryRun: true };
  }

  try {
    console.log(`    Sending transaction...`);
    const tx = await contract.finalizeSubmission(bountyId, submissionId);
    console.log(`    Tx hash: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`    Confirmed in block ${receipt.blockNumber}`);

    return {
      success: true,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
  } catch (error) {
    return {
      success: false,
      error: error.reason || error.message,
    };
  }
}

function getAuthHeaders() {
  const headers = {};
  if (CONFIG.botApiKey) {
    headers['X-Bot-API-Key'] = CONFIG.botApiKey;
  }
  return headers;
}

// Backwards-compatible alias
const getBotHeaders = getAuthHeaders;

async function syncBackend(jobId, submissionId) {
  try {
    const response = await fetch(
      `${CONFIG.apiUrl}/api/jobs/${jobId}/submissions/${submissionId}/refresh`,
      { method: 'POST', headers: getBotHeaders() }
    );
    if (response.ok) {
      const data = await response.json();
      return { success: true, status: data.submission?.status };
    }
    return { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  console.log('============================================================');
  console.log('Claim Results Script');
  console.log('============================================================');
  console.log(`Target:      ${options.bountyId !== null ? `Bounty #${options.bountyId}` : 'All bounties'}`);
  console.log(`Passed Only: ${options.passedOnly ? 'Yes' : 'No'}`);
  console.log(`Dry Run:     ${options.dryRun ? 'Yes' : 'No'}`);
  console.log('============================================================\n');

  // Validate configuration
  if (!options.dryRun && !CONFIG.privateKey) {
    console.error('Error: PRIVATE_KEY not set');
    process.exit(1);
  }
  if (!CONFIG.contractAddress) {
    console.error(`Error: No contract address configured for network "${CONFIG.network}"`);
    console.error('Set BOUNTY_ESCROW_ADDRESS_BASE or BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA in .env');
    process.exit(1);
  }

  // Setup
  const wallet = await getWallet();
  const contract = new ethers.Contract(CONFIG.contractAddress, BOUNTY_ESCROW_ABI, wallet);
  const verdiktaAddr = await contract.verdikta();
  const verdikta = new ethers.Contract(verdiktaAddr, VERDIKTA_ABI, wallet.provider);

  console.log(`Wallet:    ${wallet.address}`);
  console.log(`Contract:  ${CONFIG.contractAddress}`);
  console.log(`Verdikta:  ${verdiktaAddr}\n`);

  // Find pending submissions with completed evaluations
  console.log('Finding submissions ready for finalization...\n');
  let pending = await findPendingSubmissions(contract, verdikta, options.bountyId);

  // Filter to passed only if requested
  if (options.passedOnly) {
    const beforeCount = pending.length;
    pending = pending.filter(sub => sub.passed);
    if (beforeCount > pending.length) {
      console.log(`Filtered: ${beforeCount - pending.length} failed submission(s) skipped (--passed-only)\n`);
    }
  }

  if (pending.length === 0) {
    console.log('No submissions found that are ready for finalization.');
    process.exit(0);
  }

  console.log(`Found ${pending.length} submission(s) ready for finalization:\n`);

  // Process each pending submission
  let finalized = 0;
  let failed = 0;

  for (const sub of pending) {
    const passedStr = sub.passed ? '✓ PASSED' : '✗ FAILED';
    console.log(`[Bounty ${sub.bountyId} / Submission ${sub.submissionId}]`);
    console.log(`  Hunter:     ${sub.hunter}`);
    console.log(`  Score:      ${sub.acceptance.toFixed(1)}% acceptance / ${sub.rejection.toFixed(1)}% rejection`);
    console.log(`  Threshold:  ${sub.threshold}%`);
    console.log(`  Result:     ${passedStr}`);
    console.log(`  Bounty:     ${sub.bountyStatus}`);

    const result = await finalizeSubmission(contract, sub.bountyId, sub.submissionId, options.dryRun);

    if (result.success) {
      if (!options.dryRun) {
        console.log(`  ✅ Finalized! Gas: ${result.gasUsed}`);

        // Try to sync backend
        // Note: We need to find the jobId from the backend - for now just log
        console.log(`  Sync backend manually or wait for sync service`);
      }
      finalized++;
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      failed++;
    }
    console.log('');
  }

  // Summary
  console.log('============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  if (options.dryRun) {
    console.log(`Would finalize: ${finalized} submission(s)`);
  } else {
    console.log(`Finalized: ${finalized}`);
    console.log(`Failed:    ${failed}`);
  }

  // Show passed vs failed breakdown
  const passed = pending.filter(s => s.passed).length;
  const failedEval = pending.filter(s => !s.passed).length;
  console.log(`\nEvaluation results:`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failedEval}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
