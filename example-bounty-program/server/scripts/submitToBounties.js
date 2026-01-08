#!/usr/bin/env node
/**
 * AI-Powered Bounty Submission Script
 *
 * Fetches open bounties, uses AI to generate content matching the rubric,
 * and submits the work. Useful for testing the full bounty workflow.
 *
 * Usage:
 *   node scripts/submitToBounties.js --count 1
 *   node scripts/submitToBounties.js --count 3 --bounty-id 5
 *   node scripts/submitToBounties.js --count 1 --dry-run
 *
 * Environment Variables Required (in .env or .env.secret):
 *   ANTHROPIC_API_KEY - API key for Claude AI
 *   PRIVATE_KEY - Private key for signing transactions (without 0x prefix)
 *   BOUNTY_ESCROW_ADDRESS - Contract address
 *
 * Optional:
 *   AI_MODEL - Claude model to use (default: claude-sonnet-4-20250514)
 *   API_URL / HOST+PORT - Backend API URL
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
} else {
  console.log('⚠ Secrets file not found:', secretsPath);
}

const { ethers } = require('ethers');

// =============================================================================
// CONFIGURATION
// =============================================================================

const buildApiUrl = () => {
  if (process.env.API_URL) return process.env.API_URL;
  const host = process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost');
  const port = process.env.PORT || '5005';
  return `http://${host}:${port}`;
};

const CONFIG = {
  apiUrl: buildApiUrl(),
  rpcUrl: process.env.RPC_PROVIDER_URL || process.env.RPC_URL || 'https://sepolia.base.org',
  contractAddress: process.env.BOUNTY_ESCROW_ADDRESS,
  privateKey: process.env.PRIVATE_KEY,
  chainId: parseInt(process.env.CHAIN_ID || '84532'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
};

// =============================================================================
// RETRY HELPER
// =============================================================================

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.baseDelayMs - Base delay in milliseconds (default: 2000)
 * @param {string} options.label - Label for logging (default: 'operation')
 * @returns {Promise<any>} - Result of the function
 */
// Errors that should not be retried (definitive failures, not transient)
const NON_RETRYABLE_ERRORS = [
  'another submission already passed',
  'bounty not open',
  'deadline passed',
  'not prepared',
  'only hunter',
];

function isRetryableError(error) {
  const msg = (error.message || '').toLowerCase();
  const reason = (error.reason || '').toLowerCase();
  const combined = msg + ' ' + reason;
  return !NON_RETRYABLE_ERRORS.some(pattern => combined.includes(pattern));
}

async function withRetry(fn, { maxRetries = 3, baseDelayMs = 2000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on definitive failures
      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`    ⚠ ${label} failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
        console.log(`    Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    count: 1,
    bountyId: null,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--count':
      case '-c':
        options.count = parseInt(args[++i]) || 1;
        break;
      case '--bounty-id':
      case '-b':
        options.bountyId = parseInt(args[++i]);
        break;
      case '--dry-run':
      case '-d':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
AI-Powered Bounty Submission Script

Usage:
  node scripts/submitToBounties.js [options]

Options:
  --count, -c <n>       Number of submissions to make (default: 1)
  --bounty-id, -b <id>  Target specific bounty by on-chain ID
  --dry-run, -d         Show what would be submitted without actually submitting
  --help, -h            Show this help message
        `);
        process.exit(0);
    }
  }

  return options;
}

// =============================================================================
// API HELPERS
// =============================================================================

async function fetchOpenBounties() {
  const response = await fetch(`${CONFIG.apiUrl}/api/jobs?status=OPEN`);
  if (!response.ok) throw new Error(`Failed to fetch bounties: ${response.status}`);
  const data = await response.json();
  return data.jobs || [];
}

async function fetchBountyDetails(jobId) {
  const response = await fetch(`${CONFIG.apiUrl}/api/jobs/${jobId}?includeRubric=true`);
  if (!response.ok) throw new Error(`Failed to fetch bounty ${jobId}: ${response.status}`);
  const data = await response.json();
  return data.job;
}

/**
 * Check if a bounty is still winnable (no passing submissions yet)
 * Returns: { winnable: boolean, reason?: string, submission?: object }
 */
function isBountyWinnable(bounty) {
  if (!bounty.submissions || bounty.submissions.length === 0) {
    return { winnable: true };
  }

  const threshold = bounty.threshold || 80;

  // Check if any submission has already passed (finalized)
  // Check both backend status and on-chain status
  const passingStatuses = ['PassedPaid', 'PassedUnpaid', 'APPROVED', 'ACCEPTED'];
  const passedSubmission = bounty.submissions.find(s =>
    passingStatuses.includes(s.status) || passingStatuses.includes(s.onChainStatus)
  );

  if (passedSubmission) {
    return { winnable: false, reason: 'finalized winner', submission: passedSubmission };
  }

  // Check if any submission has a passing score (even if not finalized yet)
  const passingScoreSubmission = bounty.submissions.find(s => {
    const score = s.acceptance ?? s.score;
    return score != null && score >= threshold;
  });

  if (passingScoreSubmission) {
    return { winnable: false, reason: 'passing score (not finalized)', submission: passingScoreSubmission };
  }

  // Note: We allow submissions even when there are pending evaluations.
  // The on-chain contract's _requireNoPassingSubmission check will query Verdikta
  // directly and revert if another submission has already passed.
  // This lets multiple hunters race fairly - only the first to pass wins.

  return { winnable: true };
}

async function fetchFromIPFS(cid) {
  const gateways = [
    process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
    CONFIG.ipfsGateway,
  ];

  for (const gateway of gateways) {
    try {
      const response = await fetch(`${gateway}/ipfs/${cid}`, { timeout: 15000 });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await response.json();
        }
        return await response.text();
      }
    } catch (e) {
      continue;
    }
  }
  throw new Error(`Failed to fetch CID ${cid} from IPFS`);
}

// =============================================================================
// AI CONTENT GENERATION
// =============================================================================

async function generateContent(bounty, rubric) {
  if (!CONFIG.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in environment');
  }

  const prompt = buildPrompt(bounty, rubric);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.aiModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

function buildPrompt(bounty, rubric) {
  let rubricText = '';

  if (rubric) {
    if (rubric.criteria) {
      rubricText = '\n\nGRADING CRITERIA:\n';
      for (const [name, criterion] of Object.entries(rubric.criteria)) {
        rubricText += `\n${name.toUpperCase()}`;
        if (criterion.mustPass) rubricText += ' (MUST PASS)';
        if (criterion.weight) rubricText += ` [Weight: ${criterion.weight}%]`;
        rubricText += `\n${criterion.description || ''}\n`;
      }
    }
    if (rubric.forbiddenContent) {
      rubricText += '\n\nFORBIDDEN CONTENT (will cause automatic failure):\n';
      rubric.forbiddenContent.forEach(item => {
        rubricText += `- ${item}\n`;
      });
    }
  }

  return `You are completing a bounty task. Generate high-quality content that meets ALL the requirements.

TASK TITLE: ${bounty.title}

TASK DESCRIPTION:
${bounty.description}

WORK PRODUCT TYPE: ${bounty.workProductType || 'Written Content'}
${rubricText}

IMPORTANT INSTRUCTIONS:
1. Your response should be the ACTUAL CONTENT only - no meta-commentary
2. Make sure to address ALL grading criteria thoroughly
3. Avoid any forbidden content
4. Be thorough and professional
5. The content should be ready to submit as-is

Generate the content now:`;
}

// =============================================================================
// SUBMISSION
// =============================================================================

async function submitWork(jobId, content, hunter, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would submit ${content.length} characters to job ${jobId}`);
    console.log(`  [DRY RUN] First 200 chars: ${content.substring(0, 200)}...`);
    return { success: true, dryRun: true };
  }

  // Create a temporary file with the content
  const tmpDir = path.join(__dirname, '..', 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const filename = `submission-${Date.now()}.md`;
  const filepath = path.join(tmpDir, filename);
  await fs.promises.writeFile(filepath, content);

  try {
    // Submit via multipart form using axios (works better with form-data)
    const FormData = (await import('form-data')).default;
    const axios = (await import('axios')).default;

    const form = new FormData();
    form.append('hunter', hunter);
    form.append('submissionNarrative', 'AI-generated submission for testing purposes.');
    form.append('files', fs.createReadStream(filepath), { filename });
    form.append('fileDescriptions', JSON.stringify({ [filename]: 'AI-generated content' }));

    const response = await axios.post(
      `${CONFIG.apiUrl}/api/jobs/${jobId}/submit`,
      form,
      { headers: form.getHeaders() }
    );

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Submission failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  } finally {
    // Clean up temp file
    await fs.promises.unlink(filepath).catch(() => {});
  }
}

// =============================================================================
// BLOCKCHAIN INTERACTION
// =============================================================================

const LINK_ADDRESS = '0xE4aB69C077896252FAFBD49EFD26B5D171A32410'; // Base Sepolia LINK
const VERDIKTA_ADDRESS = '0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089'; // Base Sepolia Verdikta

const VERDIKTA_ABI = [
  'function getEvaluation(bytes32 requestId) view returns (uint256[] likelihoods, string justificationCID, bool exists)',
];

const LINK_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const BOUNTY_ESCROW_ABI = [
  'function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) returns (uint256, address, uint256)',
  'function startPreparedSubmission(uint256 bountyId, uint256 submissionId)',
  'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))',
  'function submissionCount(uint256 bountyId) view returns (uint256)',
  'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))',
  'event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 linkMaxBudget)',
];

// On-chain submission status codes
const ON_CHAIN_STATUS = {
  0: 'None',
  1: 'Prepared',
  2: 'PendingVerdikta',
  3: 'Failed',
  4: 'PassedUnpaid',
  5: 'PassedPaid',
};

async function getWallet() {
  if (!CONFIG.privateKey) {
    throw new Error('PRIVATE_KEY not set');
  }
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  return new ethers.Wallet(CONFIG.privateKey, provider);
}

/**
 * Check on-chain if any submission has already passed (status 4 or 5)
 * Also checks Verdikta for pending submissions that have passing scores
 * Returns { hasWinner, winnerInfo } where winnerInfo contains details if found
 */
async function checkOnChainWinner(provider, onChainBountyId, threshold) {
  const contract = new ethers.Contract(CONFIG.contractAddress, BOUNTY_ESCROW_ABI, provider);
  const verdikta = new ethers.Contract(VERDIKTA_ADDRESS, VERDIKTA_ABI, provider);

  // Helper to add timeout to promises
  const withTimeout = (promise, ms, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms}ms`)), ms)
      )
    ]);
  };

  try {
    const bounty = await withTimeout(
      contract.getBounty(onChainBountyId),
      10000,
      'getBounty'
    );
    const submissionCount = Number(bounty.submissions);

    if (submissionCount === 0) {
      return { hasWinner: false };
    }

    // Check each submission for passing status
    let checkedCount = 0;
    for (let i = 0; i < submissionCount; i++) {
      try {
        const sub = await withTimeout(
          contract.getSubmission(onChainBountyId, i),
          10000,
          `getSubmission(${i})`
        );
        const status = Number(sub.status);
        checkedCount++;

        // Status 3 = PassedPaid, 4 = PassedUnpaid (check both naming conventions)
        if (status === 3 || status === 4) {
          return {
            hasWinner: true,
            winnerInfo: {
              submissionId: i,
              hunter: sub.hunter,
              status: ON_CHAIN_STATUS[status] || `Status ${status}`,
              acceptance: Number(sub.acceptance),
            }
          };
        }

        // Status 1 = PendingVerdikta - check if Verdikta already has a passing score
        if (status === 1 && sub.verdiktaAggId && sub.verdiktaAggId !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          try {
            const [scores, , exists] = await withTimeout(
              verdikta.getEvaluation(sub.verdiktaAggId),
              10000,
              `getEvaluation(${i})`
            );

            if (exists && scores && scores.length >= 2) {
              // scores[1] is the acceptance score, normalize from 0-1000000 to 0-100
              const acceptance = Number(scores[1]) / 10000;
              if (acceptance >= threshold) {
                return {
                  hasWinner: true,
                  winnerInfo: {
                    submissionId: i,
                    hunter: sub.hunter,
                    status: 'PendingVerdikta (passed, awaiting finalization)',
                    acceptance: acceptance,
                  }
                };
              }
            }
          } catch (verdiktaError) {
            // Verdikta query failed, continue checking other submissions
          }
        }
      } catch (subError) {
        // Submission might have been cancelled, doesn't exist, or timed out
        // Continue checking other submissions
        continue;
      }
    }

    return { hasWinner: false, submissionCount: checkedCount };
  } catch (error) {
    // Only warn for unexpected errors (not submission fetch errors, which are handled above)
    if (!error.message?.includes('bad submissionId')) {
      console.log(`  Warning: Could not check on-chain status: ${error.message}`);
    }
    return { hasWinner: false, error: error.message };
  }
}

async function startSubmissionOnChain(wallet, bountyId, evaluationCid, hunterCid) {
  const contract = new ethers.Contract(CONFIG.contractAddress, BOUNTY_ESCROW_ABI, wallet);
  const linkToken = new ethers.Contract(LINK_ADDRESS, LINK_ABI, wallet);

  // Check LINK balance first
  const linkBalance = await linkToken.balanceOf(wallet.address);
  console.log(`    LINK balance: ${ethers.formatEther(linkBalance)} LINK`);

  // Step 1: Prepare submission on-chain
  console.log('    Preparing submission on-chain...');
  const prepareTx = await contract.prepareSubmission(
    bountyId,
    evaluationCid,
    hunterCid,
    '',                        // addendum
    500,                       // alpha (reputation weight)
    '3000000000000000',        // maxOracleFee (0.003 LINK)
    '1000000000000000',        // estimatedBaseCost (0.001 LINK)
    '3'                        // maxFeeBasedScaling
  );

  const prepareReceipt = await prepareTx.wait();
  console.log(`    Prepare tx: ${prepareReceipt.hash}`);

  // Parse the SubmissionPrepared event to get submissionId, evalWallet, linkMaxBudget
  let submissionId, evalWallet, linkMaxBudget;
  for (const log of prepareReceipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'SubmissionPrepared') {
        submissionId = parsed.args[1];
        evalWallet = parsed.args[3];
        linkMaxBudget = parsed.args[5];
        break;
      }
    } catch (e) {
      // Not our event
    }
  }

  if (submissionId == null) {
    throw new Error('Failed to parse SubmissionPrepared event');
  }

  console.log(`    Submission ID: ${submissionId}, EvalWallet: ${evalWallet}`);
  console.log(`    LINK budget: ${ethers.formatEther(linkMaxBudget)} LINK`);

  // Check if we have enough LINK
  if (linkBalance < linkMaxBudget) {
    throw new Error(`Insufficient LINK balance. Need ${ethers.formatEther(linkMaxBudget)} LINK, have ${ethers.formatEther(linkBalance)} LINK`);
  }

  // Step 2: Approve LINK tokens to the EvaluationWallet
  console.log('    Approving LINK tokens...');
  const approveTx = await linkToken.approve(evalWallet, linkMaxBudget);
  await approveTx.wait();
  console.log(`    Approval tx: ${approveTx.hash}`);

  // Step 3: Start the prepared submission (triggers Verdikta evaluation)
  console.log('    Starting evaluation...');
  const startTx = await contract.startPreparedSubmission(bountyId, submissionId);
  const startReceipt = await startTx.wait();
  console.log(`    Start tx: ${startReceipt.hash}`);

  return {
    submissionId: submissionId.toString(),
    evalWallet,
    txHash: startReceipt.hash,
    blockNumber: startReceipt.blockNumber,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const options = parseArgs();

  console.log('============================================================');
  console.log('AI-Powered Bounty Submission Script');
  console.log('============================================================');
  console.log(`Target:    ${options.bountyId ? `Bounty #${options.bountyId}` : 'Any open bounty'}`);
  console.log(`Count:     ${options.count}`);
  console.log(`AI Model:  ${CONFIG.aiModel}`);
  console.log(`Dry Run:   ${options.dryRun ? 'Yes' : 'No'}`);
  console.log('============================================================\n');

  // Validate configuration
  if (!CONFIG.anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY not set in environment');
    process.exit(1);
  }

  // Get wallet
  let wallet, hunterAddress;
  try {
    wallet = await getWallet();
    hunterAddress = wallet.address;
    console.log(`Hunter wallet: ${hunterAddress}`);
    console.log(`RPC URL: ${CONFIG.rpcUrl}`);
    console.log(`Contract: ${CONFIG.contractAddress}\n`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  // Fetch open bounties
  console.log('Fetching open bounties...');
  const bounties = await fetchOpenBounties();

  if (bounties.length === 0) {
    console.log('No open bounties found.');
    process.exit(0);
  }

  console.log(`Found ${bounties.length} open bounties.\n`);

  // Filter to target bounty if specified
  let targetBounties = bounties;
  if (options.bountyId !== null) {
    targetBounties = bounties.filter(b => b.onChainId === options.bountyId);
    if (targetBounties.length === 0) {
      console.error(`Bounty #${options.bountyId} not found or not open.`);
      process.exit(1);
    }
  }

  // Process bounties
  let submitted = 0;
  let failed = 0;
  let skipped = 0;
  let bountyIndex = 0;

  for (let i = 0; i < targetBounties.length && submitted < options.count; i++) {
    const bounty = targetBounties[i];
    bountyIndex++;
    console.log(`\n[${bountyIndex}] Checking: ${bounty.title}`);
    console.log(`  Job ID: ${bounty.jobId}, On-chain ID: ${bounty.onChainId}`);

    try {
      // Fetch full bounty details including rubric
      console.log('  Fetching bounty details...');
      const details = await fetchBountyDetails(bounty.jobId);

      // Check if bounty is still winnable based on backend data
      const winnableCheck = isBountyWinnable(details);

      if (!winnableCheck.winnable) {
        const sub = winnableCheck.submission;
        const score = sub?.acceptance ?? sub?.score;
        console.log(`  ⏭️  Skipping - ${winnableCheck.reason}`);
        if (sub) {
          console.log(`     Submission #${sub.submissionId}: ${sub.hunter?.slice(0, 10)}... (Score: ${score ?? 'N/A'}%, Status: ${sub.status})`);
        }
        skipped++;
        continue;
      }

      // Double-check on-chain status (backend might be out of sync with Verdikta)
      console.log('  Checking on-chain status...');
      const onChainCheck = await checkOnChainWinner(wallet.provider, bounty.onChainId, details.threshold || 70);
      if (onChainCheck.hasWinner) {
        const info = onChainCheck.winnerInfo;
        console.log(`  ⏭️  Skipping - on-chain winner detected`);
        console.log(`     Submission #${info.submissionId}: ${info.hunter?.slice(0, 10)}... (Score: ${info.acceptance}%, Status: ${info.status})`);
        skipped++;
        continue;
      }

      console.log(`  ✓ Bounty is winnable, proceeding with submission...`);

      // Get rubric if available
      let rubric = details.rubricContent;
      if (!rubric && details.rubricCid) {
        try {
          console.log('  Fetching rubric from IPFS...');
          rubric = await fetchFromIPFS(details.rubricCid);
        } catch (e) {
          console.log(`  Warning: Could not fetch rubric: ${e.message}`);
        }
      }

      // Generate content using AI
      console.log('  Generating content with AI...');
      const content = await generateContent(details, rubric);
      console.log(`  Generated ${content.length} characters`);

      // Submit the work to backend
      console.log('  Submitting work to backend...');
      const result = await submitWork(bounty.jobId, content, hunterAddress, options.dryRun);

      if (result.success) {
        const hunterCid = result.submission?.hunterCid;
        console.log(`  Backend submission successful!`);
        if (hunterCid) {
          console.log(`  Hunter CID: ${hunterCid}`);
        }

        // Now start on-chain if not dry run
        if (!options.dryRun && hunterCid) {
          console.log('  Starting on-chain submission...');
          const evaluationCid = details.primaryCid;
          if (!evaluationCid) {
            throw new Error('No evaluation CID found for this bounty');
          }

          const chainResult = await withRetry(
            () => startSubmissionOnChain(wallet, bounty.onChainId, evaluationCid, hunterCid),
            { maxRetries: 3, baseDelayMs: 3000, label: 'On-chain submission' }
          );

          console.log(`  ✅ Evaluation started on-chain!`);
          console.log(`  On-chain submission ID: ${chainResult.submissionId}`);
          console.log(`  Transaction: ${chainResult.txHash}`);

          // Sync backend with on-chain status
          console.log('  Syncing backend status...');
          try {
            const refreshResponse = await fetch(
              `${CONFIG.apiUrl}/api/jobs/${bounty.jobId}/submissions/${chainResult.submissionId}/refresh`,
              { method: 'POST' }
            );
            if (refreshResponse.ok) {
              const refreshData = await refreshResponse.json();
              console.log(`  Backend synced: ${refreshData.submission?.status}`);
            }
          } catch (e) {
            console.log(`  Warning: Could not sync backend: ${e.message}`);
          }
        } else if (options.dryRun) {
          console.log(`  ✅ [DRY RUN] Would start evaluation on-chain`);
        }

        submitted++;
      }
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      failed++;
    }
  }

  // Summary
  console.log('\n============================================================');
  console.log('SUMMARY');
  console.log('============================================================');
  console.log(`Submitted: ${submitted}`);
  console.log(`Skipped:   ${skipped} (already have winners)`);
  console.log(`Failed:    ${failed}`);

  if (!options.dryRun && submitted > 0) {
    console.log('\nSubmissions are now being evaluated by Verdikta.');
    console.log('Check the web UI to see results when ready.');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
