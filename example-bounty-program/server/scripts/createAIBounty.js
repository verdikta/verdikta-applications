#!/usr/bin/env node
/**
 * AI-Generated Bounty Creation Script
 *
 * Uses Claude to generate a unique creative-writing bounty problem (title +
 * description + rubric), then creates the bounty via the backend API and
 * on-chain. A small-but-real bounty so you can exercise the full create flow.
 *
 * Usage:
 *   NETWORK=base node scripts/createAIBounty.js --dry-run
 *   NETWORK=base node scripts/createAIBounty.js
 *   NETWORK=base node scripts/createAIBounty.js --amount 0.001 --hours 24 --threshold 70
 *   NETWORK=base node scripts/createAIBounty.js --amount 0.02 --bounty-class medium --eth-usd 2300
 *
 * Size class (v2 BountyEscrow): --bounty-class picks a preset from shared/classPresets.js (jury,
 * pass quota Q, forfeit line R, hunter bond, fee floor, beacons); --jury/--quota/--forfeit-line/
 * --bond/--fee-floor/--beacons override it. Default: the smallest class for the bounty's USD value.
 *
 * Environment Variables Required:
 *   ANTHROPIC_API_KEY  Claude API key (used to generate the bounty problem)
 *   PRIVATE_KEY        Wallet private key for on-chain createBounty
 *   NETWORK            base | base-sepolia (defaults from server config)
 *   BOT_API_KEY        Backend API auth token
 */

const path = require('path');
const fs = require('fs');

// Load env in the same order as the other scripts
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const secretsPath = path.join(__dirname, '..', '..', '..', '..', 'secrets', '.env.secrets');
if (fs.existsSync(secretsPath)) {
  require('dotenv').config({ path: secretsPath, override: true });
  console.log('✓ Loaded secrets from:', secretsPath);
} else {
  console.log('⚠ Secrets file not found:', secretsPath);
}

const { ethers } = require('ethers');
const { config: serverConfig } = require('../config');

// =============================================================================
// CONFIG
// =============================================================================

const buildApiUrl = () => {
  if (process.env.API_URL) return process.env.API_URL;
  const host = process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost');
  const port = serverConfig.network === 'base' ? 5005 : 5006;
  return `http://${host}:${port}`;
};

const CONFIG = {
  apiUrl: buildApiUrl(),
  rpcUrl: serverConfig.rpcUrl,
  contractAddress: serverConfig.bountyEscrowAddress,
  privateKey: process.env.PRIVATE_KEY,
  chainId: serverConfig.chainId,
  network: serverConfig.network,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-5-20250929',
  botApiKey: process.env.BOT_API_KEY,
};

// v2 BountyEscrow (merged escrow + lens ABI): createBounty takes ONE CreateParams struct, with
// oracle.minOracleFee / oracle.withBeacons, jury, quota (Q), forfeitLine (R) and the hunter bond.
const BOUNTY_ESCROW_ABI = require('../../onchain/abi/BountyEscrow.json');

// Size-class presets, the same the API and website use (GET /api/classes/presets).
const { CLASS_PRESETS, presetByKey, presetForBounty, toBountyParams } = require('../../shared/classPresets');
const { getEthPriceUsd } = require('../utils/ethPrice');

// Creator-chosen oracle settings: prefer what the API persisted on the job so the
// on-chain bounty and the backend record agree; fall back to server defaults and
// `cls` (the resolved size class).
function oracleParamsFromJob(job, cls = null) {
  const o = job?.oracleSettings;
  const d = serverConfig.submissionDefaults;
  return {
    maxOracleFee: BigInt(String(o?.maxOracleFee ?? d.maxOracleFeeWei)),
    alpha: BigInt(String(o?.alpha ?? d.alpha)),
    estimatedBaseCost: BigInt(String(o?.estimatedBaseCost ?? d.estimatedBaseCostWei)),
    maxFeeBasedScaling: BigInt(String(o?.maxFeeBasedScaling ?? d.maxFeeBasedScaling)),
    minOracleFee: BigInt(String(o?.minOracleFee ?? cls?.minOracleFee ?? '0')),
    withBeacons: Boolean(o?.withBeacons ?? cls?.withBeacons ?? false),
  };
}

// The v2 decision settings the API persisted (job.decisionSettings), else `cls`.
function decisionParamsFromJob(job, cls = null) {
  const s = job?.decisionSettings || cls || {};
  return {
    jury: BigInt(s.jury ?? 0),
    quota: BigInt(s.quota ?? 1),
    forfeitLine: BigInt(s.forfeitLine ?? 0),
    bond: BigInt(String(s.bond ?? '0')),
  };
}

/** Decimal ETH ("0.002") or integer wei ("2000000000000000"), as a wei BigInt. */
function parseEthOrWei(value, name) {
  const s = String(value ?? '').trim();
  if (/^\d+$/.test(s)) return BigInt(s);
  if (/^\d*\.\d+$/.test(s)) return ethers.parseEther(s);
  throw new Error(`${name} must be decimal ETH (e.g. 0.002) or integer wei`);
}

/**
 * Resolve the size class and its overrides from the CLI: { key, ethUsd, jury, quota, forfeitLine,
 * bond, minOracleFee, withBeacons } (wei as strings). The class defaults to the smallest one offered
 * for the bounty's USD value; USD amounts convert at --eth-usd, ETH_USD, or the server's price feed.
 */
async function resolveClassSettings(options, amountEth) {
  let ethUsd = options.ethUsd || Number(process.env.ETH_USD) || null;
  if (!ethUsd) {
    try {
      const p = await getEthPriceUsd();
      if (p.usd > 0) ethUsd = p.usd;
    } catch {}
  }
  const key = options.bountyClass || (ethUsd ? presetForBounty(amountEth * ethUsd).key : 'small');
  const preset = presetByKey(key);
  if (!preset) throw new Error(`--bounty-class must be one of ${CLASS_PRESETS.map((c) => c.key).join(', ')}`);
  const needsPrice = (preset.bondUsd > 0 && options.bond == null) || (preset.feeFloorUsd > 0 && options.feeFloor == null);
  if (needsPrice && !ethUsd) {
    throw new Error(`the ETH price is unavailable, so the ${preset.name} preset's USD amounts can't be converted: pass --eth-usd <price>, or --bond and --fee-floor`);
  }
  const overrides = {
    jury: options.jury, quota: options.quota, forfeitLine: options.forfeitLine,
    bond: options.bond, minOracleFee: options.feeFloor, withBeacons: options.beacons,
  };
  return { key, ethUsd, ...toBountyParams(key, ethUsd || 1, overrides) };
}

/** The API's create-body fields for a resolved class: the class, plus only the creator's overrides. */
function classBodyFields(cls, options, amountEth) {
  return {
    bountyClass: cls.key,
    // The API prices the preset itself at bountyAmountUSD / bountyAmount (the same ETH price as here).
    ...(cls.ethUsd ? { bountyAmountUSD: Number((amountEth * cls.ethUsd).toFixed(2)) } : {}),
    ...(options.jury != null ? { jury: options.jury } : {}),
    ...(options.quota != null ? { quota: options.quota } : {}),
    ...(options.forfeitLine != null ? { forfeitLine: options.forfeitLine } : {}),
    ...(options.bond != null ? { bond: options.bond } : {}),
    ...(options.feeFloor != null ? { oracleMinOracleFee: options.feeFloor } : {}),
    ...(options.beacons != null ? { oracleWithBeacons: options.beacons } : {}),
  };
}

function describeClass(cls) {
  const p = presetByKey(cls.key);
  return `${p.name} (jury ${cls.jury}, Q=${cls.quota}, R=${cls.forfeitLine}, bond ${ethers.formatEther(cls.bond)} ETH, ` +
    `fee floor ${ethers.formatEther(cls.minOracleFee)} ETH, beacons ${cls.withBeacons ? 'on' : 'off'}` +
    `${cls.ethUsd ? `, at $${cls.ethUsd}/ETH` : ''})`;
}

// Default jury: same as other scripts. Stick to verified-working models.
const DEFAULT_JURY = [
  { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', runs: 1, weight: 1.0 },
];

// =============================================================================
// ARGS
// =============================================================================

function parseArgs() {
  const out = {
    amount: 0.001,
    hours: 24,
    threshold: 70,
    classId: 128,
    model: CONFIG.aiModel,
    topic: null,
    // v2 size class (shared/classPresets.js) and overrides; null = preset value
    bountyClass: null,
    jury: null,
    quota: null,
    forfeitLine: null,
    bond: null,      // wei string
    feeFloor: null,  // wei string
    beacons: null,
    ethUsd: null,
    dryRun: false,
    help: false,
  };
  const a = process.argv.slice(2);
  const int8 = (name, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 255) { console.error(`${name} must be an integer between 0 and 255`); process.exit(1); }
    return n;
  };
  const wei = (name, v) => {
    try { return parseEthOrWei(v, name).toString(); }
    catch (e) { console.error(e.message); process.exit(1); }
  };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--bounty-class':
        out.bountyClass = a[++i];
        if (!presetByKey(out.bountyClass)) {
          console.error(`--bounty-class must be one of ${CLASS_PRESETS.map((c) => c.key).join(', ')}`);
          process.exit(1);
        }
        break;
      case '--jury':         out.jury        = int8('--jury', a[++i]); break;
      case '--quota':        out.quota       = int8('--quota', a[++i]); break;
      case '--forfeit-line': out.forfeitLine = int8('--forfeit-line', a[++i]); break;
      case '--bond':         out.bond        = wei('--bond', a[++i]); break;
      case '--fee-floor':    out.feeFloor    = wei('--fee-floor', a[++i]); break;
      case '--beacons':      out.beacons     = true; break;
      case '--no-beacons':   out.beacons     = false; break;
      case '--eth-usd':
        out.ethUsd = Number(a[++i]);
        if (!(out.ethUsd > 0)) { console.error('--eth-usd must be a positive number (USD per ETH)'); process.exit(1); }
        break;
      case '--amount':    out.amount    = parseFloat(a[++i]); break;
      case '--hours':     out.hours     = parseInt(a[++i]); break;
      case '--threshold': out.threshold = parseInt(a[++i]); break;
      case '--class':     out.classId   = parseInt(a[++i]); break;
      case '--model':     out.model     = a[++i]; break;
      case '--topic':     out.topic     = a[++i]; break;
      case '--dry-run':
      case '-d':          out.dryRun    = true; break;
      case '--help':
      case '-h':          out.help      = true; break;
      default:
        console.error('Unknown arg:', a[i]);
        out.help = true;
    }
  }
  return out;
}

function showHelp() {
  console.log(`
AI-Generated Bounty Creation

Usage:
  node scripts/createAIBounty.js [options]

Options:
  --amount <eth>       Bounty payout (default 0.001)
  --hours <n>          Submission window in hours (default 24)
  --threshold <0-100>  Acceptance threshold percent (default 70)
  --class <id>         Class ID (default 128)
  --model <model>      Claude model used to GENERATE the bounty problem
                       (default claude-sonnet-4-5-20250929; the JURY model is separate)
  --dry-run            Don't submit; print what would be created
  --help               Show this help

Size class (v2; presets in shared/classPresets.js, GET /api/classes/presets):
  --bounty-class <key>     ${CLASS_PRESETS.map((c) => c.key).join(' | ')}
                           (default: the smallest class offered for the bounty's USD value)
  --jury <index>           Approved aggregator (jury size) index, overrides the preset
  --quota <Q>              Pass quota: a round passes with >= Q juror scores at the threshold
  --forfeit-line <R>       R <= Q: fewer than R passing scores forfeits the hunter bond
  --bond <eth|wei>         Hunter bond posted at start (decimal ETH or integer wei)
  --fee-floor <eth|wei>    Fee floor (minOracleFee) every juror is paid at least
  --beacons / --no-beacons Beacon-drawn jury (the Jumbo preset sets it)
  --eth-usd <price>        ETH price for the preset's USD amounts (default: ETH_USD env,
                           else the server's price feed)
`);
}

// =============================================================================
// ANTHROPIC — generate the bounty problem statement
// =============================================================================

function buildGenerationPrompt(topic) {
  const topicLine = topic
    ? `Topic / domain: ${topic}. Generate a problem in this domain specifically.`
    : `Topic / domain: pick something fresh — not letters, not gardens. Vary across runs (math, science, history, philosophy, cooking, music, architecture, geography, languages, sports, games, puzzles, etc.). Avoid blockchain, NFTs, AI, or web3 topics — those are overused.`;

  return `You are designing a small bounty problem for a blockchain-based bounty platform. Generate a single unique, completable task that a human (or AI agent) could realistically complete and submit in plain text.

${topicLine}

Return ONLY valid JSON in exactly this shape, with no surrounding prose, no markdown fences, no code blocks:

{
  "title": "<short title, 3-8 words, no quotes>",
  "description": "<2-4 sentences describing the task. Be specific about constraints and what the submitter must hand in. If applicable, include scope (e.g. word count, problem size, expected format).>",
  "rubric_criteria": [
    {"id": "<short_snake_case>", "label": "<Title Case>", "must": false, "weight": 0.4, "description": "<one sentence>"},
    {"id": "<short_snake_case>", "label": "<Title Case>", "must": false, "weight": 0.3, "description": "<one sentence>"},
    {"id": "<short_snake_case>", "label": "<Title Case>", "must": false, "weight": 0.3, "description": "<one sentence>"}
  ]
}

Constraints:
- The 3 weights must sum to 1.0.
- All 3 criteria have "must": false.
- The title must NOT contain quotes or backslashes.
- Output JSON only. No prefix, no suffix, no markdown.`;
}

async function generateBountyContent(model, anthropicKey, topic) {
  const prompt = buildGenerationPrompt(topic);
  console.log(`  Calling Claude (${model}) to generate a unique bounty problem${topic ? ` (topic: ${topic})` : ''}...`);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  const text = (data.content?.[0]?.text || '').trim();

  // Strip markdown fences if Claude included them despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned non-JSON content. Raw:\n${text.slice(0, 600)}`);
  }

  // Sanity-check
  if (!parsed.title || !parsed.description || !Array.isArray(parsed.rubric_criteria)) {
    throw new Error(`Claude JSON missing fields. Got: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  const total = parsed.rubric_criteria.reduce((s, c) => s + (c.weight || 0), 0);
  if (Math.abs(total - 1.0) > 0.01) {
    console.log(`  Warning: rubric weights summed to ${total}; normalizing.`);
    parsed.rubric_criteria.forEach(c => { c.weight = c.weight / total; });
  }

  return parsed;
}

// =============================================================================
// BACKEND + ON-CHAIN (mirrored from createBounties.js)
// =============================================================================

function getAuthHeaders() {
  if (CONFIG.botApiKey) return { 'X-Bot-API-Key': CONFIG.botApiKey };
  return {};
}

async function createJobBackend(bountyData, creatorAddress, amount, hours, classFields = {}) {
  const payload = {
    title: bountyData.title,
    description: bountyData.description,
    creator: creatorAddress,
    bountyAmount: amount,
    threshold: bountyData.threshold,
    workProductType: bountyData.workProductType,
    classId: bountyData.classId,
    submissionWindowHours: hours,
    juryNodes: bountyData.juryNodes,
    rubricJson: bountyData.rubricJson,
    iterations: 1,
    // v2 size class + the creator's overrides (the API resolves and persists them)
    ...classFields,
  };

  const resp = await fetch(`${CONFIG.apiUrl}/api/jobs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Backend /api/jobs/create ${resp.status}: ${err}`);
  }

  return resp.json();
}

async function updateJobBountyId(jobId, bountyId, txHash, blockNumber) {
  const resp = await fetch(`${CONFIG.apiUrl}/api/jobs/${jobId}/bountyId`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ bountyId, txHash, blockNumber }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`PATCH bountyId ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function createBountyOnChain(contract, evaluationCid, classId, threshold, hours, amountEth, oracle, decision) {
  const d = decision || decisionParamsFromJob(null);
  const deadline = Math.floor(Date.now() / 1000) + (hours * 3600);
  const value = ethers.parseEther(amountEth.toString());
  console.log('    Sending transaction...');
  // Non-windowed bounty: both payments equal the amount, window 0.
  const params = {
    evaluationCid,
    requestedClass: BigInt(classId),
    threshold: BigInt(threshold),
    submissionDeadline: BigInt(deadline),
    targetHunter: ethers.ZeroAddress,
    creatorDeterminationPayment: value,
    arbiterDeterminationPayment: value,
    creatorAssessmentWindowSize: 0n,
    oracle: oracle || oracleParamsFromJob(null),
    jury: d.jury,
    quota: d.quota,
    forfeitLine: d.forfeitLine,
    bond: d.bond,
  };
  const tx = await contract.createBounty(params, { value });
  console.log(`    Tx hash: ${tx.hash}`);
  console.log('    Waiting for confirmation...');
  const receipt = await tx.wait();

  const bountyCreatedEvent = receipt.logs.find(l => {
    try { return contract.interface.parseLog(l)?.name === 'BountyCreated'; }
    catch { return false; }
  });
  let bountyId;
  if (bountyCreatedEvent) {
    bountyId = contract.interface.parseLog(bountyCreatedEvent).args[0].toString();
  }
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, bountyId };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const opts = parseArgs();
  if (opts.help) { showHelp(); process.exit(0); }

  if (!CONFIG.anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY env var is required');
    process.exit(1);
  }
  if (!opts.dryRun) {
    if (!CONFIG.privateKey) {
      console.error('Error: PRIVATE_KEY env var is required');
      process.exit(1);
    }
    if (!CONFIG.contractAddress) {
      console.error(`Error: no contract address for network "${CONFIG.network}"`);
      process.exit(1);
    }
  }

  console.log('='.repeat(60));
  console.log('AI-Generated Bounty Creation');
  console.log('='.repeat(60));
  console.log(`Network:    ${CONFIG.network}`);
  console.log(`Contract:   ${CONFIG.contractAddress || '(skipped — dry-run)'}`);
  console.log(`API:        ${CONFIG.apiUrl}`);
  console.log(`AI model:   ${opts.model}  (only for problem generation)`);
  console.log(`Amount:     ${opts.amount} ETH`);
  console.log(`Hours:      ${opts.hours}`);
  console.log(`Threshold:  ${opts.threshold}%`);
  console.log(`Class:      ${opts.classId}`);
  let cls;
  try {
    cls = await resolveClassSettings(opts, opts.amount);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  console.log(`Size class: ${describeClass(cls)}`);
  console.log(`Dry run:    ${opts.dryRun ? 'Yes' : 'No'}`);
  console.log('='.repeat(60));

  // 1) Generate the problem with Claude
  const generated = await generateBountyContent(opts.model, CONFIG.anthropicApiKey, opts.topic);

  console.log('\n  Generated:');
  console.log(`    Title:       ${generated.title}`);
  console.log(`    Description: ${generated.description}`);
  console.log(`    Rubric (${generated.rubric_criteria.length} criteria):`);
  for (const c of generated.rubric_criteria) {
    console.log(`      - ${c.label} (weight ${c.weight.toFixed(2)}): ${c.description}`);
  }

  // 2) Build the bountyData object that the backend expects
  const bountyData = {
    title: generated.title,
    description: generated.description,
    workProductType: 'Written Content',
    classId: opts.classId,
    threshold: opts.threshold,
    juryNodes: DEFAULT_JURY,
    rubricJson: {
      version: '1.0',
      title: `${generated.title} — Evaluation`,
      description: 'AI-generated rubric for this bounty',
      criteria: generated.rubric_criteria.map(c => ({
        id: c.id,
        label: c.label,
        must: !!c.must,
        weight: c.weight,
        description: c.description,
      })),
    },
  };

  if (opts.dryRun) {
    console.log('\n[DRY RUN] Would POST to', `${CONFIG.apiUrl}/api/jobs/create`);
    console.log('[DRY RUN] Would call createBounty on', CONFIG.contractAddress);
    console.log('[DRY RUN] Done — no API call to backend, no on-chain tx, no funds spent.');
    console.log('[DRY RUN] (The Anthropic call DID happen and DID bill your account.)');
    return;
  }

  // 3) Wallet setup. Use staticNetwork to skip auto-detection (Infura sometimes
  // returns malformed chainId responses on first call which breaks ethers v6).
  const network = ethers.Network.from(CONFIG.chainId);
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, network, { staticNetwork: network });
  const pk = CONFIG.privateKey.startsWith('0x') ? CONFIG.privateKey : '0x' + CONFIG.privateKey;
  const wallet = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(CONFIG.contractAddress, BOUNTY_ESCROW_ABI, wallet);

  console.log(`\n  Wallet:  ${wallet.address}`);
  // Retry balance fetch — RPC providers occasionally hiccup
  let bal = null;
  for (let i = 0; i < 4; i++) {
    try { bal = await provider.getBalance(wallet.address); break; }
    catch (e) {
      console.log(`  Balance fetch retry ${i+1}: ${e.shortMessage || e.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (bal === null) throw new Error('Could not fetch wallet balance after retries');
  console.log(`  Balance: ${ethers.formatEther(bal)} ETH`);
  if (parseFloat(ethers.formatEther(bal)) < opts.amount * 1.1) {
    console.error(`  Insufficient balance for ${opts.amount} ETH bounty + gas.`);
    process.exit(1);
  }

  // 4) Backend job
  console.log('\n  POST /api/jobs/create...');
  const job = await createJobBackend(bountyData, wallet.address, opts.amount, opts.hours, classBodyFields(cls, opts, opts.amount));
  const jobId = job?.job?.jobId ?? job?.jobId ?? job?.id;
  const evaluationCid = job?.job?.evaluationCid ?? job?.evaluationCid;
  if (!jobId || !evaluationCid) {
    throw new Error(`Backend response missing jobId/evaluationCid: ${JSON.stringify(job).slice(0,400)}`);
  }
  console.log(`    jobId:         ${jobId}`);
  console.log(`    evaluationCid: ${evaluationCid}`);

  // 5) On-chain createBounty
  console.log('\n  Creating bounty on chain...');
  const result = await createBountyOnChain(
    contract, evaluationCid, opts.classId, opts.threshold, opts.hours, opts.amount,
    oracleParamsFromJob(job?.job ?? job, cls),
    decisionParamsFromJob(job?.job ?? job, cls)
  );
  console.log(`    bountyId:    ${result.bountyId}`);
  console.log(`    txHash:      ${result.txHash}`);
  console.log(`    blockNumber: ${result.blockNumber}`);

  // 6) Link the backend job to the on-chain bounty
  console.log('\n  PATCH /api/jobs/:jobId/bountyId...');
  await updateJobBountyId(jobId, result.bountyId, result.txHash, result.blockNumber);
  console.log('    linked.');

  console.log('\n' + '='.repeat(60));
  console.log('Done.');
  console.log(`  jobId:    ${jobId}`);
  console.log(`  bountyId: ${result.bountyId}`);
  console.log(`  Title:    ${generated.title}`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('\nERROR:', e.message || e); process.exit(1); });
