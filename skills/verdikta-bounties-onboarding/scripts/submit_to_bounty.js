#!/usr/bin/env node
// Complete submission flow: upload files → prepare → approve LINK → start → confirm.
// The bot wallet signs all three on-chain transactions automatically.
//
// Usage:
//   node submit_to_bounty.js --jobId 72 --file work_output.md
//   node submit_to_bounty.js --jobId 72 --file report.md --file appendix.md --narrative "Summary of work"
//
// Prerequisites:
//   - Bot onboarded (onboard.js completed)
//   - Bot wallet funded with ETH (gas) and LINK (evaluation fee)
//   - Bot registered (API key saved)

import './_env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ethers } from 'ethers';
import { getNetwork, providerFor, loadWallet, LINK, ERC20_ABI, resolvePath } from './_lib.js';
import { defaultSecretsDir } from './_paths.js';

// ---- CLI args ----

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function argAll(name) {
  const vals = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) {
      vals.push(process.argv[i + 1]);
    }
  }
  return vals;
}

const jobId = arg('jobId');
const files = argAll('file');
const narrative = arg('narrative', '');

if (!jobId) {
  console.error('Usage: node submit_to_bounty.js --jobId <ID> --file <path> [--file <path2>] [--narrative "..."]');
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

// Load API key
async function loadApiKey() {
  const botFile = process.env.VERDIKTA_BOT_FILE || `${defaultSecretsDir()}/verdikta-bounties-bot.json`;
  const abs = resolvePath(botFile);
  const raw = await fs.readFile(abs, 'utf8');
  const j = JSON.parse(raw);
  return j.apiKey || j.api_key || j.bot?.apiKey || j.bot?.api_key;
}

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

// ---- Helper: send transaction and wait ----

async function sendTx(label, txObj) {
  console.log(`\n→ ${label}: sending transaction...`);
  const tx = await signer.sendTransaction({
    to: txObj.to,
    data: txObj.data,
    value: txObj.value || '0',
    gasLimit: txObj.gasLimit || 500000,
  });
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ---- Step 1: Upload files to IPFS ----

console.log('\n--- Step 1: Upload files to IPFS ---');

// Build multipart form data manually using fetch + FormData
// Node 18+ has global fetch and FormData
const formData = new FormData();
formData.append('hunter', hunter);
if (narrative) formData.append('submissionNarrative', narrative);

for (const filePath of files) {
  const content = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  formData.append('files', new Blob([content]), fileName);
}

const uploadRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submit`, {
  method: 'POST',
  headers: { 'X-Bot-API-Key': apiKey },
  body: formData,
});
const uploadData = await uploadRes.json();
if (!uploadRes.ok) {
  console.error('Upload failed:', JSON.stringify(uploadData));
  process.exit(1);
}
const hunterCid = uploadData.hunterCid || uploadData.cid;
if (!hunterCid) {
  console.error('No hunterCid in response:', JSON.stringify(uploadData));
  process.exit(1);
}
console.log(`  hunterCid: ${hunterCid}`);

// ---- Step 2: Prepare submission (on-chain tx 1/3) ----

console.log('\n--- Step 2: Prepare submission (deploy EvaluationWallet) ---');

const prepareRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submit/prepare`, {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ hunter, hunterCid }),
});
const prepareData = await prepareRes.json();
if (!prepareRes.ok || !prepareData.transaction) {
  console.error('Prepare failed:', JSON.stringify(prepareData));
  process.exit(1);
}

const prepareReceipt = await sendTx('prepareSubmission', prepareData.transaction);

// Parse SubmissionPrepared event
const escrowIface = new ethers.Interface([
  'event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 linkMaxBudget)'
]);

let submissionId, evalWallet, linkMaxBudget;
for (const log of prepareReceipt.logs) {
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

await sendTx('LINK approve', approveData.transaction);

// ---- Step 4: Start evaluation (on-chain tx 3/3) ----

console.log('\n--- Step 4: Start evaluation (trigger oracle) ---');

const startRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/start`, {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ hunter }),
});
const startData = await startRes.json();
if (!startRes.ok || !startData.transaction) {
  console.error('Start failed:', JSON.stringify(startData));
  process.exit(1);
}

await sendTx('startPreparedSubmission', { ...startData.transaction, gasLimit: 4000000 });

// ---- Step 5: Confirm in API ----

console.log('\n--- Step 5: Confirm submission in API ---');

const confirmRes = await fetch(`${baseUrl}/api/jobs/${jobId}/submissions/confirm`, {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ submissionId, hunter, hunterCid }),
});
const confirmData = await confirmRes.json();
if (!confirmRes.ok) {
  console.warn('Confirm warning:', JSON.stringify(confirmData));
} else {
  console.log('  Confirmed in API.');
}

// ---- Done ----

console.log('\n✅ Submission complete!');
console.log(`   Job:          #${jobId}`);
console.log(`   Submission:   #${submissionId}`);
console.log(`   Hunter:       ${hunter}`);
console.log(`   hunterCid:    ${hunterCid}`);
console.log(`   evalWallet:   ${evalWallet}`);
console.log(`\nNext: poll for evaluation result:`);
console.log(`  curl -X POST -H "X-Bot-API-Key: ${apiKey}" ${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/refresh`);
console.log(`  curl -H "X-Bot-API-Key: ${apiKey}" ${baseUrl}/api/jobs/${jobId}/submissions/${submissionId}/evaluation`);
