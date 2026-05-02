#!/usr/bin/env node
/**
 * Bulk Bounty Creation Script
 *
 * Creates a specified number of bounties programmatically, bypassing the GUI.
 * Handles both backend job creation and on-chain bounty creation.
 *
 * Usage:
 *   node scripts/createBounties.js --count 5
 *   node scripts/createBounties.js --count 1 --class 128 --amount 0.001 --hours 1
 *   NETWORK=base-sepolia node scripts/createBounties.js --count 1 --class 128 --amount 0.001 --hours 1
 *   node scripts/createBounties.js --count 1 --template research --class 128 --amount 0.001 --threshold 90 --hours 1
 *   node scripts/createBounties.js --count 3 --template research --class 128 --amount 0.001 --threshold 70 --hours 1
 *   NETWORK=base node scripts/createBounties.js --count 1 --template research --class 128 --amount 0.001 --threshold 70 --hours 1
 *   node scripts/createBounties.js --count 3 --amount 0.001 --hours 2
 *   node scripts/createBounties.js --count 2 --template writing
 *   node scripts/createBounties.js --count 1 --threshold 50 --hours 1
 *   node scripts/createBounties.js --count 1 --dry-run
 *
 * Targeted bounties:
 *   node scripts/createBounties.js --count 1 --target 0xF6DD9256D0091c6E773EBfDFC79783f9663e65Fc
 *
 * Creator approval window (two-tier payment):
 *   node scripts/createBounties.js --count 1 --amount 0.01 --creator-pay 0.005 --window 3600
 *   node scripts/createBounties.js --count 1 --amount 0.01 --creator-pay 0.008 --arbiter-pay 0.01 --window 7200 --target 0x...
 *
 * Environment Variables Required:
 *   PRIVATE_KEY - Private key for signing transactions (without 0x prefix)
 *   RPC_URL - RPC endpoint (defaults to https://sepolia.base.org)
 *   BOUNTY_ESCROW_ADDRESS - Contract address
 *   API_URL - Backend API URL (defaults to http://localhost:5005)
 */

const path = require('path');
const fs = require('fs');

// Load main .env first
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Load secrets file if it exists (relative path: ../../../../secrets/.env.secrets)
// This resolves to the 'secrets' folder at the verdikta root level
const secretsPath = path.join(__dirname, '..', '..', '..', '..', 'secrets', '.env.secrets');
if (fs.existsSync(secretsPath)) {
  require('dotenv').config({ path: secretsPath, override: true });
}
const { ethers } = require('ethers');

// Use server config for network-aware settings
const { config: serverConfig } = require('../config');

// =============================================================================
// CONFIGURATION
// =============================================================================

// Build API URL from HOST/PORT if API_URL not set (0.0.0.0 means use localhost for requests)
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
  chainId: serverConfig.chainId,
  network: serverConfig.network,
  botApiKey: process.env.BOT_API_KEY,
};

const BOUNTY_ESCROW_ABI = [
  'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)',
  'function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter) payable returns (uint256)',
  'function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize) payable returns (uint256)',
  'function bountyCount() view returns (uint256)',
];

// =============================================================================
// BOUNTY TEMPLATES
// =============================================================================

const TEMPLATES = {
  writing: {
    titlePrefix: 'Write a Blog Post',
    descriptions: [
      'Create an engaging blog post about blockchain technology and its real-world applications.',
      'Write a technical article explaining smart contracts to beginners.',
      'Compose an opinion piece on the future of decentralized finance.',
      'Write a tutorial on getting started with Web3 development.',
      'Create a comparative analysis of different blockchain platforms.',
    ],
    workProductType: 'Written Content',
    threshold: 70,
    classId: 128,
    rubric: {
      version: '1.0',
      title: 'Written Content Evaluation',
      description: 'Evaluation criteria for written content submissions',
      criteria: [
        { id: 'clarity', label: 'Clarity', must: false, weight: 0.3, description: 'Is the writing clear, well-organized, and easy to follow?' },
        { id: 'accuracy', label: 'Technical Accuracy', must: true, weight: 0, description: 'Is the technical information accurate and well-researched?' },
        { id: 'engagement', label: 'Engagement', must: false, weight: 0.3, description: 'Is the content engaging and interesting to read?' },
        { id: 'completeness', label: 'Completeness', must: false, weight: 0.4, description: 'Does the content fully address the topic?' },
      ],
    },
  },

  code: {
    titlePrefix: 'Develop a Feature',
    descriptions: [
      'Implement a user authentication system with JWT tokens.',
      'Create a REST API endpoint for data management.',
      'Build a reusable React component library.',
      'Develop a smart contract for token staking.',
      'Implement a caching layer for improved performance.',
    ],
    workProductType: 'Source Code',
    threshold: 75,
    classId: 128,
    rubric: {
      version: '1.0',
      title: 'Code Quality Evaluation',
      description: 'Evaluation criteria for code submissions',
      criteria: [
        { id: 'functionality', label: 'Functionality', must: true, weight: 0, description: 'Does the code work correctly and meet requirements?' },
        { id: 'quality', label: 'Code Quality', must: false, weight: 0.4, description: 'Is the code clean, readable, and well-structured?' },
        { id: 'testing', label: 'Testing', must: false, weight: 0.3, description: 'Are there adequate tests with good coverage?' },
        { id: 'documentation', label: 'Documentation', must: false, weight: 0.3, description: 'Is the code properly documented?' },
      ],
    },
  },

  design: {
    titlePrefix: 'Create a Design',
    descriptions: [
      'Design a modern landing page for a DeFi application.',
      'Create a mobile app UI/UX design with user flows.',
      'Design a dashboard for analytics visualization.',
      'Create brand identity assets including logo variations.',
      'Design an intuitive onboarding experience.',
    ],
    workProductType: 'Design Assets',
    threshold: 65,
    classId: 128,
    rubric: {
      version: '1.0',
      title: 'Design Evaluation',
      description: 'Evaluation criteria for design submissions',
      criteria: [
        { id: 'aesthetics', label: 'Visual Appeal', must: false, weight: 0.3, description: 'Is the design visually appealing and professional?' },
        { id: 'usability', label: 'Usability', must: false, weight: 0.35, description: 'Is the design intuitive and user-friendly?' },
        { id: 'consistency', label: 'Consistency', must: false, weight: 0.2, description: 'Is the design consistent in style and branding?' },
        { id: 'requirements', label: 'Requirements Met', must: true, weight: 0, description: 'Does the design meet all specified requirements?' },
      ],
    },
  },

  research: {
    titlePrefix: 'Research Report',
    descriptions: [
      'Analyze market trends in the NFT space for Q4.',
      'Research and compare Layer 2 scaling solutions.',
      'Investigate security best practices for smart contracts.',
      'Study user behavior patterns in DeFi protocols.',
      'Research regulatory landscape for crypto in major markets.',
    ],
    workProductType: 'Research Document',
    threshold: 70,
    classId: 128,
    rubric: {
      version: '1.0',
      title: 'Research Evaluation',
      description: 'Evaluation criteria for research submissions',
      criteria: [
        { id: 'methodology', label: 'Methodology', must: false, weight: 0.25, description: 'Is the research methodology sound and appropriate?' },
        { id: 'depth', label: 'Depth of Analysis', must: false, weight: 0.35, description: 'Is the analysis thorough and insightful?' },
        { id: 'sources', label: 'Sources', must: true, weight: 0, description: 'Are sources credible and properly cited?' },
        { id: 'conclusions', label: 'Conclusions', must: false, weight: 0.4, description: 'Are conclusions well-supported and actionable?' },
      ],
    },
  },
};

// Default jury configuration.
// The oracle network only routes a fixed list of provider/model pairs; using
// anything outside that list produces a bounty whose submissions silently
// hang in PendingVerdikta because no node accepts the work. Verified-working
// (as of 2026): gpt-5.2-2025-12-11, gpt-5-mini-2025-08-07,
// claude-3-5-haiku-20241022. Stick to one of these for the default.
const DEFAULT_JURY = [
  { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', runs: 1, weight: 1.0 },
];

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    count: 1,
    amount: 0.001,
    hours: 24,
    template: 'writing',
    classId: 128,
    threshold: null,  // null means use template default
    target: null,     // null = open bounty, address = targeted
    creatorPay: null,  // null = same as amount (no window)
    arbiterPay: null,  // null = same as amount (no window)
    window: 0,         // creator approval window in seconds (0 = no window)
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--count':
      case '-n':
        options.count = parseInt(args[++i]) || 1;
        break;
      case '--amount':
      case '-a':
        options.amount = parseFloat(args[++i]) || 0.001;
        break;
      case '--hours':
      case '-h':
        options.hours = parseInt(args[++i]) || 24;
        break;
      case '--template':
      case '-t':
        options.template = args[++i] || 'writing';
        break;
      case '--class':
      case '-c':
        options.classId = parseInt(args[++i]) || 128;
        break;
      case '--threshold':
        options.threshold = parseInt(args[++i]);
        if (isNaN(options.threshold) || options.threshold < 0 || options.threshold > 100) {
          console.error('Error: --threshold must be a number between 0 and 100');
          process.exit(1);
        }
        break;
      case '--target':
        options.target = args[++i];
        if (!options.target || !/^0x[a-fA-F0-9]{40}$/.test(options.target)) {
          console.error('Error: --target must be a valid Ethereum address (0x + 40 hex chars)');
          process.exit(1);
        }
        break;
      case '--creator-pay':
        options.creatorPay = parseFloat(args[++i]);
        if (isNaN(options.creatorPay) || options.creatorPay <= 0) {
          console.error('Error: --creator-pay must be a positive number');
          process.exit(1);
        }
        break;
      case '--arbiter-pay':
        options.arbiterPay = parseFloat(args[++i]);
        if (isNaN(options.arbiterPay) || options.arbiterPay <= 0) {
          console.error('Error: --arbiter-pay must be a positive number');
          process.exit(1);
        }
        break;
      case '--window':
        options.window = parseInt(args[++i]);
        if (isNaN(options.window) || options.window < 0) {
          console.error('Error: --window must be a non-negative number of seconds');
          process.exit(1);
        }
        break;
      case '--dry-run':
      case '-d':
        options.dryRun = true;
        break;
      case '--help':
        options.help = true;
        break;
    }
  }

  // Resolve payment amounts
  // If creator-pay is set but arbiter-pay isn't, arbiter-pay defaults to amount
  // If arbiter-pay is set but creator-pay isn't, creator-pay defaults to amount
  if (options.creatorPay !== null || options.arbiterPay !== null || options.window > 0) {
    options.creatorPay = options.creatorPay ?? options.amount;
    options.arbiterPay = options.arbiterPay ?? options.amount;
    // A windowed bounty MUST have a positive window. Without it the contract
    // stores creator/arbiter determination payments but skips the
    // PendingCreatorApproval state entirely — submissions go straight to
    // Prepared, creatorWindowEnd is never set, and creatorApproveSubmission
    // can't engage. This is the bug pattern that hit bounties #151-153 on
    // Base. Reject the silent-no-op shape rather than let it on-chain.
    if (options.window <= 0) {
      console.error('Error: --window must be > 0 (in seconds) when --creator-pay or --arbiter-pay is set.');
      console.error('       A non-zero window is what enables the creator approval flow on-chain;');
      console.error('       without it the determination payments are stored but never used.');
      process.exit(1);
    }
    // amount must equal max of the two payments
    const maxPay = Math.max(options.creatorPay, options.arbiterPay);
    if (Math.abs(options.amount - maxPay) > 0.0000001) {
      console.log(`Note: --amount adjusted to ${maxPay} ETH (max of creator-pay and arbiter-pay)`);
      options.amount = maxPay;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Bulk Bounty Creation Script

Usage:
  node scripts/createBounties.js [options]

Options:
  --count, -n <number>     Number of bounties to create (default: 1)
  --amount, -a <eth>       Bounty amount in ETH (default: 0.001)
  --hours, -h <hours>      Submission window in hours (default: 24)
  --template, -t <name>    Template to use: writing, code, design, research (default: writing)
  --class, -c <id>         Verdikta class ID (default: 128)
  --threshold <percent>    Passing threshold 0-100 (default: from template)
  --target <address>       Target a specific hunter address (default: open to all)
  --creator-pay <eth>      Payment if creator approves (enables approval window)
  --arbiter-pay <eth>      Payment if arbiters approve (default: same as --amount)
  --window <seconds>       Creator approval window in seconds (required when payments differ)
  --dry-run, -d            Simulate without creating bounties
  --help                   Show this help message

Environment Variables:
  PRIVATE_KEY              Private key for signing transactions (required)
  RPC_URL                  RPC endpoint (default: https://sepolia.base.org)
  BOUNTY_ESCROW_ADDRESS    Contract address (required)
  API_URL                  Backend API URL (default: http://localhost:5005)

Examples:
  node scripts/createBounties.js --count 5
  node scripts/createBounties.js --count 3 --amount 0.01 --hours 48
  node scripts/createBounties.js --count 2 --template code
  node scripts/createBounties.js --count 1 --threshold 50 --hours 1
  node scripts/createBounties.js --count 1 --dry-run
  node scripts/createBounties.js --count 1 --target 0xF6DD9256D0091c6E773EBfDFC79783f9663e65Fc
  node scripts/createBounties.js --count 1 --amount 0.01 --creator-pay 0.005 --window 3600
  node scripts/createBounties.js --count 1 --amount 0.01 --creator-pay 0.008 --arbiter-pay 0.01 --window 7200 --target 0x...
`);
}

function generateBountyData(template, index, classId, thresholdOverride = null) {
  const tmpl = TEMPLATES[template] || TEMPLATES.writing;
  const descIndex = index % tmpl.descriptions.length;
  const threshold = thresholdOverride !== null ? thresholdOverride : tmpl.threshold;

  const rubric = {
    ...tmpl.rubric,
    threshold: threshold,
    classId: classId,
  };

  return {
    title: `${tmpl.titlePrefix} #${index + 1}`,
    description: tmpl.descriptions[descIndex],
    workProductType: tmpl.workProductType,
    threshold: threshold,
    classId: classId,
    rubricJson: rubric,
    juryNodes: DEFAULT_JURY,
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

function getAuthHeaders() {
  const headers = {};
  if (CONFIG.botApiKey) {
    headers['X-Bot-API-Key'] = CONFIG.botApiKey;
  }
  return headers;
}

async function createJobBackend(bountyData, creatorAddress, amount, hours, extras = {}) {
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
    // Optional fields — passed only if provided so the backend job mirrors what the on-chain create will use
    ...(extras.targetHunter ? { targetHunter: extras.targetHunter } : {}),
    ...(extras.creatorPay != null ? {
      creatorDeterminationPayment: extras.creatorPay,
      arbiterDeterminationPayment: extras.arbiterPay,
      creatorAssessmentWindowHours: extras.windowSeconds / 3600,
    } : {}),
  };

  const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };

  const response = await fetch(`${CONFIG.apiUrl}/api/jobs/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Backend API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function updateJobBountyId(jobId, bountyId, txHash, blockNumber) {
  const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };

  const response = await fetch(`${CONFIG.apiUrl}/api/jobs/${jobId}/bountyId`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ bountyId, txHash, blockNumber }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update bounty ID: ${response.status} - ${error}`);
  }

  return response.json();
}

// =============================================================================
// BLOCKCHAIN FUNCTIONS
// =============================================================================

async function createBountyOnChain(contract, evaluationCid, classId, threshold, hours, amountEth, options = {}) {
  const deadline = Math.floor(Date.now() / 1000) + (hours * 3600);
  const value = ethers.parseEther(amountEth.toString());
  const targetHunter = options.target || ethers.ZeroAddress;

  console.log(`    Sending transaction...`);

  let tx;
  if (options.creatorPay !== null && options.creatorPay !== undefined) {
    // 8-arg: windowed bounty with split payments
    const creatorPayWei = ethers.parseEther(options.creatorPay.toString());
    const arbiterPayWei = ethers.parseEther(options.arbiterPay.toString());
    const createFn = contract['createBounty(string,uint64,uint8,uint64,address,uint256,uint256,uint64)'];
    tx = await createFn(evaluationCid, classId, threshold, deadline, targetHunter, creatorPayWei, arbiterPayWei, options.window, { value });
  } else {
    // 5-arg: standard bounty
    const createFn = contract['createBounty(string,uint64,uint8,uint64,address)'];
    tx = await createFn(evaluationCid, classId, threshold, deadline, targetHunter, { value });
  }

  console.log(`    Tx hash: ${tx.hash}`);
  console.log(`    Waiting for confirmation...`);

  const receipt = await tx.wait();

  // Parse BountyCreated event
  const bountyCreatedEvent = receipt.logs.find(log => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === 'BountyCreated';
    } catch {
      return false;
    }
  });

  let bountyId;
  if (bountyCreatedEvent) {
    const parsed = contract.interface.parseLog(bountyCreatedEvent);
    bountyId = parsed.args[0].toString();
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    bountyId,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Validate configuration
  if (!options.dryRun) {
    if (!CONFIG.privateKey) {
      console.error('Error: PRIVATE_KEY environment variable is required');
      console.error('Add it to your .env file or set it in your environment');
      process.exit(1);
    }
    if (!CONFIG.contractAddress) {
      console.error(`Error: No contract address configured for network "${CONFIG.network}"`);
      console.error('Set BOUNTY_ESCROW_ADDRESS_BASE or BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA in .env');
      console.error('And run with: NETWORK=base-sepolia node scripts/createBounties.js ...');
      process.exit(1);
    }
  }

  // Validate template
  if (!TEMPLATES[options.template]) {
    console.error(`Error: Unknown template "${options.template}"`);
    console.error(`Available templates: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  // Determine effective threshold for display
  const templateThreshold = TEMPLATES[options.template]?.threshold || 70;
  const effectiveThreshold = options.threshold !== null ? options.threshold : templateThreshold;

  console.log('='.repeat(60));
  console.log('Bulk Bounty Creation Script');
  console.log('='.repeat(60));
  console.log(`Count:     ${options.count}`);
  console.log(`Amount:    ${options.amount} ETH each`);
  console.log(`Deadline:  ${options.hours} hours`);
  console.log(`Template:  ${options.template}`);
  console.log(`Class ID:  ${options.classId}`);
  console.log(`Threshold: ${effectiveThreshold}%${options.threshold !== null ? ' (override)' : ' (from template)'}`);
  console.log(`Target:    ${options.target || 'open (anyone can submit)'}`);
  if (options.creatorPay !== null) {
    console.log(`Creator Pay:  ${options.creatorPay} ETH`);
    console.log(`Arbiter Pay:  ${options.arbiterPay} ETH`);
    console.log(`Window:       ${options.window}s (${(options.window / 3600).toFixed(1)}h)`);
  }
  console.log(`Dry Run:   ${options.dryRun ? 'Yes' : 'No'}`);
  console.log('='.repeat(60));

  let wallet, contract;

  if (!options.dryRun) {
    // Setup blockchain connection
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    wallet = new ethers.Wallet(CONFIG.privateKey, provider);
    contract = new ethers.Contract(CONFIG.contractAddress, BOUNTY_ESCROW_ABI, wallet);

    console.log(`\nWallet:    ${wallet.address}`);

    const balance = await provider.getBalance(wallet.address);
    console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);

    const totalNeeded = options.count * options.amount;
    if (parseFloat(ethers.formatEther(balance)) < totalNeeded) {
      console.error(`\nError: Insufficient balance. Need at least ${totalNeeded} ETH`);
      process.exit(1);
    }
  }

  console.log('\n');

  const results = [];

  for (let i = 0; i < options.count; i++) {
    console.log(`[${i + 1}/${options.count}] Creating bounty...`);

    try {
      const bountyData = generateBountyData(options.template, i, options.classId, options.threshold);
      console.log(`  Title: ${bountyData.title}`);

      if (options.dryRun) {
        console.log(`  [DRY RUN] Would create job with:`);
        console.log(`    - Description: ${bountyData.description.substring(0, 50)}...`);
        console.log(`    - Amount: ${options.amount} ETH`);
        console.log(`    - Threshold: ${bountyData.threshold}%`);
        console.log(`    - Window: ${options.hours} hours`);
        results.push({ index: i + 1, status: 'dry-run', title: bountyData.title });
        continue;
      }

      // Step 1: Create job in backend
      console.log(`  Creating backend job...`);
      const jobResult = await createJobBackend(
        bountyData,
        wallet.address,
        options.amount,
        options.hours,
        {
          targetHunter: options.target || null,
          creatorPay: options.creatorPay,
          arbiterPay: options.arbiterPay,
          windowSeconds: options.window,
        }
      );

      if (!jobResult.success) {
        throw new Error(jobResult.error || 'Backend job creation failed');
      }

      const job = jobResult.job;
      console.log(`  Job created: ID=${job.jobId}, CID=${job.evaluationCid?.substring(0, 20)}...`);

      // Step 2: Create bounty on-chain
      console.log(`  Creating on-chain bounty...`);
      const chainResult = await createBountyOnChain(
        contract,
        job.evaluationCid,
        bountyData.classId,
        bountyData.threshold,
        options.hours,
        options.amount,
        {
          target: options.target,
          creatorPay: options.creatorPay,
          arbiterPay: options.arbiterPay,
          window: options.window,
        }
      );

      console.log(`  On-chain bounty created: ID=${chainResult.bountyId}`);
      console.log(`  Gas used: ${chainResult.gasUsed}`);

      // Step 3: Update backend with bounty ID
      console.log(`  Syncing bounty ID to backend...`);
      await updateJobBountyId(
        job.jobId,
        chainResult.bountyId,
        chainResult.txHash,
        chainResult.blockNumber
      );

      results.push({
        index: i + 1,
        status: 'success',
        title: bountyData.title,
        jobId: job.jobId,
        bountyId: chainResult.bountyId,
        txHash: chainResult.txHash,
      });

      console.log(`  SUCCESS\n`);

      // Small delay between bounties to avoid rate limiting
      if (i < options.count - 1) {
        await sleep(2000);
      }

    } catch (error) {
      let errorMsg = error.message;
      if (error.data && contract) {
        try {
          const parsed = contract.interface.parseError(error.data);
          if (parsed) {
            const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
            errorMsg = parsed.name + args;
          }
        } catch {}
      }
      if (!errorMsg && error.reason) errorMsg = error.reason;
      console.error(`  FAILED: ${errorMsg}\n`);
      results.push({
        index: i + 1,
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const dryRun = results.filter(r => r.status === 'dry-run').length;

  if (dryRun > 0) {
    console.log(`Dry run completed: ${dryRun} bounties would be created`);
  } else {
    console.log(`Successful: ${successful}`);
    console.log(`Failed:     ${failed}`);
  }

  if (successful > 0) {
    console.log('\nCreated Bounties:');
    results
      .filter(r => r.status === 'success')
      .forEach(r => {
        console.log(`  - Job #${r.jobId} / Bounty #${r.bountyId}: ${r.title}`);
      });
  }

  if (failed > 0) {
    console.log('\nFailed Bounties:');
    results
      .filter(r => r.status === 'failed')
      .forEach(r => {
        console.log(`  - #${r.index}: ${r.error}`);
      });
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
