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
  'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize))',
  'function submissionCount(uint256 bountyId) view returns (uint256)',
  'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum, uint64 creatorWindowEnd))',
  'function finalizeSubmission(uint256 bountyId, uint256 submissionId)',
  'function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)',
  'function creatorApproveSubmission(uint256 bountyId, uint256 submissionId)',
  'function startPreparedSubmission(uint256 bountyId, uint256 submissionId)',
  'function verdikta() view returns (address)',
];

const LINK_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const VERDIKTA_ABI = [
  'function getEvaluation(bytes32 requestId) view returns (uint256[] likelihoods, string justificationCID, bool exists)',
];

// Status enums matching the contract
const BOUNTY_STATUS = ['Open', 'Awarded', 'Closed'];
const SUBMISSION_STATUS = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval'];

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    bountyId: null,
    passedOnly: false,
    approve: false,
    startExpired: false,
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
      case '--approve':
        options.approve = true;
        break;
      case '--start-expired':
        options.startExpired = true;
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

CLI equivalent of "Claim Results" in the GUI. Default mode finalizes
PendingVerdikta submissions that have completed AI evaluation.

Two extra modes for windowed bounties (creator approval window):
  --approve         As bounty creator: bulk-approve submissions whose creator
                    approval window is still open. Pays the creator
                    determination amount to each hunter.
  --start-expired   For ANY caller: bulk-call startPreparedSubmission on
                    PendingCreatorApproval submissions whose window has
                    expired. Requires LINK in the calling wallet (LINK is
                    pulled from the caller, not the original hunter).

Usage:
  node scripts/claimResults.js [options]

Options:
  --dry-run, -d          Show what would happen without executing
  --bounty-id, -b <id>   Only process a specific bounty (on-chain ID)
  --passed-only, -p      Default mode: only finalize submissions that passed
  --approve              Mode: bulk-approve as creator (window must be open)
  --start-expired        Mode: bulk-start expired creator-approval windows
  --help, -h             Show this help message

Examples:
  node scripts/claimResults.js                      # finalize completed evaluations
  node scripts/claimResults.js --dry-run
  node scripts/claimResults.js --bounty-id 2
  node scripts/claimResults.js --passed-only
  node scripts/claimResults.js --approve            # approve open creator windows
  node scripts/claimResults.js --approve --dry-run
  node scripts/claimResults.js --start-expired      # start expired windows (uses your LINK)
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
    let msg = error.reason || error.message;
    if (error.data) {
      try {
        const parsed = contract.interface.parseError(error.data);
        if (parsed) {
          const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
          msg = parsed.name + args;
        }
      } catch {}
    }
    return {
      success: false,
      error: msg,
    };
  }
}

/**
 * Helper to decode contract revert reasons.
 */
function decodeError(error, contract) {
  let msg = error.reason || error.message;
  if (error.data) {
    try {
      const parsed = contract.interface.parseError(error.data);
      if (parsed) {
        const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
        msg = parsed.name + args;
      }
    } catch {}
  }
  return msg;
}

/**
 * Find PendingCreatorApproval submissions, optionally filtered to a single bounty.
 * Returns array of { bountyId, submissionId, hunter, windowEnd, windowOpen, secondsRemaining,
 *                    creator, isCreator, creatorPayWei, creatorPayEth, threshold, submittedAt }
 */
async function findPendingCreatorApproval(contract, walletAddress, targetBountyId = null) {
  const found = [];
  const bountyCount = await contract.bountyCount();
  const now = Math.floor(Date.now() / 1000);

  console.log(`Scanning ${bountyCount} bounties for PendingCreatorApproval submissions...`);

  for (let bountyId = 0; bountyId < bountyCount; bountyId++) {
    if (targetBountyId !== null && bountyId !== targetBountyId) {
      continue;
    }

    let bounty;
    try {
      bounty = await contract.getBounty(bountyId);
    } catch {
      continue;
    }

    // Skip non-windowed bounties
    if (Number(bounty.creatorAssessmentWindowSize) === 0) {
      continue;
    }

    let subCount;
    try {
      subCount = await contract.submissionCount(bountyId);
    } catch {
      continue;
    }

    for (let subId = 0; subId < Number(subCount); subId++) {
      try {
        const sub = await contract.getSubmission(bountyId, subId);
        if (Number(sub.status) !== 5) continue; // 5 = PendingCreatorApproval

        const windowEnd = Number(sub.creatorWindowEnd);
        const windowOpen = windowEnd > now;

        found.push({
          bountyId,
          submissionId: subId,
          hunter: sub.hunter,
          windowEnd,
          windowOpen,
          secondsRemaining: windowOpen ? windowEnd - now : 0,
          creator: bounty.creator,
          isCreator: bounty.creator.toLowerCase() === walletAddress.toLowerCase(),
          creatorPayWei: bounty.creatorDeterminationPayment,
          creatorPayEth: ethers.formatEther(bounty.creatorDeterminationPayment),
          arbiterPayEth: ethers.formatEther(bounty.arbiterDeterminationPayment),
          threshold: Number(bounty.threshold),
          submittedAt: Number(sub.submittedAt),
        });
      } catch {
        continue;
      }
    }
  }

  return found;
}

async function creatorApproveSubmission(contract, bountyId, submissionId, dryRun) {
  if (dryRun) {
    console.log(`    [DRY RUN] Would call creatorApproveSubmission(${bountyId}, ${submissionId})`);
    return { success: true, dryRun: true };
  }

  try {
    console.log(`    Sending creatorApproveSubmission tx...`);
    const tx = await contract.creatorApproveSubmission(bountyId, submissionId);
    console.log(`    Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`    Confirmed in block ${receipt.blockNumber}`);
    return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  } catch (error) {
    return { success: false, error: decodeError(error, contract) };
  }
}

async function startExpiredSubmission(contract, linkToken, wallet, bountyId, submissionId, dryRun) {
  if (dryRun) {
    console.log(`    [DRY RUN] Would call startPreparedSubmission(${bountyId}, ${submissionId})`);
    return { success: true, dryRun: true };
  }

  try {
    // Read the submission to get the evalWallet and required LINK budget
    const sub = await contract.getSubmission(bountyId, submissionId);
    const evalWallet = sub.evalWallet;
    const linkMaxBudget = sub.linkMaxBudget;

    // Check LINK balance
    const linkBalance = await linkToken.balanceOf(wallet.address);
    if (linkBalance < linkMaxBudget) {
      return {
        success: false,
        error: `Insufficient LINK: need ${ethers.formatEther(linkMaxBudget)}, have ${ethers.formatEther(linkBalance)}`,
      };
    }

    // Check current allowance
    let allowance = await linkToken.allowance(wallet.address, evalWallet);
    if (allowance < linkMaxBudget) {
      console.log(`    Approving ${ethers.formatEther(linkMaxBudget)} LINK to evalWallet...`);
      const approveTx = await linkToken.approve(evalWallet, linkMaxBudget);
      await approveTx.wait();

      // Wait for indexing
      for (let attempt = 1; attempt <= 5; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        allowance = await linkToken.allowance(wallet.address, evalWallet);
        if (allowance >= linkMaxBudget) break;
      }
      if (allowance < linkMaxBudget) {
        return { success: false, error: 'LINK allowance not indexed after 5 attempts' };
      }
    }

    console.log(`    Sending startPreparedSubmission tx...`);
    const tx = await contract.startPreparedSubmission(bountyId, submissionId);
    console.log(`    Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`    Confirmed in block ${receipt.blockNumber}`);
    return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  } catch (error) {
    return { success: false, error: decodeError(error, contract) };
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

function formatSecondsRemaining(seconds) {
  if (seconds <= 0) return 'expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${s}s`;
}

async function runFinalizeMode(contract, verdikta, options) {
  console.log('Mode: Finalize completed Verdikta evaluations\n');
  console.log('Finding submissions ready for finalization...\n');

  let pending = await findPendingSubmissions(contract, verdikta, options.bountyId);

  if (options.passedOnly) {
    const beforeCount = pending.length;
    pending = pending.filter(sub => sub.passed);
    if (beforeCount > pending.length) {
      console.log(`Filtered: ${beforeCount - pending.length} failed submission(s) skipped (--passed-only)\n`);
    }
  }

  if (pending.length === 0) {
    console.log('No submissions found that are ready for finalization.');
    return 0;
  }

  console.log(`Found ${pending.length} submission(s) ready for finalization:\n`);

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
        console.log(`  Sync backend manually or wait for sync service`);
      }
      finalized++;
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      failed++;
    }
    console.log('');
  }

  console.log('============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  if (options.dryRun) {
    console.log(`Would finalize: ${finalized} submission(s)`);
  } else {
    console.log(`Finalized: ${finalized}`);
    console.log(`Failed:    ${failed}`);
  }

  const passed = pending.filter(s => s.passed).length;
  const failedEval = pending.filter(s => !s.passed).length;
  console.log(`\nEvaluation results:`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failedEval}`);

  return failed;
}

async function runApproveMode(contract, wallet, options) {
  console.log('Mode: Bulk creator approval of open windows\n');
  console.log(`Acting as creator: ${wallet.address}\n`);

  const all = await findPendingCreatorApproval(contract, wallet.address, options.bountyId);
  // Only ones where this wallet is the creator AND the window is still open
  const approvable = all.filter(s => s.isCreator && s.windowOpen);

  if (all.length === 0) {
    console.log('No PendingCreatorApproval submissions found.');
    return 0;
  }

  if (approvable.length === 0) {
    console.log(`Found ${all.length} PendingCreatorApproval submission(s), but none are approvable by ${wallet.address}.`);
    const otherCreator = all.filter(s => !s.isCreator).length;
    const expired = all.filter(s => s.isCreator && !s.windowOpen).length;
    if (otherCreator > 0) console.log(`  ${otherCreator} on bounties owned by other addresses`);
    if (expired > 0) console.log(`  ${expired} have expired windows (use --start-expired instead)`);
    return 0;
  }

  console.log(`Found ${approvable.length} submission(s) to approve:\n`);

  let approved = 0;
  let failed = 0;

  for (const sub of approvable) {
    console.log(`[Bounty ${sub.bountyId} / Submission ${sub.submissionId}]`);
    console.log(`  Hunter:    ${sub.hunter}`);
    console.log(`  Will pay:  ${sub.creatorPayEth} ETH (creator approval rate)`);
    console.log(`  Window:    ${formatSecondsRemaining(sub.secondsRemaining)} remaining`);

    const result = await creatorApproveSubmission(contract, sub.bountyId, sub.submissionId, options.dryRun);

    if (result.success) {
      if (!options.dryRun) console.log(`  ✅ Approved! Gas: ${result.gasUsed}`);
      approved++;
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      failed++;
    }
    console.log('');
  }

  console.log('============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  if (options.dryRun) {
    console.log(`Would approve: ${approved} submission(s)`);
  } else {
    console.log(`Approved:  ${approved}`);
    console.log(`Failed:    ${failed}`);
  }

  return failed;
}

async function runStartExpiredMode(contract, wallet, options) {
  console.log('Mode: Start expired creator-approval windows\n');
  console.log(`Caller: ${wallet.address} (LINK will be pulled from this wallet)\n`);

  const linkAddr = LINK_ADDRESSES[CONFIG.network] || LINK_ADDRESSES['base-sepolia'];
  const linkToken = new ethers.Contract(linkAddr, LINK_ABI, wallet);

  const all = await findPendingCreatorApproval(contract, wallet.address, options.bountyId);
  const expired = all.filter(s => !s.windowOpen);

  if (all.length === 0) {
    console.log('No PendingCreatorApproval submissions found.');
    return 0;
  }

  if (expired.length === 0) {
    console.log(`Found ${all.length} PendingCreatorApproval submission(s), but none have expired windows.`);
    console.log('  Use --approve to approve them as the creator (if your wallet owns them).');
    return 0;
  }

  console.log(`Found ${expired.length} submission(s) with expired windows:\n`);

  let started = 0;
  let failed = 0;

  for (const sub of expired) {
    console.log(`[Bounty ${sub.bountyId} / Submission ${sub.submissionId}]`);
    console.log(`  Hunter:    ${sub.hunter}`);
    console.log(`  Creator:   ${sub.creator}`);
    console.log(`  Will pay:  ${sub.arbiterPayEth} ETH if oracle approves (after AI evaluation)`);

    const result = await startExpiredSubmission(contract, linkToken, wallet, sub.bountyId, sub.submissionId, options.dryRun);

    if (result.success) {
      if (!options.dryRun) console.log(`  ✅ Started! Gas: ${result.gasUsed}`);
      started++;
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      failed++;
    }
    console.log('');
  }

  console.log('============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  if (options.dryRun) {
    console.log(`Would start: ${started} submission(s)`);
  } else {
    console.log(`Started:   ${started}`);
    console.log(`Failed:    ${failed}`);
  }

  return failed;
}

// Network LINK token addresses (used by --start-expired mode)
const LINK_ADDRESSES = {
  'base-sepolia': '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
  'base': '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
};

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Mutually exclusive modes
  if (options.approve && options.startExpired) {
    console.error('Error: --approve and --start-expired are mutually exclusive');
    process.exit(1);
  }

  const mode = options.approve ? 'approve' : (options.startExpired ? 'start-expired' : 'finalize');

  console.log('============================================================');
  console.log('Claim Results Script');
  console.log('============================================================');
  console.log(`Mode:        ${mode}`);
  console.log(`Target:      ${options.bountyId !== null ? `Bounty #${options.bountyId}` : 'All bounties'}`);
  if (mode === 'finalize') {
    console.log(`Passed Only: ${options.passedOnly ? 'Yes' : 'No'}`);
  }
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

  let exitCode = 0;
  if (mode === 'approve') {
    exitCode = await runApproveMode(contract, wallet, options);
  } else if (mode === 'start-expired') {
    exitCode = await runStartExpiredMode(contract, wallet, options);
  } else {
    exitCode = await runFinalizeMode(contract, verdikta, options);
  }

  process.exit(exitCode > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
