#!/usr/bin/env node
// Complete submission flow: upload files → [bundle OR prepare/approve/start] → confirm.
// The bot wallet signs the on-chain transactions automatically.
//
// Usage:
//   node submit_to_bounty.js --jobId 72 --file work_output.md
//   node submit_to_bounty.js --jobId 72 --file report.md --file appendix.md --narrative "Summary of work"
//   node submit_to_bounty.js --jobId 72 --file work_output.md --bundle
//
// Optional fee parameters (forwarded to /submit/prepare):
//   --alpha 50             Reputation weight (default: API default)
//   --maxOracleFee 0.003   Max LINK per oracle call
//   --estimatedBaseCost 0.001
//   --maxFeeBasedScaling 3
//
// Flags:
//   --skip-confirm         Skip the API /confirm call (trustless on-chain-only mode)
//   --confirm-first        Use old ordering: confirm before start (fallback compatibility)
//
// Prerequisites:
//   - Bot onboarded (onboard.js completed)
//   - Bot wallet funded with ETH (gas) and LINK (evaluation fee)
//   - Bot registered (API key saved)

import './_env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  getNetwork, providerFor, loadWallet,
  escrowContract, redactApiKey, BOUNTY_ESCROW_ABI,
  arg, hasFlag, argAll, loadApiKey, sendTx,
} from './_lib.js';

const jobId = arg('jobId');
const files = argAll('file');
const narrative = arg('narrative', '');
const skipConfirm = hasFlag('skip-confirm');
const confirmFirst = hasFlag('confirm-first');
const useBundle = hasFlag('bundle');

// Optional fee parameters (forwarded to /submit/prepare)
const feeAlpha = arg('alpha');
const feeMaxOracleFee = arg('maxOracleFee');
const feeEstimatedBaseCost = arg('estimatedBaseCost');
const feeMaxFeeBasedScaling = arg('maxFeeBasedScaling');

if (!jobId) {
  console.error('Usage: node submit_to_bounty.js --jobId <ID> --file <path> [--file <path2>] [--narrative "..."]');
  console.error('Optional: --alpha N --maxOracleFee N --estimatedBaseCost N --maxFeeBasedScaling N');
  console.error('Flags:    --skip-confirm  --confirm-first  --bundle');
  process.exit(1);
}
if (files.length === 0) {
  console.error('At least one --file is required.');
  process.exit(1);
}

// Verify files exist
for (const f of files) {
  try {
    await fs.access(f);
  } catch {
    console.error(`File not found: ${f}`);
    process.exit(1);
  }
}

// ---- Setup ----

const network = getNetwork();
const baseUrl = (process.env.VERDIKTA_BOUNTIES_BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('VERDIKTA_BOUNTIES_BASE_URL not set. Run onboard.js first.');
  process.exit(1);
}

const provider = providerFor(network);
const wallet = await loadWallet();
const signer = wallet.connect(provider);
const hunter = signer.address;

const apiKey = await loadApiKey();
if (!apiKey) {
  console.error('Missing API key. Run onboard.js first.');
  process.exit(1);
}

const headers = { 'X-Bot-API-Key': apiKey };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

console.log(`\nSubmitting to bounty #${jobId}`);
console.log(`Network: ${network}`);
console.log(`Hunter:  ${hunter}`);
console.log(`API:     ${baseUrl}`);
console.log(`Files:   ${files.join(', ')}`);
if (narrative) console.log(`Narrative: ${narrative}`);
if (skipConfirm) console.log(`Mode:    --skip-confirm (trustless, no API confirm)`);
if (confirmFirst) console.log(`Mode:    --confirm-first (legacy ordering)`);
if (useBundle) console.log(`Mode:    --bundle (use submit/bundle flow)`);

// ---- Helper: call /diagnose for troubleshooting ----

async function diagnoseSubmission(subId) {
  try {
    const dRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submissions/${subId}/diagnose`, { headers });
    if (dRes.ok) {
      const diag = await dRes.json();
      console.error('\n  Diagnosis from /diagnose:');
      if (diag.issues?.length) {
        diag.issues.forEach(i => console.error(`    - [${i.severity || 'info'}] ${i.message || i}`));
      }
      if (diag.recommendations?.length) {
        console.error('  Recommendations:');
        diag.recommendations.forEach(r => console.error(`    → ${r}`));
      }
    }
  } catch { /* best-effort */ }
}

// ---- Pre-flight: verify the job is submittable ----

console.log('\n--- Step 0: Pre-flight checks ---');

// 0a. Fetch job details
const jobRes = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers });
if (!jobRes.ok) {
  console.error(`Job #${jobId} not found (HTTP ${jobRes.status}).`);
  process.exit(1);
}
const jobData = await jobRes.json();
const job = jobData.job || jobData;

if (job.status && job.status !== 'OPEN') {
  console.error(`Job #${jobId} is not OPEN (status: ${job.status}). Cannot submit.`);
  process.exit(1);
}

if (job.submissionCloseTime) {
  const deadline = new Date(typeof job.submissionCloseTime === 'number'
    ? job.submissionCloseTime * 1000
    : job.submissionCloseTime);
  if (deadline < new Date()) {
    console.error(`Job #${jobId} submission window closed at ${deadline.toISOString()}.`);
    process.exit(1);
  }
  console.log(`  Deadline: ${deadline.toISOString()}`);
}

const jobCid = job.primaryCid || job.evaluationCid;
if (!jobCid) {
  console.error(`Job #${jobId} has no primaryCid/evaluationCid. It may have been created with create_bounty_min.js (hardcoded CID) — these bounties cannot accept submissions through the API.`);
  process.exit(1);
}

console.log(`  Job status: ${job.status || 'OPEN'}`);
console.log(`  evaluationCid: ${jobCid}`);

// 0b. Validate evaluation package format
try {
  const valRes = await fetch(`${baseUrl}/api/jobs/${jobId}/validate`, { headers });
  if (valRes.ok) {
    const valData = await valRes.json();
    if (valData.valid === false) {
      const errors = (valData.issues || []).filter(i => i.severity === 'error');
      if (errors.length > 0) {
        console.error(`\n  ✖ Bounty #${jobId} evaluation package has errors:`);
        errors.forEach(e => console.error(`    - ${e.message}`));
        console.error('  Submitting to this bounty will likely fail. Aborting.');
        process.exit(1);
      }
      const warnings = (valData.issues || []).filter(i => i.severity === 'warning');
      if (warnings.length > 0) {
        console.warn('  ⚠ Validation warnings:');
        warnings.forEach(w => console.warn(`    - ${w.message}`));
      }
    } else {
      console.log('  Evaluation package: valid ✓');
    }
  }
} catch {
  console.warn('  (Could not reach /validate endpoint — skipping format check)');
}

// 0c. On-chain: verify bounty is accepting submissions
//
// The API uses a unified ID model: after reconciliation, job.jobId IS the
// on-chain bountyId. There is no separate "bountyId" field on API jobs.
// Detect on-chain linkage via job.bountyId (legacy), job.onChain, or job.txHash.
const onChainBountyId = job.bountyId ?? (job.onChain || job.txHash ? job.jobId : null);

if (onChainBountyId != null) {
  try {
    const readContract = escrowContract(network, provider);
    const accepting = await readContract.isAcceptingSubmissions(BigInt(onChainBountyId));
    if (!accepting) {
      console.error(`  ✖ On-chain bounty #${onChainBountyId} is NOT accepting submissions. Aborting.`);
      process.exit(1);
    }
    console.log(`  On-chain: accepting submissions ✓ (bountyId=${onChainBountyId})`);
  } catch (err) {
    console.warn(`  (Could not verify on-chain status: ${err.message})`);
  }
} else {
  console.warn(`  ⚠ Job not linked to chain (no onChain flag). Skipping on-chain pre-check.`);
}

// ---- Step 1: Upload files to IPFS ----

console.log('\n--- Step 1: Upload files to IPFS ---');

// Parse SubmissionPrepared event details from a tx receipt.
// Used by both the canonical prepare flow and the --bundle flow.
function parsePreparedReceipt(receipt) {
  const escrowIface = new ethers.Interface(BOUNTY_ESCROW_ABI);

  let submissionId, evalWallet, linkMaxBudget;
  for (const log of receipt.logs) {
    try {
      const parsed = escrowIface.parseLog(log);
      if (parsed?.name === 'SubmissionPrepared') {
        submissionId = Number(parsed.args.submissionId);
        evalWallet = parsed.args.evalWallet;
        linkMaxBudget = ethers.formatEther(parsed.args.linkMaxBudget);
        break;
      }
    } catch {}
  }

  return { submissionId, evalWallet, linkMaxBudget };
}

const formData = new FormData();
formData.append('hunter', hunter);
if (narrative) formData.append('submissionNarrative', narrative);

for (const filePath of files) {
  const content = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  formData.append('files', new Blob([content]), fileName);
}

const submitEndpoint = useBundle ? `${baseUrl}/api/jobs/${jobId}/submit/bundle` : `${baseUrl}/api/jobs/${jobId}/submit`;
const uploadRes = await fetch(submitEndpoint, {
  method: 'POST',
  headers: { 'X-Bot-API-Key': apiKey },
  body: formData,
});
const uploadData = await uploadRes.json();
if (!uploadRes.ok) {
  console.error('Upload failed:', JSON.stringify(uploadData));
  process.exit(1);
}

// API returns { submission: { hunterCid: "..." } } — also accept top-level for compat
const hunterCid = uploadData.submission?.hunterCid || uploadData.hunterCid || uploadData.cid;
if (!hunterCid) {
  console.error('No hunterCid in response. Expected submission.hunterCid.');
  console.error('Full response:', JSON.stringify(uploadData, null, 2));
  process.exit(1);
}
console.log(`  hunterCid: ${hunterCid}`);

let submissionId = uploadData.submission?.submissionId ?? uploadData.submissionId;
let evalWallet = uploadData.submission?.evalWallet ?? uploadData.evalWallet;
let linkMaxBudget = uploadData.submission?.linkMaxBudget ?? uploadData.linkMaxBudget;

if (useBundle) {
  console.log('\n--- Step 2: Execute bundle transaction ---');

  if (!uploadData.transaction) {
    console.error('Bundle mode was requested but /submit/bundle did not return a transaction payload.');
    console.error('Full response:', JSON.stringify(uploadData, null, 2));
    process.exit(1);
  }

  const bundleReceipt = await sendTx(signer, 'submitBundle', uploadData.transaction, {
    useApiGasLimit: true,
  });

  const parsed = parsePreparedReceipt(bundleReceipt);
  submissionId = submissionId ?? parsed.submissionId;
  evalWallet = evalWallet ?? parsed.evalWallet;
  linkMaxBudget = linkMaxBudget ?? parsed.linkMaxBudget;

  const bundleId = uploadData.bundleId || uploadData.bundle?.bundleId || uploadData.bundle?.id || null;

  console.log('\n--- Step 3: Complete bundle in API ---');
  // TODO: if the server expects a slightly different body shape, adjust here.
  // Current best guess follows the same pattern as confirm/prepare payloads.
  const completeBody = {
    bundleId,
    txHash: bundleReceipt.hash,
    hunter,
    hunterCid,
    submissionId,
    evalWallet,
  };

  const completeRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submit/bundle/complete`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(completeBody),
  });
  const completeData = await completeRes.json().catch(() => ({}));
  if (!completeRes.ok) {
    console.error('Bundle complete failed:', JSON.stringify(completeData, null, 2));
    process.exit(1);
  }

  submissionId = completeData.submission?.submissionId ?? completeData.submissionId ?? submissionId;
  evalWallet = completeData.submission?.evalWallet ?? completeData.evalWallet ?? evalWallet;
  linkMaxBudget = completeData.submission?.linkMaxBudget ?? completeData.linkMaxBudget ?? linkMaxBudget;

  if (submissionId == null) {
    console.error('Bundle flow completed but submissionId is still unknown.');
    process.exit(1);
  }

  console.log(`  submissionId: ${submissionId}`);
  if (evalWallet) console.log(`  evalWallet:   ${evalWallet}`);
  if (linkMaxBudget) console.log(`  linkBudget:   ${linkMaxBudget} LINK`);
} else {
  // ---- Step 2: Prepare submission (on-chain tx 1/3) ----

  console.log('\n--- Step 2: Prepare submission (deploy EvaluationWallet) ---');

  const prepareBody = { hunter, hunterCid };
  // Forward optional fee parameters if provided
  if (feeAlpha != null) prepareBody.alpha = Number(feeAlpha);
  if (feeMaxOracleFee != null) prepareBody.maxOracleFee = feeMaxOracleFee;
  if (feeEstimatedBaseCost != null) prepareBody.estimatedBaseCost = feeEstimatedBaseCost;
  if (feeMaxFeeBasedScaling != null) prepareBody.maxFeeBasedScaling = Number(feeMaxFeeBasedScaling);

  const prepareRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submit/prepare`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(prepareBody),
  });
  const prepareData = await prepareRes.json();
  if (!prepareRes.ok || !prepareData.transaction) {
    console.error('Prepare failed:', JSON.stringify(prepareData));
    process.exit(1);
  }

  const prepareReceipt = await sendTx(signer, 'prepareSubmission', prepareData.transaction);
  const parsed = parsePreparedReceipt(prepareReceipt);
  submissionId = parsed.submissionId;
  evalWallet = parsed.evalWallet;
  linkMaxBudget = parsed.linkMaxBudget;

  if (submissionId == null || !evalWallet) {
    console.error('Failed to parse SubmissionPrepared event from receipt.');
    console.error('Logs:', JSON.stringify(prepareReceipt.logs.map(l => ({ address: l.address, topics: l.topics }))));
    process.exit(1);
  }

  console.log(`  submissionId: ${submissionId}`);
  console.log(`  evalWallet:   ${evalWallet}`);
  console.log(`  linkBudget:   ${linkMaxBudget} LINK`);

  // ---- Step 3: Approve LINK (on-chain tx 2/3) ----

  console.log('\n--- Step 3: Approve LINK to EvaluationWallet ---');

  const approveRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submit/approve`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ evalWallet, linkAmount: linkMaxBudget }),
  });
  const approveData = await approveRes.json();
  if (!approveRes.ok || !approveData.transaction) {
    console.error('Approve failed:', JSON.stringify(approveData));
    process.exit(1);
  }

  await sendTx(signer, 'LINK approve', approveData.transaction);
}

// ---- Finalization path ----
//
// Non-bundle mode uses the documented start/confirm flow.
// Bundle mode assumes the bundled transaction already performed the on-chain submit path,
// so only the API completion + optional confirm remain.
//
// Default: try documented order. If /start fails with "not found",
// auto-fallback to confirm-first, then retry start.
// Use --confirm-first to force the legacy order.
// Use --skip-confirm for trustless on-chain-only mode.

async function doConfirm() {
  console.log('\n  → Confirming submission in API...');
  const confirmRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submissions/confirm`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ submissionId, hunter, hunterCid }),
  });
  const confirmData = await confirmRes.json();
  if (!confirmRes.ok && !confirmData?.alreadyExists) {
    console.warn('  ⚠ Confirm failed:', JSON.stringify(confirmData));
    return false;
  }
  console.log(confirmData?.alreadyExists ? '  Already confirmed in API.' : '  Confirmed in API.');
  return true;
}

async function doStart() {
  const startRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/start`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ hunter }),
  });
  const startData = await startRes.json();
  if (!startRes.ok || !startData.transaction) {
    return { ok: false, data: startData, status: startRes.status };
  }
  // Use API-recommended gasLimit for start (typically 4M gas)
  await sendTx(signer, 'startPreparedSubmission', startData.transaction, { useApiGasLimit: true });
  return { ok: true, data: startData };
}

if (useBundle) {
  if (!skipConfirm) {
    console.log('\n--- Step 4: Confirm submission in API ---');
    const confirmed = await doConfirm();
    if (!confirmed) {
      await diagnoseSubmission(submissionId);
      process.exit(1);
    }
  } else {
    console.log('\n--- Step 4: Skipping API confirm (--skip-confirm) ---');
    console.log('  Bundle tx was broadcast, but API confirm was skipped by request.');
  }
} else if (confirmFirst) {
  // Legacy order: confirm → start
  console.log('\n--- Step 4: Confirm submission in API (--confirm-first) ---');
  await doConfirm();

  console.log('\n--- Step 5: Start evaluation (trigger oracle) ---');
  const startResult = await doStart();
  if (!startResult.ok) {
    console.error('Start failed:', JSON.stringify(startResult.data));
    await diagnoseSubmission(submissionId);
    process.exit(1);
  }
} else {
  // Documented order: start → confirm (with auto-fallback)
  console.log('\n--- Step 4: Start evaluation (trigger oracle) ---');
  let startResult = await doStart();

  if (!startResult.ok) {
    // Check if it's a "not found" error that confirm-first would fix
    const errStr = JSON.stringify(startResult.data).toLowerCase();
    const isNotFound = startResult.status === 404 || errStr.includes('not found') || errStr.includes('submission');

    if (isNotFound && !skipConfirm) {
      console.warn('  ⚠ Start returned "not found" — backend may require confirm before start.');
      console.warn('  Auto-fallback: confirming first, then retrying start...');

      const confirmed = await doConfirm();
      if (confirmed) {
        startResult = await doStart();
        if (!startResult.ok) {
          console.error('Start failed after fallback confirm:', JSON.stringify(startResult.data));
          await diagnoseSubmission(submissionId);
          process.exit(1);
        }
        console.log('  (Used fallback ordering: confirm → start. Consider --confirm-first next time.)');
      } else {
        console.error('Both start and confirm failed. Submission may be stuck.');
        await diagnoseSubmission(submissionId);
        process.exit(1);
      }
    } else {
      console.error('Start failed:', JSON.stringify(startResult.data));
      await diagnoseSubmission(submissionId);
      process.exit(1);
    }
  }

  // Confirm in API after start (documented order)
  if (!skipConfirm) {
    console.log('\n--- Step 5: Confirm submission in API ---');
    await doConfirm();
  } else {
    console.log('\n--- Step 5: Skipping API confirm (--skip-confirm) ---');
    console.log('  On-chain submission is active. API may not track this submission.');
  }
}

// ---- Done ----

const safeKey = redactApiKey(apiKey);
console.log('\n✅ Submission complete!');
console.log(`   Job:          #${jobId}`);
console.log(`   Submission:   #${submissionId}`);
console.log(`   Hunter:       ${hunter}`);
console.log(`   hunterCid:    ${hunterCid}`);
console.log(`   evalWallet:   ${evalWallet}`);
console.log(`\nNext: poll for evaluation result:`);
console.log(`  curl -X POST -H "X-Bot-API-Key: ${safeKey}" ${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/refresh`);
console.log(`  curl -H "X-Bot-API-Key: ${safeKey}" ${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/evaluation`);
console.log(`\nOr run: node claim_bounty.js --jobId ${jobId} --submissionId ${submissionId}`);
