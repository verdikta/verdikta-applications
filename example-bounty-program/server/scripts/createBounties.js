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
 *   node scripts/createBounties.js --count 1 --template research --class 128 --amount 0.001 --threshold 90 --hours 1
 *   node scripts/createBounties.js --count 3 --amount 0.001 --hours 2
 *   node scripts/createBounties.js --count 2 --template writing
 *   node scripts/createBounties.js --count 1 --threshold 50 --hours 1
 *   node scripts/createBounties.js --count 1 --dry-run
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

// =============================================================================
// CONFIGURATION
// =============================================================================

// Build API URL from HOST/PORT if API_URL not set (0.0.0.0 means use localhost for requests)
const buildApiUrl = () => {
  if (process.env.API_URL) return process.env.API_URL;
  const host = process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost');
  const port = process.env.PORT || '5005';
  return `http://${host}:${port}`;
};

const CONFIG = {
  apiUrl: buildApiUrl(),
  rpcUrl: process.env.RPC_URL || 'https://sepolia.base.org',
  contractAddress: process.env.BOUNTY_ESCROW_ADDRESS,
  privateKey: process.env.PRIVATE_KEY,
  chainId: parseInt(process.env.CHAIN_ID || '84532'),
};

const BOUNTY_ESCROW_ABI = [
  'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)',
  'function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)',
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

// Default jury configuration
const DEFAULT_JURY = [
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', runs: 1, weight: 1.0 },
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
    classId: 131,
    threshold: null,  // null means use template default
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
        options.classId = parseInt(args[++i]) || 131;
        break;
      case '--threshold':
        options.threshold = parseInt(args[++i]);
        if (isNaN(options.threshold) || options.threshold < 0 || options.threshold > 100) {
          console.error('Error: --threshold must be a number between 0 and 100');
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
  --class, -c <id>         Verdikta class ID (default: 131)
  --threshold <percent>    Passing threshold 0-100 (default: from template)
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

async function createJobBackend(bountyData, creatorAddress, amount, hours) {
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
  };

  const response = await fetch(`${CONFIG.apiUrl}/api/jobs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Backend API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function updateJobBountyId(jobId, bountyId, txHash, blockNumber) {
  const response = await fetch(`${CONFIG.apiUrl}/api/jobs/${jobId}/bountyId`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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

async function createBountyOnChain(contract, primaryCid, classId, threshold, hours, amountEth) {
  const deadline = Math.floor(Date.now() / 1000) + (hours * 3600);
  const value = ethers.parseEther(amountEth.toString());

  console.log(`    Sending transaction...`);
  const tx = await contract.createBounty(primaryCid, classId, threshold, deadline, { value });

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
      console.error('Error: BOUNTY_ESCROW_ADDRESS environment variable is required');
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
  console.log(`Window:    ${options.hours} hours`);
  console.log(`Template:  ${options.template}`);
  console.log(`Class ID:  ${options.classId}`);
  console.log(`Threshold: ${effectiveThreshold}%${options.threshold !== null ? ' (override)' : ' (from template)'}`);
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
        options.hours
      );

      if (!jobResult.success) {
        throw new Error(jobResult.error || 'Backend job creation failed');
      }

      const job = jobResult.job;
      console.log(`  Job created: ID=${job.jobId}, CID=${job.primaryCid?.substring(0, 20)}...`);

      // Step 2: Create bounty on-chain
      console.log(`  Creating on-chain bounty...`);
      const chainResult = await createBountyOnChain(
        contract,
        job.primaryCid,
        bountyData.classId,
        bountyData.threshold,
        options.hours,
        options.amount
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
      console.error(`  FAILED: ${error.message}\n`);
      results.push({
        index: i + 1,
        status: 'failed',
        error: error.message,
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
