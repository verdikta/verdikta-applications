#!/usr/bin/env node
/**
 * Claim Results Script (BountyEscrow v2)
 *
 * Resolves every outstanding submission the escrow says can be moved on right now: it asks the
 * lens for nextAction(bountyId, submissionId) and sends that call (finalizeSubmission,
 * closeFailedRound, expireRerun; rerunSubmission with --rerun; the keeper's round steps with
 * --move-rounds). This is the CLI equivalent of clicking "Claim Results" in the GUI.
 *
 * Usage:
 *   node scripts/claimResults.js
 *   node scripts/claimResults.js --passed-only
 *   node scripts/claimResults.js --dry-run
 *   node scripts/claimResults.js --bounty-id 2
 *   node scripts/claimResults.js --rerun
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

// The merged v2 escrow + lens ABI: the lens views (nextAction, getOracleResult, ...) are callable
// at the escrow address through its fallback.
const BOUNTY_ESCROW_ABI = require('../../onchain/abi/BountyEscrow.json');
// The v2 aggregator (closeCommits / promote for --move-rounds) and the enum names.
const { AGGREGATOR_ABI, PHASES, OUTCOMES, SUBMISSION_STATUSES } = require('../utils/aggregatorAbi');

// Status enums matching the contract
const BOUNTY_STATUS = ['Open', 'Awarded', 'Closed'];
const SUBMISSION_STATUS = SUBMISSION_STATUSES; // 0 Prepared ... 5 PendingCreatorApproval, 6 AwaitingRerun

// Resolve calls may settle the aggregator round inside a try/catch, which can need well over 1.5M
// gas on a large jury: never send them with a hand-picked low limit (the same rule as
// utils/contractService.js estimateResolveGas: estimate + 25%, at least 300k, else 2.5M).
const GAS_MARGIN_PCT = 25n;
const GAS_LIMIT_MIN = 300_000n;
const GAS_LIMIT_FALLBACK = 2_500_000n;

// What the default mode sends for each nextAction. `flag` = only with that CLI option.
const STEP_CALLS = {
  FINALIZE: { target: 'escrow', fn: 'finalizeSubmission' },
  CLOSE_FAILED: { target: 'escrow', fn: 'closeFailedRound' },
  EXPIRE_RERUN: { target: 'escrow', fn: 'expireRerun' },
  RERUN: { target: 'escrow', fn: 'rerunSubmission', flag: 'rerun' },
  DRAW: { target: 'escrow', fn: 'drawJury', flag: 'moveRounds' },
  CLOSE_COMMITS: { target: 'aggregator', fn: 'closeCommits', flag: 'moveRounds' },
  PROMOTE: { target: 'aggregator', fn: 'promote', flag: 'moveRounds' },
};

// Why a submission is skipped, by nextAction.
const WAITING = {
  AWAIT_ORACLE: 'round in progress (draw, beacons, commits or reveals) - wait',
  AWAIT_EARLIER: 'passes, but an earlier submission by another hunter still holds priority - retry once it resolves',
  AWAIT_EXPIRY: 'awaiting a re-run that would revert (another round already passes) - expire it once its window closes',
  AWAIT_SLOT: 'evaluation slots full (64 rounds in flight) - retry later',
  RERUN: 'soft fail / no result: may re-run within its 2 h window (--rerun, as the hunter or bond funder)',
  DRAW: 'jury not drawn yet - the server keeper usually draws it (or use --move-rounds)',
  CLOSE_COMMITS: 'commit window can be closed - keeper step (or use --move-rounds)',
  PROMOTE: 'commit phase closed, promote is due - keeper step (or use --move-rounds)',
};

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    bountyId: null,
    passedOnly: false,
    rerun: false,
    moveRounds: false,
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
      case '--rerun':
        options.rerun = true;
        break;
      case '--move-rounds':
        options.moveRounds = true;
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
Claim Results Script (BountyEscrow v2)

CLI equivalent of "Claim Results" in the GUI. The default mode walks every
submission holding payout priority (in evaluation or awaiting a re-run) and
sends the call the escrow's lens says will succeed now (nextAction):

  FINALIZE      finalizeSubmission: the round has a result, judged Q-of-N.
                A pass is paid and returns the bond; a soft fail awaits a
                re-run (2 h window, up to 6 rounds); a hard fail forfeits
                the bond to the creator.
  CLOSE_FAILED  closeFailedRound: the round ended (or must end) with no
                result; the submission keeps its place and bond and may
                re-run.
  EXPIRE_RERUN  expireRerun: a re-run was not taken in time; the submission
                fails and its bond is returned.
  RERUN         rerunSubmission, only with --rerun and only where this wallet
                is the hunter or the bond funder (attaches requiredPrepay).
  DRAW / CLOSE_COMMITS / PROMOTE
                round steps the server's keeper normally sends; only with
                --move-rounds.
Anything else (AWAIT_ORACLE, AWAIT_EARLIER, AWAIT_SLOT, ...) is reported
and skipped.

Two extra modes for windowed bounties (creator approval window):
  --approve         As bounty creator: bulk-approve submissions whose creator
                    approval window is still open. Pays the creator
                    determination amount to each hunter.
  --start-expired   For ANY caller: bulk-call startPreparedSubmission on
                    PendingCreatorApproval submissions whose window has
                    expired. Attaches startValue(bountyId) from the calling
                    wallet: the round's prepay (unspent part refunded) plus
                    the hunter bond (returned unless a hard fail forfeits it).
                    The jury is then drawn by the server keeper, or by
                    running this script with --move-rounds.

Usage:
  node scripts/claimResults.js [options]

Options:
  --dry-run, -d          Show what would happen without executing
  --bounty-id, -b <id>   Only process a specific bounty (on-chain ID)
  --passed-only, -p      Default mode: only finalize passing results
                         (skip every other step)
  --rerun                Default mode: also re-run soft-failed / no-result
                         submissions this wallet may re-run
  --move-rounds          Default mode: also send DRAW / CLOSE_COMMITS / PROMOTE
  --approve              Mode: bulk-approve as creator (window must be open)
  --start-expired        Mode: bulk-start expired creator-approval windows
  --help, -h             Show this help message

Examples:
  node scripts/claimResults.js                      # finalize / close / expire what is due
  node scripts/claimResults.js --dry-run
  node scripts/claimResults.js --bounty-id 2
  node scripts/claimResults.js --passed-only
  node scripts/claimResults.js --rerun              # also re-run your soft fails
  node scripts/claimResults.js --move-rounds        # also draw / close commits / promote
  node scripts/claimResults.js --approve            # approve open creator windows
  node scripts/claimResults.js --approve --dry-run
  node scripts/claimResults.js --start-expired      # start expired windows (uses your ETH)
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

/**
 * Helper to decode contract revert reasons.
 */
function decodeError(error, contract) {
  let msg = error.reason || error.shortMessage || error.message;
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

/** Scores (0..1e6, [reject, accept] or one value) as percentages, or null. */
function scoresToPercent(scores) {
  const v = Array.from(scores || []).map(Number);
  if (v.length === 2) return { acceptance: v[1] / 10000, rejection: v[0] / 10000 };
  if (v.length === 1) return { acceptance: v[0] / 10000, rejection: 100 - v[0] / 10000 };
  return null;
}

/**
 * Every submission holding payout priority (PendingVerdikta or AwaitingRerun, from
 * pendingSubmissionIds) with the lens's view of it: nextAction and getOracleResult.
 */
async function findActionableSubmissions(contract, targetBountyId = null) {
  const found = [];
  const bountyCount = Number(await contract.bountyCount());

  console.log(`Scanning ${bountyCount} bounties...`);

  for (let bountyId = 0; bountyId < bountyCount; bountyId++) {
    if (targetBountyId !== null && bountyId !== targetBountyId) continue;

    let bounty, ids;
    try {
      [bounty, ids] = await Promise.all([contract.getBounty(bountyId), contract.pendingSubmissionIds(bountyId)]);
    } catch {
      continue;
    }
    ids = Array.from(ids).map(Number).sort((a, b) => a - b);

    for (const subId of ids) {
      try {
        const [sub, nextAction, r] = await Promise.all([
          contract.getSubmission(bountyId, subId),
          contract.nextAction(bountyId, subId),
          contract.getOracleResult(bountyId, subId),
        ]);
        found.push({
          bountyId,
          submissionId: subId,
          hunter: sub.hunter,
          bondFunder: sub.bondFunder,
          status: SUBMISSION_STATUS[Number(sub.status)] || `Unknown(${sub.status})`,
          nextAction: String(nextAction),
          aggId: sub.verdiktaAggId,
          outcome: OUTCOMES[Number(r.outcome)] || 'unknown',
          phase: PHASES[Number(r.phase)] || 'unknown',
          rounds: Number(r.rounds),
          passCount: Number(r.passCount),
          scores: r.hasResult ? scoresToPercent(r.scores) : null,
          rerunDeadline: Number(sub.rerunDeadline),
          threshold: Number(bounty.threshold),
          quota: Number(bounty.quota),
          forfeitLine: Number(bounty.forfeitLine),
          bountyStatus: BOUNTY_STATUS[Number(bounty.status)] || `Unknown(${bounty.status})`,
        });
      } catch {
        continue;
      }
    }
  }

  return found;
}

async function gasLimitFor(contractFn, args, overrides) {
  try {
    const est = await contractFn.estimateGas(...args, overrides);
    const withMargin = (BigInt(est) * (100n + GAS_MARGIN_PCT)) / 100n;
    return withMargin > GAS_LIMIT_MIN ? withMargin : GAS_LIMIT_MIN;
  } catch (error) {
    // The simulation reverted: surface that instead of sending a doomed tx.
    error.simulation = true;
    throw error;
  }
}

/** Send one step (see STEP_CALLS) for a submission. */
async function sendStep(contract, wallet, sub, dryRun) {
  const spec = STEP_CALLS[sub.nextAction];
  let target = contract;
  let args = [sub.bountyId, sub.submissionId];
  const overrides = {};

  if (spec.target === 'aggregator') {
    const aggAddr = await contract.aggregator();   // one aggregator serves every bounty
    target = new ethers.Contract(aggAddr, AGGREGATOR_ABI, wallet);
    args = [sub.aggId];
  }
  if (spec.fn === 'rerunSubmission') {
    overrides.value = await contract.requiredPrepay(sub.bountyId);   // live
  }

  const label = `${spec.fn}(${args.join(', ')})${overrides.value != null ? ` with ${ethers.formatEther(overrides.value)} ETH` : ''}`;
  if (dryRun) {
    console.log(`    [DRY RUN] Would call ${label}`);
    return { success: true, dryRun: true };
  }

  try {
    if (overrides.value != null) {
      const bal = await wallet.provider.getBalance(wallet.address);
      if (bal < overrides.value) {
        return { success: false, error: `Insufficient ETH: need ${ethers.formatEther(overrides.value)}, have ${ethers.formatEther(bal)}` };
      }
    }
    const gasLimit = await gasLimitFor(target[spec.fn], args, overrides);
    console.log(`    Sending ${label} (gas limit ${gasLimit})...`);
    const tx = await target[spec.fn](...args, { ...overrides, gasLimit });
    console.log(`    Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`    Confirmed in block ${receipt.blockNumber}`);
    return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  } catch (error) {
    return { success: false, error: (error.simulation ? 'simulation reverted: ' : '') + decodeError(error, target) };
  }
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
          bondEth: ethers.formatEther(bounty.bond),
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

async function startExpiredSubmission(contract, wallet, bountyId, submissionId, dryRun) {
  // v2: the start attaches startValue(bountyId) = requiredPrepay + the hunter bond, read live
  // (the prepare-time ethMaxBudget is only the prepay estimate and would revert "wrong eth amount").
  const value = await contract.startValue(bountyId);
  const prepay = await contract.requiredPrepay(bountyId);
  const valueStr = `${ethers.formatEther(value)} ETH = prepay ${ethers.formatEther(prepay)} + bond ${ethers.formatEther(value - prepay)}`;

  if (dryRun) {
    console.log(`    [DRY RUN] Would call startPreparedSubmission(${bountyId}, ${submissionId}) with ${valueStr}`);
    return { success: true, dryRun: true };
  }

  try {
    const ethBalance = await wallet.provider.getBalance(wallet.address);
    if (ethBalance < value) {
      return {
        success: false,
        error: `Insufficient ETH: need ${ethers.formatEther(value)}, have ${ethers.formatEther(ethBalance)}`,
      };
    }

    console.log(`    Sending startPreparedSubmission tx (${valueStr})...`);
    const tx = await contract.startPreparedSubmission(bountyId, submissionId, { value });
    console.log(`    Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`    Confirmed in block ${receipt.blockNumber}`);
    return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  } catch (error) {
    return { success: false, error: decodeError(error, contract) };
  }
}

function formatSecondsRemaining(seconds) {
  if (seconds <= 0) return 'expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${s}s`;
}

/** Whether the default mode acts on this submission (and if not, why). */
function plan(sub, wallet, options) {
  const spec = STEP_CALLS[sub.nextAction];
  if (!spec) return { act: false, why: WAITING[sub.nextAction] || sub.nextAction };
  if (options.passedOnly && !(sub.nextAction === 'FINALIZE' && sub.outcome === 'pass')) {
    return { act: false, why: '--passed-only: not a passing result' };
  }
  if (spec.flag && !options[spec.flag]) return { act: false, why: WAITING[sub.nextAction] };
  if (sub.nextAction === 'RERUN') {
    const me = wallet.address.toLowerCase();
    if (sub.hunter.toLowerCase() !== me && String(sub.bondFunder).toLowerCase() !== me) {
      return { act: false, why: 'may re-run, but only its hunter or bond funder can' };
    }
  }
  return { act: true };
}

async function runResolveMode(contract, wallet, options) {
  console.log('Mode: Resolve submissions (lens nextAction)\n');

  const subs = await findActionableSubmissions(contract, options.bountyId);
  if (subs.length === 0) {
    console.log('No submissions in evaluation or awaiting a re-run.');
    return 0;
  }

  console.log(`Found ${subs.length} submission(s) in evaluation or awaiting a re-run:\n`);

  const counts = { sent: 0, failed: 0, skipped: 0 };
  const byAction = {};

  for (const sub of subs) {
    byAction[sub.nextAction] = (byAction[sub.nextAction] || 0) + 1;
    console.log(`[Bounty ${sub.bountyId} / Submission ${sub.submissionId}]`);
    console.log(`  Hunter:      ${sub.hunter}`);
    console.log(`  Status:      ${sub.status} (round ${sub.rounds}, phase ${sub.phase})`);
    if (sub.scores) {
      console.log(`  Score:       ${sub.scores.acceptance.toFixed(1)}% acceptance / ${sub.scores.rejection.toFixed(1)}% rejection`);
    }
    if (sub.outcome !== 'not_ready') {
      console.log(`  Outcome:     ${sub.outcome} (${sub.passCount} juror score(s) >= ${sub.threshold}%; pass at Q=${sub.quota}, bond forfeited below R=${sub.forfeitLine})`);
    }
    if (sub.status === 'AwaitingRerun') {
      console.log(`  Re-run by:   ${new Date(sub.rerunDeadline * 1000).toISOString()}`);
    }
    console.log(`  Bounty:      ${sub.bountyStatus}`);
    console.log(`  nextAction:  ${sub.nextAction}`);

    const p = plan(sub, wallet, options);
    if (!p.act) {
      console.log(`  Skipped:     ${p.why}\n`);
      counts.skipped++;
      continue;
    }

    const result = await sendStep(contract, wallet, sub, options.dryRun);
    if (result.success) {
      if (!result.dryRun) {
        let after = '';
        try {
          const s = await contract.getSubmission(sub.bountyId, sub.submissionId);
          after = ` -> ${SUBMISSION_STATUS[Number(s.status)]}`;
        } catch {}
        console.log(`  ✅ Done${after}. Gas: ${result.gasUsed}`);
      }
      counts.sent++;
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      counts.failed++;
    }
    console.log('');
  }

  console.log('============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  console.log(`${options.dryRun ? 'Would send' : 'Sent'}: ${counts.sent}`);
  if (!options.dryRun) console.log(`Failed:  ${counts.failed}`);
  console.log(`Skipped: ${counts.skipped}`);
  console.log('\nBy nextAction:');
  for (const [a, n] of Object.entries(byAction)) console.log(`  ${a.padEnd(14)} ${n}`);
  if (!options.dryRun && counts.sent > 0) console.log('\nThe backend picks the changes up on its next sync (or POST .../refresh).');

  return counts.failed;
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
  console.log(`Caller: ${wallet.address} (attaches startValue from this wallet: prepay, refunded if unspent, plus the hunter bond)\n`);

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
    console.log(`  Will pay:  ${sub.arbiterPayEth} ETH if the jury passes it (Q-of-N)`);
    console.log(`  Bond:      ${sub.bondEth} ETH from your wallet (you become the bond funder)`);

    const result = await startExpiredSubmission(contract, wallet, sub.bountyId, sub.submissionId, options.dryRun);

    if (result.success) {
      if (!options.dryRun) console.log(`  ✅ Started! Gas: ${result.gasUsed} (the jury is drawn next: keeper, or --move-rounds)`);
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

  const mode = options.approve ? 'approve' : (options.startExpired ? 'start-expired' : 'resolve');

  console.log('============================================================');
  console.log('Claim Results Script (BountyEscrow v2)');
  console.log('============================================================');
  console.log(`Mode:        ${mode}`);
  console.log(`Target:      ${options.bountyId !== null ? `Bounty #${options.bountyId}` : 'All bounties'}`);
  if (mode === 'resolve') {
    console.log(`Passed Only: ${options.passedOnly ? 'Yes' : 'No'}`);
    console.log(`Re-run:      ${options.rerun ? 'Yes' : 'No'}`);
    console.log(`Move rounds: ${options.moveRounds ? 'Yes' : 'No'}`);
  }
  console.log(`Dry Run:     ${options.dryRun ? 'Yes' : 'No'}`);
  console.log('============================================================\n');

  // Validate configuration
  if (!CONFIG.privateKey) {
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

  console.log(`Wallet:      ${wallet.address}`);
  console.log(`Contract:    ${CONFIG.contractAddress}`);
  try {
    console.log(`Aggregator:  ${await contract.aggregator()} (one for every jury size)\n`);
  } catch {
    console.log('');
  }

  let exitCode = 0;
  if (mode === 'approve') {
    exitCode = await runApproveMode(contract, wallet, options);
  } else if (mode === 'start-expired') {
    exitCode = await runStartExpiredMode(contract, wallet, options);
  } else {
    exitCode = await runResolveMode(contract, wallet, options);
  }

  process.exit(exitCode > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
