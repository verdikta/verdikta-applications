#!/usr/bin/env node
// Complete bounty creation: API (build evaluation package) → on-chain (fund bounty).
// The bot wallet signs the on-chain transaction automatically.
//
// Usage:
//   node create_bounty.js --config bounty.json
//
// bounty.json example:
// {
//   "title": "Book Review: The Pragmatic Programmer",
//   "description": "Write a 500-word review...",
//   "bountyAmount": "0.001",
//   "threshold": 75,
//   "classId": 128,
//   "submissionWindowHours": 24,
//   "workProductType": "writing",
//   "rubricJson": {
//     "title": "Book Review",
//     "criteria": [
//       { "id": "quality", "label": "Quality", "description": "...", "weight": 0.5 },
//       { "id": "clarity", "label": "Clarity", "description": "...", "weight": 0.5 }
//     ],
//     "threshold": 75,
//     "forbiddenContent": []
//   },
//   "juryNodes": [
//     { "provider": "OpenAI", "model": "gpt-5.2-2025-12-11", "weight": 0.5, "runs": 1 },
//     { "provider": "Anthropic", "model": "claude-3-5-haiku-20241022", "weight": 0.5, "runs": 1 }
//   ]
// }
//
// Prerequisites:
//   - Bot onboarded (onboard.js completed)
//   - Bot wallet funded with ETH
//   - Bot registered (API key saved)

import './_env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ethers } from 'ethers';
import { getNetwork, providerFor, loadWallet, resolvePath } from './_lib.js';
import { defaultSecretsDir } from './_paths.js';

// ---- CLI args ----

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const configPath = arg('config');
if (!configPath) {
  console.error('Usage: node create_bounty.js --config bounty.json');
  console.error('See script header for bounty.json format.');
  process.exit(1);
}

// ---- Load config ----

let config;
try {
  const raw = await fs.readFile(configPath, 'utf8');
  config = JSON.parse(raw);
} catch (e) {
  console.error(`Failed to read config file: ${e.message}`);
  process.exit(1);
}

const {
  title,
  description,
  bountyAmount,
  bountyAmountUSD,
  threshold = 75,
  classId = 128,
  submissionWindowHours = 24,
  workProductType = 'writing',
  rubricJson,
  juryNodes,
} = config;

// Validate required fields
if (!title || !description) {
  console.error('Config must include "title" and "description".');
  process.exit(1);
}
if (!bountyAmount || isNaN(Number(bountyAmount)) || Number(bountyAmount) <= 0) {
  console.error('Config must include a positive "bountyAmount" (ETH).');
  process.exit(1);
}
if (!rubricJson || !Array.isArray(rubricJson.criteria) || rubricJson.criteria.length === 0) {
  console.error('Config must include "rubricJson" with at least one criterion.');
  process.exit(1);
}
if (!juryNodes || !Array.isArray(juryNodes) || juryNodes.length === 0) {
  console.error('Config must include "juryNodes" array with at least one model.');
  process.exit(1);
}

// Validate jury weights sum to ~1.0
const weightSum = juryNodes.reduce((s, n) => s + (n.weight || 0), 0);
if (Math.abs(weightSum - 1.0) > 0.01) {
  console.error(`Jury node weights must sum to 1.0 (got ${weightSum.toFixed(4)}).`);
  process.exit(1);
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
const creator = signer.address;

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

console.log(`\nCreating bounty: ${title}`);
console.log(`Network:  ${network}`);
console.log(`Creator:  ${creator}`);
console.log(`Amount:   ${bountyAmount} ETH`);
console.log(`Threshold: ${threshold}%`);
console.log(`Class:    ${classId}`);
console.log(`Window:   ${submissionWindowHours}h`);
console.log(`Jury:     ${juryNodes.map(n => `${n.provider}/${n.model}`).join(', ')}`);
console.log(`API:      ${baseUrl}`);

// ---- Step 1: Create job via API ----

console.log('\n--- Step 1: Create job via API (builds evaluation package + pins to IPFS) ---');

const apiBody = {
  title,
  description,
  creator,
  bountyAmount: String(bountyAmount),
  bountyAmountUSD: bountyAmountUSD || 0,
  threshold: Number(threshold),
  classId: Number(classId),
  submissionWindowHours: Number(submissionWindowHours),
  workProductType,
  rubricJson,
  juryNodes,
};

const apiRes = await fetch(`${baseUrl}/api/jobs/create`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Bot-API-Key': apiKey,
  },
  body: JSON.stringify(apiBody),
});

const apiData = await apiRes.json();
if (!apiRes.ok || !apiData.success) {
  console.error('API create failed:', JSON.stringify(apiData, null, 2));
  process.exit(1);
}

const jobId = apiData.job?.jobId;
const primaryCid = apiData.job?.primaryCid;

if (!primaryCid) {
  console.error('API response missing primaryCid:', JSON.stringify(apiData));
  process.exit(1);
}

console.log(`  Job ID:     ${jobId}`);
console.log(`  primaryCid: ${primaryCid}`);

// ---- Step 2: Create bounty on-chain ----

console.log('\n--- Step 2: Create bounty on-chain (bot wallet signs tx) ---');

const ESCROW = {
  'base': '0x0a6290EfA369Bbd4a9886ab9f98d7fAd7b0dc746',
  'base-sepolia': '0x0520b15Ee61C4E2A1B00bA260d8B1FBD015D2780',
};

const contractAddress = process.env.BOUNTY_ESCROW_ADDRESS || ESCROW[network];
if (!contractAddress) {
  console.error(`No escrow address for network ${network}`);
  process.exit(1);
}

const ABI = [
  'function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)',
  'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)',
];

const contract = new ethers.Contract(contractAddress, ABI, signer);
const deadline = Math.floor(Date.now() / 1000) + (Number(submissionWindowHours) * 3600);
const value = ethers.parseEther(String(bountyAmount));

console.log(`  Escrow:    ${contractAddress}`);
console.log(`  CID:       ${primaryCid}`);
console.log(`  Deadline:  ${new Date(deadline * 1000).toISOString()}`);

const tx = await contract.createBounty(primaryCid, classId, threshold, deadline, { value });
console.log(`  tx: ${tx.hash}`);
const receipt = await tx.wait();

let bountyId = null;
for (const log of (receipt.logs || [])) {
  try {
    const parsed = contract.interface.parseLog(log);
    if (parsed?.name === 'BountyCreated') {
      bountyId = String(parsed.args.bountyId ?? parsed.args[0]);
      break;
    }
  } catch {}
}

console.log(`  Confirmed in block: ${receipt.blockNumber}`);
console.log(`  On-chain bountyId:  ${bountyId ?? '(not parsed)'}`);

// ---- Done ----

console.log('\n✅ Bounty created successfully!');
console.log(`   Title:     ${title}`);
console.log(`   Job ID:    ${jobId}`);
console.log(`   Bounty ID: ${bountyId}`);
console.log(`   Amount:    ${bountyAmount} ETH`);
console.log(`   Deadline:  ${new Date(deadline * 1000).toISOString()}`);
console.log(`\n   View: ${baseUrl.replace('/api', '')}`);
