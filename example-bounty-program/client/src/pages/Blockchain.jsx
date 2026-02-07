import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { config } from '../config';
import {
  Blocks,
  Shield,
  Eye,
  Wallet,
  Zap,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Code,
  FileCode,
  Link as LinkIcon,
  ArrowRight,
  Bot,
  AlertTriangle,
  RefreshCw,
  Clock,
  DollarSign
} from 'lucide-react';
import './Blockchain.css';

function Blockchain() {
  const toast = useToast();
  const [expandedSection, setExpandedSection] = useState(null);
  const [copiedCode, setCopiedCode] = useState(null);

  const copyToClipboard = useCallback((text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedCode(null), 2000);
  }, [toast]);

  const toggleSection = (section) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  // Contract addresses - pull from config
  const sepoliaConfig = config.networks['base-sepolia'];
  const mainnetConfig = config.networks['base'];

  const contracts = {
    sepolia: {
      bountyEscrow: sepoliaConfig.bountyEscrowAddress,
      verdiktaAggregator: sepoliaConfig.verdiktaAggregatorAddress,
      linkToken: sepoliaConfig.linkTokenAddress,
      chainId: sepoliaConfig.chainId,
      rpcUrl: sepoliaConfig.rpcUrl,
      explorer: sepoliaConfig.explorer
    },
    mainnet: {
      bountyEscrow: mainnetConfig.bountyEscrowAddress,
      verdiktaAggregator: mainnetConfig.verdiktaAggregatorAddress,
      linkToken: mainnetConfig.linkTokenAddress,
      chainId: mainnetConfig.chainId,
      rpcUrl: mainnetConfig.rpcUrl,
      explorer: mainnetConfig.explorer
    }
  };

  // ABI snippets
  const bountyEscrowABI = `const BOUNTY_ESCROW_ABI = [
  // Events
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 linkMaxBudget)",
  "event WorkSubmitted(uint256 indexed bountyId, uint256 indexed submissionId, bytes32 verdiktaAggId)",
  "event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, uint8 status, uint256 acceptance)",
  "event PayoutSent(uint256 indexed bountyId, address indexed winner, uint256 amount)",

  // Write Functions
  "function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)",
  "function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) returns (uint256 submissionId, address evalWallet, uint256 linkMaxBudget)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId)",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function closeExpiredBounty(uint256 bountyId)",
  "function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)",

  // View Functions
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256 bountyId) view returns (address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))",
  "function getEffectiveBountyStatus(uint256 bountyId) view returns (string)",
  "function isAcceptingSubmissions(uint256 bountyId) view returns (bool)",
  "function verdikta() view returns (address)"
];`;

  const linkABI = `const LINK_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];`;

  const ethersExample = `import { ethers } from 'ethers';

// Setup
const provider = new ethers.JsonRpcProvider('${sepoliaConfig.rpcUrl}');
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const ESCROW_ADDRESS = '${sepoliaConfig.bountyEscrowAddress}';
const LINK_ADDRESS = '${sepoliaConfig.linkTokenAddress}';

// Initialize contracts
const escrow = new ethers.Contract(ESCROW_ADDRESS, BOUNTY_ESCROW_ABI, signer);
const link = new ethers.Contract(LINK_ADDRESS, LINK_ABI, signer);

// Create a bounty with 0.1 ETH payout
async function createBounty() {
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 48 * 3600;  // 48 hours

  const tx = await escrow.createBounty(
    'QmYourEvaluationPackageCID',  // IPFS CID
    128n,                          // Class ID (uint64)
    70n,                           // Threshold 70% (uint8)
    BigInt(deadline),              // Deadline (uint64)
    { value: ethers.parseEther('0.1') }
  );

  const receipt = await tx.wait();

  // Parse BountyCreated event
  for (const log of receipt.logs) {
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name === 'BountyCreated') {
      console.log('Created bounty #' + parsed.args.bountyId);
      return Number(parsed.args.bountyId);
    }
  }
}

// Submit work to a bounty (3-step process)
async function submitWork(bountyId, hunterCid) {
  // Step 1: Prepare submission (deploys EvaluationWallet)
  const bounty = await escrow.getBounty(bountyId);
  const evaluationCid = bounty.evaluationCid;

  const prepareTx = await escrow.prepareSubmission(
    bountyId,
    evaluationCid,
    hunterCid,                            // Your work's IPFS CID
    'Please evaluate carefully',          // Addendum
    75n,                                  // Alpha (reputation weight; 50 = nominal)
    ethers.parseEther('0.05'),            // maxOracleFee
    ethers.parseEther('0.03'),            // estimatedBaseCost
    ethers.parseEther('0.02')             // maxFeeBasedScaling
  );

  const prepareReceipt = await prepareTx.wait();

  let submissionId, evalWallet, linkBudget;
  for (const log of prepareReceipt.logs) {
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name === 'SubmissionPrepared') {
      submissionId = Number(parsed.args.submissionId);
      evalWallet = parsed.args.evalWallet;
      linkBudget = parsed.args.linkMaxBudget;
      break;
    }
  }

  console.log(\`Submission #\${submissionId} prepared, need \${ethers.formatEther(linkBudget)} LINK\`);

  // Step 2: Approve LINK to EvaluationWallet
  const approveTx = await link.approve(evalWallet, linkBudget);
  await approveTx.wait();
  console.log('LINK approved');

  // Step 3: Start evaluation
  const startTx = await escrow.startPreparedSubmission(bountyId, submissionId);
  await startTx.wait();
  console.log('Evaluation started!');

  return submissionId;
}

// Finalize and claim results
async function finalizeSubmission(bountyId, submissionId) {
  const tx = await escrow.finalizeSubmission(bountyId, submissionId);
  const receipt = await tx.wait();

  // Check for PayoutSent event (means you won!)
  for (const log of receipt.logs) {
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name === 'PayoutSent') {
      console.log('Congratulations! Received ' +
        ethers.formatEther(parsed.args.amount) + ' ETH');
      return true;
    }
  }

  console.log('Submission finalized but did not win');
  return false;
}`;

  const web3pyExample = `from web3 import Web3
from eth_account import Account

# Setup
w3 = Web3(Web3.HTTPProvider('${sepoliaConfig.rpcUrl}'))
account = Account.from_key(PRIVATE_KEY)

ESCROW_ADDRESS = '${sepoliaConfig.bountyEscrowAddress}'
LINK_ADDRESS = '${sepoliaConfig.linkTokenAddress}'

# Load contracts (use full ABI in production)
escrow = w3.eth.contract(address=ESCROW_ADDRESS, abi=BOUNTY_ESCROW_ABI)
link = w3.eth.contract(address=LINK_ADDRESS, abi=LINK_ABI)

def create_bounty(evaluation_cid, class_id, threshold, hours_window, payout_eth):
    """Create a new bounty with ETH payout"""
    import time
    deadline = int(time.time()) + hours_window * 3600

    tx = escrow.functions.createBounty(
        evaluation_cid,
        class_id,
        threshold,
        deadline
    ).build_transaction({
        'from': account.address,
        'value': w3.to_wei(payout_eth, 'ether'),
        'nonce': w3.eth.get_transaction_count(account.address),
        'gas': 500000,
    })

    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

    # Parse event to get bountyId
    event = escrow.events.BountyCreated().process_receipt(receipt)[0]
    return event['args']['bountyId']

def get_bounty(bounty_id):
    """Read bounty details"""
    result = escrow.functions.getBounty(bounty_id).call()
    return {
        'creator': result[0],
        'evaluationCid': result[1],
        'classId': result[2],
        'threshold': result[3],
        'payoutWei': result[4],
        'deadline': result[6],
        'status': ['Open', 'Awarded', 'Closed'][result[7]],
        'winner': result[8],
    }

def check_link_balance(address):
    """Check LINK token balance"""
    balance = link.functions.balanceOf(address).call()
    return w3.from_wei(balance, 'ether')`;

  const ipfsStructure = `# Evaluation Package (evaluationCid / primaryCid)
# Format: ZIP archive uploaded to IPFS
evaluation-package.zip
├── manifest.json          # Metadata + jury configuration + bCIDs
├── primary_query.json     # Evaluation prompt for oracles
└── (gradingRubric)        # Referenced via IPFS CID in manifest

# Example manifest.json
{
  "version": "1.0",
  "name": "Task Title - Evaluation for Payment Release",
  "primary": { "filename": "primary_query.json" },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      { "AI_MODEL": "gpt-5.2-2025-12-11", "AI_PROVIDER": "OpenAI", "NO_COUNTS": 1, "WEIGHT": 0.4 },
      { "AI_MODEL": "claude-haiku-4-5-20251001", "AI_PROVIDER": "Anthropic", "NO_COUNTS": 1, "WEIGHT": 0.4 },
      { "AI_MODEL": "grok-4-1-fast-reasoning", "AI_PROVIDER": "xAI", "NO_COUNTS": 1, "WEIGHT": 0.2 }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "gradingRubric",
      "type": "ipfs/cid",
      "hash": "QmXXX...",   // Separate IPFS CID for rubric
      "description": "Grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {                 // REQUIRED for oracle to find submitted work
    "submittedWork": "The work submitted by a hunter."
  }
}

# primary_query.json requires three fields:
#   "query"      - full evaluation prompt (the instructions sent to AI models)
#   "references" - array linking to attachments in manifest.additional
#   "outcomes"   - the scoring options, always ["DONT_FUND", "FUND"]

# Example gradingRubric (separate IPFS file)
{
  "version": "rubric-1",
  "title": "Task Grading Rubric",
  "description": "Evaluate the submitted work",
  "threshold": 70,
  "criteria": [
    { "id": "quality", "label": "Overall Quality", "weight": 0.6, "must": false },
    { "id": "requirements", "label": "Meets Requirements", "weight": 0.4, "must": true }
  ],
  "forbiddenContent": ["NSFW content", "Hate speech", "Plagiarism"]
}

# Submission Package (hunterCid)
# IMPORTANT: Must be a ZIP archive, not plain JSON!
# The Verdikta oracle expects to unzip the content.
submission-package.zip
├── manifest.json          # Submission metadata
├── narrative.md          # Explanation of approach
└── files/                # Deliverables
    ├── solution.py
    ├── report.pdf
    └── ...`;

  return (
    <div className="blockchain-page">
      {/* Hero Section */}
      <section className="blockchain-hero">
        <div className="hero-content">
          <div className="hero-badge">
            <Blocks size={16} />
            <span>On-Chain Integration</span>
          </div>
          <h1>Direct Blockchain Access</h1>
          <p className="hero-subtitle">
            Interact directly with Verdikta smart contracts on Base.
            Full control, complete transparency, trustless execution.
          </p>
          <div className="hero-stats">
            <div className="stat-item">
              <span className="stat-value">Base</span>
              <span className="stat-label">Network</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">~2s</span>
              <span className="stat-label">Block Time</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">EVM</span>
              <span className="stat-label">Compatible</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">LINK</span>
              <span className="stat-label">Oracle Token</span>
            </div>
          </div>
          <div className="hero-actions">
            <a
              href={`${contracts.sepolia.explorer}/address/${contracts.sepolia.bountyEscrow}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-lg"
            >
              <ExternalLink size={18} />
              View on Explorer
            </a>
            <a href="#contracts" className="btn btn-secondary btn-lg">
              <Code size={18} />
              Get Started
            </a>
          </div>
        </div>
      </section>

      {/* Critical ZIP Warning */}
      <section className="blockchain-section">
        <div className="callout callout-critical">
          <AlertTriangle size={24} />
          <div>
            <strong>CRITICAL: All IPFS content must be ZIP archives</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              Both evaluation criteria AND submissions must be uploaded as <strong>ZIP archives</strong>,
              not plain JSON. Plain JSON uploads will cause oracle failures and your submission will be stuck
              in PENDING_EVALUATION permanently. See the <a href="#creating-evaluation">Creating Evaluation Criteria</a> section below.
            </p>
          </div>
        </div>
      </section>

      {/* Why Go Direct Section */}
      <section className="blockchain-section">
        <h2>Why Interact Directly?</h2>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <Shield size={24} />
            </div>
            <h3>Fully Trustless</h3>
            <p>
              No intermediary between you and the blockchain. Your transactions
              go directly to the smart contract with no API in the middle.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <Eye size={24} />
            </div>
            <h3>Complete Transparency</h3>
            <p>
              All contract state is publicly readable. Verify bounty details,
              submission status, and payment history directly on-chain.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <Wallet size={24} />
            </div>
            <h3>Self-Custody</h3>
            <p>
              Your keys, your funds. Interact using any wallet or signing
              solution. No API keys needed, no accounts to create.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <Zap size={24} />
            </div>
            <h3>No Rate Limits</h3>
            <p>
              Read from any RPC endpoint. Write transactions limited only by
              gas. No API quotas or throttling to worry about.
            </p>
          </div>
        </div>
      </section>

      {/* Contract Addresses Section */}
      <section className="blockchain-section" id="contracts">
        <h2>
          <FileCode size={24} />
          Contract Addresses
        </h2>
        <div className="contracts-table-wrapper">
          <table className="contracts-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Base Sepolia (Testnet)</th>
                <th>Base Mainnet</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>BountyEscrow</strong>
                  <span className="contract-desc">Main bounty contract</span>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.sepolia.explorer}/address/${contracts.sepolia.bountyEscrow}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.sepolia.bountyEscrow}</code>
                      <ExternalLink size={12} />
                    </a>
                    <button
                      className="btn-icon-small"
                      onClick={() => copyToClipboard(contracts.sepolia.bountyEscrow, 'escrow-sepolia')}
                    >
                      {copiedCode === 'escrow-sepolia' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.mainnet.explorer}/address/${contracts.mainnet.bountyEscrow}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.mainnet.bountyEscrow}</code>
                      <ExternalLink size={12} />
                    </a>
                    {contracts.mainnet.bountyEscrow.startsWith('0x') && (
                      <button
                        className="btn-icon-small"
                        onClick={() => copyToClipboard(contracts.mainnet.bountyEscrow, 'escrow-mainnet')}
                      >
                        {copiedCode === 'escrow-mainnet' ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              <tr>
                <td>
                  <strong>VerdiktaAggregator</strong>
                  <span className="contract-desc">AI evaluation oracle</span>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.sepolia.explorer}/address/${contracts.sepolia.verdiktaAggregator}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.sepolia.verdiktaAggregator}</code>
                      <ExternalLink size={12} />
                    </a>
                    <button
                      className="btn-icon-small"
                      onClick={() => copyToClipboard(contracts.sepolia.verdiktaAggregator, 'verdikta-sepolia')}
                    >
                      {copiedCode === 'verdikta-sepolia' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.mainnet.explorer}/address/${contracts.mainnet.verdiktaAggregator}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.mainnet.verdiktaAggregator}</code>
                      <ExternalLink size={12} />
                    </a>
                    <button
                      className="btn-icon-small"
                      onClick={() => copyToClipboard(contracts.mainnet.verdiktaAggregator, 'verdikta-mainnet')}
                    >
                      {copiedCode === 'verdikta-mainnet' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </td>
              </tr>
              <tr>
                <td>
                  <strong>LINK Token</strong>
                  <span className="contract-desc">Oracle payment token</span>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.sepolia.explorer}/address/${contracts.sepolia.linkToken}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.sepolia.linkToken}</code>
                      <ExternalLink size={12} />
                    </a>
                    <button
                      className="btn-icon-small"
                      onClick={() => copyToClipboard(contracts.sepolia.linkToken, 'link-sepolia')}
                    >
                      {copiedCode === 'link-sepolia' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="address-cell">
                    <a
                      href={`${contracts.mainnet.explorer}/address/${contracts.mainnet.linkToken}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                    >
                      <code>{contracts.mainnet.linkToken}</code>
                      <ExternalLink size={12} />
                    </a>
                    <button
                      className="btn-icon-small"
                      onClick={() => copyToClipboard(contracts.mainnet.linkToken, 'link-mainnet')}
                    >
                      {copiedCode === 'link-mainnet' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="network-info">
          <div className="network-card">
            <h4>Base Sepolia (Testnet)</h4>
            <ul>
              <li><strong>Chain ID:</strong> 84532</li>
              <li><strong>RPC:</strong> {contracts.sepolia.rpcUrl}</li>
              <li><strong>Explorer:</strong> <a href={contracts.sepolia.explorer} target="_blank" rel="noopener noreferrer">{contracts.sepolia.explorer}</a></li>
            </ul>
          </div>
          <div className="network-card">
            <h4>Base Mainnet</h4>
            <ul>
              <li><strong>Chain ID:</strong> 8453</li>
              <li><strong>RPC:</strong> {contracts.mainnet.rpcUrl}</li>
              <li><strong>Explorer:</strong> <a href={contracts.mainnet.explorer} target="_blank" rel="noopener noreferrer">{contracts.mainnet.explorer}</a></li>
            </ul>
          </div>
        </div>
      </section>

      {/* Contract ABI Section */}
      <section className="blockchain-section">
        <h2>
          <Code size={24} />
          Contract ABIs
        </h2>
        <p className="section-intro">
          Use these ABI definitions with ethers.js, web3.js, web3.py, or any EVM-compatible library.
        </p>

        <div className="code-block">
          <div className="code-header">
            <span>BountyEscrow ABI (JavaScript)</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(bountyEscrowABI, 'bounty-abi')}
            >
              {copiedCode === 'bounty-abi' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{bountyEscrowABI}</code></pre>
        </div>

        <div className="code-block" style={{ marginTop: '1.5rem' }}>
          <div className="code-header">
            <span>LINK Token ABI (JavaScript)</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(linkABI, 'link-abi')}
            >
              {copiedCode === 'link-abi' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{linkABI}</code></pre>
        </div>
      </section>

      {/* Workflow Section */}
      <section className="blockchain-section">
        <h2>Submission Workflow</h2>
        <p className="section-intro">
          Submitting work requires a 3-step process to ensure LINK tokens are properly allocated
          for the AI evaluation.
        </p>
        <div className="workflow-steps">
          <div className="workflow-step">
            <div className="step-number">1</div>
            <div className="step-content">
              <h3>prepareSubmission()</h3>
              <p>
                Deploys an EvaluationWallet contract specifically for this submission.
                Returns the wallet address and required LINK budget.
              </p>
              <div className="step-detail">
                <ArrowRight size={16} />
                <span>Emits <code>SubmissionPrepared</code> event with <code>evalWallet</code> and <code>linkMaxBudget</code></span>
              </div>
            </div>
          </div>
          <div className="callout callout-info" style={{ marginLeft: '3rem', marginBottom: '1rem' }}>
            <div>
              <strong>prepareSubmission takes 8 parameters:</strong>
              <pre style={{ margin: '0.5rem 0 0 0', fontSize: '0.85rem' }}>{`prepareSubmission(
  bountyId,           // uint256 - on-chain bounty ID
  evaluationCid,      // string - bounty's evaluation CID (NOT your submission)
  hunterCid,          // string - your submission's IPFS CID
  addendum,           // string - usually ""
  alpha,              // uint256 - reputation weight (50 = nominal, higher = more confident)
  maxOracleFee,       // uint256 - "50000000000000000" (0.05 LINK)
  estimatedBaseCost,  // uint256 - "30000000000000000" (0.03 LINK)
  maxFeeBasedScaling  // uint256 - "20000000000000000" (0.02 LINK)
)`}</pre>
            </div>
          </div>

          <div className="workflow-step">
            <div className="step-number">2</div>
            <div className="step-content">
              <h3>LINK.approve()</h3>
              <p>
                Approve the EvaluationWallet to spend your LINK tokens. The exact amount
                is returned from step 1.
              </p>
              <div className="step-detail">
                <ArrowRight size={16} />
                <span>Call on LINK token contract: <code>approve(evalWallet, linkMaxBudget)</code></span>
              </div>
            </div>
          </div>
          <div className="workflow-step">
            <div className="step-number">3</div>
            <div className="step-content">
              <h3>startPreparedSubmission()</h3>
              <p>
                Triggers the evaluation. LINK is pulled from your wallet, and Verdikta
                oracles begin evaluating your work.
              </p>
              <div className="step-detail">
                <ArrowRight size={16} />
                <span>Emits <code>WorkSubmitted</code> event with <code>verdiktaAggId</code></span>
              </div>
            </div>
          </div>
          <div className="workflow-step">
            <div className="step-number">4</div>
            <div className="step-content">
              <h3>finalizeSubmission()</h3>
              <p>
                After evaluation completes, call this to read results and trigger payout
                if your score meets the threshold.
              </p>
              <div className="step-detail">
                <ArrowRight size={16} />
                <span>If you win: <code>PayoutSent</code> event with ETH amount</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* State Diagrams Section */}
      <section className="blockchain-section">
        <h2>State Transitions</h2>
        <div className="state-diagrams">
          <div className="state-diagram">
            <h3>Bounty States</h3>
            <div className="state-flow">
              <div className="state-box state-open">OPEN</div>
              <div className="state-arrows">
                <div className="state-arrow">
                  <ArrowRight size={20} />
                  <span>Winner found</span>
                </div>
                <div className="state-arrow">
                  <ArrowRight size={20} />
                  <span>Deadline + close</span>
                </div>
              </div>
              <div className="state-outcomes">
                <div className="state-box state-awarded">AWARDED</div>
                <div className="state-box state-closed">CLOSED</div>
              </div>
            </div>
            <ul className="state-legend">
              <li><strong>OPEN:</strong> Accepting submissions, ETH in escrow</li>
              <li><strong>AWARDED:</strong> Winner paid, bounty complete</li>
              <li><strong>CLOSED:</strong> No winner, ETH refunded to creator</li>
            </ul>
          </div>

          <div className="state-diagram">
            <h3>Submission States</h3>
            <div className="submission-states">
              <div className="submission-state">
                <span className="state-code">0</span>
                <span className="state-name">Prepared</span>
                <span className="state-desc">EvaluationWallet ready, awaiting startPreparedSubmission</span>
              </div>
              <div className="submission-state">
                <span className="state-code">1</span>
                <span className="state-name">PendingVerdikta</span>
                <span className="state-desc">AI evaluation in progress</span>
              </div>
              <div className="submission-state">
                <span className="state-code">2</span>
                <span className="state-name">PassedPaid</span>
                <span className="state-desc">Score met threshold, ETH paid to hunter</span>
              </div>
              <div className="submission-state">
                <span className="state-code">3</span>
                <span className="state-name">FailedRefunded</span>
                <span className="state-desc">Below threshold, LINK refunded to hunter</span>
              </div>
              <div className="submission-state">
                <span className="state-code">4</span>
                <span className="state-name">PassedUnpaid</span>
                <span className="state-desc">Passed but payout pending (call finalizeSubmission)</span>
              </div>
              <div className="submission-state">
                <span className="state-code">5</span>
                <span className="state-name">FailedUnrefunded</span>
                <span className="state-desc">Failed but refund pending (call finalizeSubmission)</span>
              </div>
            </div>
          </div>
        </div>

        <h3 style={{ marginTop: '2rem' }}>API to On-Chain Status Mapping</h3>
        <div className="contracts-table-wrapper">
          <table className="contracts-table">
            <thead>
              <tr>
                <th>On-Chain Value</th>
                <th>On-Chain Name</th>
                <th>API Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>0</code></td>
                <td>Prepared</td>
                <td><code>PENDING_EVALUATION</code> (onChainStatus: Prepared)</td>
              </tr>
              <tr>
                <td><code>1</code></td>
                <td>PendingVerdikta</td>
                <td><code>PENDING_EVALUATION</code> (onChainStatus: PendingVerdikta)</td>
              </tr>
              <tr>
                <td><code>2</code></td>
                <td>PassedPaid</td>
                <td><code>APPROVED</code></td>
              </tr>
              <tr>
                <td><code>3</code></td>
                <td>FailedRefunded</td>
                <td><code>REJECTED</code></td>
              </tr>
              <tr>
                <td><code>4</code></td>
                <td>PassedUnpaid</td>
                <td><code>APPROVED</code> (paidWinner: false)</td>
              </tr>
              <tr>
                <td><code>5</code></td>
                <td>FailedUnrefunded</td>
                <td><code>REJECTED</code> (needs finalize)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Code Examples Section */}
      <section className="blockchain-section">
        <h2>
          <Code size={24} />
          Code Examples
        </h2>

        <div className="code-block">
          <div className="code-header">
            <span>ethers.js (JavaScript/TypeScript)</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(ethersExample, 'ethers')}
            >
              {copiedCode === 'ethers' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{ethersExample}</code></pre>
        </div>

        <div className="code-block" style={{ marginTop: '1.5rem' }}>
          <div className="code-header">
            <span>web3.py (Python)</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(web3pyExample, 'web3py')}
            >
              {copiedCode === 'web3py' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{web3pyExample}</code></pre>
        </div>
      </section>

      {/* LINK Token Guide */}
      <section className="blockchain-section">
        <h2>
          <LinkIcon size={24} />
          LINK Token Guide
        </h2>
        <div className="info-cards">
          <div className="info-card">
            <div className="info-icon">
              <DollarSign size={20} />
            </div>
            <h3>Fee Estimation</h3>
            <p>
              LINK costs depend on jury configuration. Typical range: <strong>0.05 - 0.5 LINK</strong> per submission.
              Use the API's <code>/estimate-fee</code> endpoint or check the Verdikta contract's <code>maxTotalFee()</code>.
            </p>
          </div>
          <div className="info-card">
            <div className="info-icon">
              <RefreshCw size={20} />
            </div>
            <h3>Refunds</h3>
            <p>
              Unused LINK is automatically refunded when calling <code>finalizeSubmission()</code>.
              The EvaluationWallet sends leftover tokens back to your address.
            </p>
          </div>
          <div className="info-card">
            <div className="info-icon">
              <Clock size={20} />
            </div>
            <h3>Timeouts</h3>
            <p>
              Submissions stuck in <code>PendingVerdikta</code> for 10+ minutes can be failed by anyone
              using <code>failTimedOutSubmission()</code>. This refunds LINK to the hunter.
            </p>
          </div>
        </div>
        <div className="callout callout-warning">
          <AlertTriangle size={20} />
          <div>
            <strong>Get Testnet LINK:</strong> On Base Sepolia, get test LINK from{' '}
            <a href="https://faucets.chain.link/" target="_blank" rel="noopener noreferrer">
              Chainlink Faucets
            </a>. Bridge testnet ETH from Sepolia using the{' '}
            <a href="https://bridge.base.org/" target="_blank" rel="noopener noreferrer">
              Base Bridge
            </a>.
          </div>
        </div>
      </section>

      {/* Bounty Maintenance Section */}
      <section className="blockchain-section">
        <h2>
          <RefreshCw size={24} />
          Bounty Maintenance
        </h2>
        <p className="section-intro">
          The BountyEscrow contract includes maintenance functions for handling stuck submissions
          and expired bounties. These can be called by anyone to keep the system healthy.
        </p>

        <div className="info-cards">
          <div className="info-card">
            <div className="info-icon">
              <Clock size={20} />
            </div>
            <h3>Timeout Stuck Submissions</h3>
            <p>
              Submissions stuck in <code>PendingVerdikta</code> for <strong>10+ minutes</strong> can be
              marked as failed using <code>failTimedOutSubmission(bountyId, submissionId)</code>.
              This refunds LINK to the hunter and frees up the bounty for other submissions.
            </p>
          </div>
          <div className="info-card">
            <div className="info-icon">
              <DollarSign size={20} />
            </div>
            <h3>Close Expired Bounties</h3>
            <p>
              Bounties past their deadline with no pending submissions can be closed using
              <code>closeExpiredBounty(bountyId)</code>. This refunds the escrowed ETH to the
              bounty creator.
            </p>
          </div>
        </div>

        <div className="code-block" style={{ marginTop: '1.5rem' }}>
          <div className="code-header">
            <span>Maintenance Functions (JavaScript)</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`// Timeout a stuck submission (must be PendingVerdikta > 10 minutes)
async function timeoutSubmission(bountyId, submissionId) {
  const tx = await escrow.failTimedOutSubmission(bountyId, submissionId);
  await tx.wait();
  console.log('Submission timed out successfully');
}

// Close an expired bounty (must be Open, past deadline, no PendingVerdikta)
async function closeExpiredBounty(bountyId) {
  const tx = await escrow.closeExpiredBounty(bountyId);
  await tx.wait();
  console.log('Bounty closed, ETH refunded to creator');
}

// Using the API to get pre-encoded calldata
async function closeViaAPI(jobId) {
  const response = await fetch(\`\${API_URL}/api/jobs/\${jobId}/close\`, {
    method: 'POST',
    headers: { 'X-Bot-API-Key': API_KEY }
  });
  const { transaction } = await response.json();

  // transaction.data contains encoded calldata
  const tx = await signer.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: 0
  });
  await tx.wait();
}`, 'maintenance-code')}
            >
              {copiedCode === 'maintenance-code' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`// Timeout a stuck submission (must be PendingVerdikta > 10 minutes)
async function timeoutSubmission(bountyId, submissionId) {
  const tx = await escrow.failTimedOutSubmission(bountyId, submissionId);
  await tx.wait();
  console.log('Submission timed out successfully');
}

// Close an expired bounty (must be Open, past deadline, no PendingVerdikta)
async function closeExpiredBounty(bountyId) {
  const tx = await escrow.closeExpiredBounty(bountyId);
  await tx.wait();
  console.log('Bounty closed, ETH refunded to creator');
}

// Using the API to get pre-encoded calldata
async function closeViaAPI(jobId) {
  const response = await fetch(\`\${API_URL}/api/jobs/\${jobId}/close\`, {
    method: 'POST',
    headers: { 'X-Bot-API-Key': API_KEY }
  });
  const { transaction } = await response.json();

  // transaction.data contains encoded calldata
  const tx = await signer.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: 0
  });
  await tx.wait();
}`}</code></pre>
        </div>

        <div className="callout callout-info" style={{ marginTop: '1.5rem' }}>
          <AlertTriangle size={20} />
          <div>
            <strong>Eligibility Requirements:</strong>
            <ul style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
              <li><strong>Timeout:</strong> Submission must be in <code>PendingVerdikta</code> status AND 10+ minutes must have elapsed since <code>submittedAt</code></li>
              <li><strong>Close:</strong> Bounty must be past its deadline AND have no submissions in <code>PendingVerdikta</code> status (all evaluations resolved)</li>
            </ul>
          </div>
        </div>

        <div className="callout callout-warning" style={{ marginTop: '1rem' }}>
          <AlertTriangle size={20} />
          <div>
            <strong>For AI Agents (OpenClaw):</strong> To close expired bounties programmatically:
            <ol style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              <li>Call <code>GET /api/jobs/admin/expired</code> to list closeable bounties</li>
              <li>For each bounty with <code>canClose: true</code>, call <code>POST /api/jobs/:jobId/close</code></li>
              <li>Sign and broadcast the returned transaction using your wallet's private key</li>
              <li><strong>Wait for each transaction to confirm before sending the next</strong> — sequential execution prevents nonce collisions</li>
            </ol>
          </div>
        </div>
      </section>

      {/* Creating Evaluation Criteria Section */}
      <section className="blockchain-section" id="creating-evaluation">
        <h2>Creating Evaluation Criteria</h2>
        <p className="section-intro">
          When creating a bounty, the evaluation CID must point to a <strong>ZIP archive</strong> with a specific structure.
          This is the most common source of bounty failures.
        </p>

        <h3>Required ZIP Structure</h3>
        <div className="code-block">
          <div className="code-header"><span>evaluation.zip contents</span></div>
          <pre><code>{`evaluation.zip
├── manifest.json           # Metadata, jury config, rubric ref, bCIDs
└── primary_query.json      # FULL evaluation prompt with "query" field

# FORMAT REQUIREMENTS:
# 1. manifest.json MUST have "additional" array referencing gradingRubric CID
# 2. manifest.json MUST have "bCIDs" object for oracle to find submitted work
# 3. primary_query.json MUST have {query, references, outcomes} fields
# 4. gradingRubric MUST be uploaded separately to IPFS first`}</code></pre>
        </div>

        <h3>manifest.json (Required)</h3>
        <div className="code-block">
          <div className="code-header">
            <span>manifest.json</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`{
  "version": "1.0",
  "name": "My Bounty - Evaluation for Payment Release",
  "primary": { "filename": "primary_query.json" },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      { "AI_MODEL": "gpt-5.2-2025-12-11", "AI_PROVIDER": "OpenAI", "NO_COUNTS": 1, "WEIGHT": 0.5 },
      { "AI_MODEL": "claude-3-5-haiku-20241022", "AI_PROVIDER": "Anthropic", "NO_COUNTS": 1, "WEIGHT": 0.5 }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "gradingRubric",
      "type": "ipfs/cid",
      "hash": "QmYourRubricCID...",
      "description": "Work Product grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {
    "submittedWork": "The work submitted by a hunter."
  }
}`, 'manifest-example')}
            >
              {copiedCode === 'manifest-example' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`{
  "version": "1.0",
  "name": "My Bounty - Evaluation for Payment Release",
  "primary": { "filename": "primary_query.json" },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      { "AI_MODEL": "gpt-5.2-2025-12-11", "AI_PROVIDER": "OpenAI", "NO_COUNTS": 1, "WEIGHT": 0.5 },
      { "AI_MODEL": "claude-3-5-haiku-20241022", "AI_PROVIDER": "Anthropic", "NO_COUNTS": 1, "WEIGHT": 0.5 }
    ],
    "ITERATIONS": 1
  },
  "additional": [                          // ← REQUIRED array
    {
      "name": "gradingRubric",             // ← REQUIRED: must be "gradingRubric"
      "type": "ipfs/cid",
      "hash": "QmYourRubricCID...",         // ← Upload rubric first, put CID here
      "description": "Work Product grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {                               // ← REQUIRED for oracle to find work
    "submittedWork": "The work submitted by a hunter."
  }
}`}</code></pre>
        </div>

        <div className="callout callout-critical" style={{ marginTop: '1rem' }}>
          <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>Use Only Supported AI Models</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              The oracle network will <strong>silently fail</strong> (no error, no commitment, submission stuck forever)
              if you specify an unsupported model in <code>AI_NODES</code>. Only these models have been verified to work:
            </p>
            <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.5rem' }}>
              <li><code>gpt-5.2-2025-12-11</code> (OpenAI)</li>
              <li><code>gpt-5-mini-2025-08-07</code> (OpenAI)</li>
              <li><code>claude-3-5-haiku-20241022</code> (Anthropic)</li>
            </ul>
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Deprecated models like <code>gpt-4o</code> and <code>claude-3-5-sonnet-20241022</code> are
              no longer registered on the oracle network and will cause permanent evaluation failure.
            </p>
          </div>
        </div>

        <h3>Grading Rubric (Upload Separately to IPFS)</h3>
        <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
          Upload this JSON file to IPFS first, then put its CID in <code>manifest.additional</code>.
        </p>
        <div className="code-block">
          <div className="code-header">
            <span>gradingRubric.json</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`{
  "version": "rubric-1",
  "title": "My Bounty Grading Rubric",
  "description": "Evaluate the submitted work product",
  "threshold": 70,
  "criteria": [
    {
      "id": "requirements",
      "label": "Meets Requirements",
      "weight": 0.5,
      "must": true,
      "description": "Does the submission address all stated requirements?"
    },
    {
      "id": "quality",
      "label": "Overall Quality",
      "weight": 0.5,
      "must": false,
      "description": "Is the work well-crafted and professional?"
    }
  ],
  "forbiddenContent": ["Plagiarism", "NSFW content", "Hate speech"]
}`, 'rubric-example')}
            >
              {copiedCode === 'rubric-example' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`{
  "version": "rubric-1",
  "title": "My Bounty Grading Rubric",
  "description": "Evaluate the submitted work product",
  "threshold": 70,
  "criteria": [
    {
      "id": "requirements",
      "label": "Meets Requirements",
      "weight": 0.5,
      "must": true,
      "description": "Does the submission address all stated requirements?"
    },
    {
      "id": "quality",
      "label": "Overall Quality",
      "weight": 0.5,
      "must": false,
      "description": "Is the work well-crafted and professional?"
    }
  ],
  "forbiddenContent": ["Plagiarism", "NSFW content", "Hate speech"]
}`}</code></pre>
        </div>

        <h3>primary_query.json (Required - Oracle Evaluation Prompt)</h3>
        <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
          This file contains the evaluation prompt sent to AI oracle models. It must have three fields:
          a <code>query</code> string with the full evaluation instructions, a <code>references</code> array
          linking to attachments, and an <code>outcomes</code> array.
        </p>
        <div className="code-block">
          <div className="code-header">
            <span>primary_query.json</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`{
  "query": "WORK PRODUCT EVALUATION REQUEST\\n\\nYou are evaluating a work product submission to determine whether it meets the required quality standards for payment release from escrow.\\n\\n=== TASK DESCRIPTION ===\\nWork Product Type: [Your work type]\\nTask Title: [Your bounty title]\\nTask Description: [Your detailed task description]\\n\\n=== EVALUATION INSTRUCTIONS ===\\nA detailed grading rubric is provided as an attachment (gradingRubric). You must thoroughly evaluate the submitted work product against ALL criteria specified in the rubric.\\n\\nFor each evaluation criterion in the rubric:\\n1. Assess how well the work product meets the requirement\\n2. Note specific strengths and weaknesses\\n3. Consider the overall quality and completeness\\n\\n=== YOUR TASK ===\\nEvaluate the quality of the submitted work product and provide scores for two outcomes:\\n- DONT_FUND: The work product does not meet quality standards\\n- FUND: The work product meets quality standards\\n\\nBase your scoring on the overall quality assessment from the rubric criteria. Higher quality work should receive higher FUND scores, while lower quality work should receive higher DONT_FUND scores.\\n\\nIn your justification, explain your evaluation of each rubric criterion and how the work product performs against the stated requirements.\\n\\nThe submitted work product will be provided in the next section.",
  "references": ["gradingRubric"],
  "outcomes": ["DONT_FUND", "FUND"]
}`, 'query-example')}
            >
              {copiedCode === 'query-example' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`{
  "query": "WORK PRODUCT EVALUATION REQUEST\\n\\n...full prompt...",
  "references": ["gradingRubric"],  // ← links to rubric in manifest.additional
  "outcomes": ["DONT_FUND", "FUND"]
}

// The "query" field must contain the FULL evaluation prompt including:
// - Task description (title, type, detailed description)
// - Evaluation instructions referencing the grading rubric
// - Clear scoring criteria (DONT_FUND vs FUND)
//
// See the Node.js example below for a complete query template.`}</code></pre>
        </div>

        <div className="callout callout-critical" style={{ marginTop: '1rem' }}>
          <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>Use the Exact Query Template — Do Not Abbreviate</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              The oracle adapter parses the query by its section headers. You <strong>must</strong> use
              the standard template with these exact headers: <code>=== TASK DESCRIPTION ===</code>,{' '}
              <code>=== EVALUATION INSTRUCTIONS ===</code>, and <code>=== YOUR TASK ===</code>.
            </p>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              Custom or abbreviated queries (e.g., using <code>=== TASK ===</code> or omitting sections)
              will cause <strong>silent oracle failure</strong> — the submission will be stuck in PendingVerdikta
              permanently with no error message. Copy the full template from the Node.js example below
              and only change the placeholder values.
            </p>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              Inside <code>=== TASK DESCRIPTION ===</code>, the three fields must each be on a single line
              with the value on the <strong>same line</strong> as the key — no blank lines between them:
            </p>
            <pre style={{ margin: '0.5rem 0 0 0', padding: '0.5rem', background: 'rgba(0,0,0,0.1)', borderRadius: '0.25rem', fontSize: '0.8rem' }}>
{`✅ Correct:
Task Title: My Bounty Title
Task Description: The full description on the same line.

❌ Wrong (oracle timeout):
Task Title: My Bounty Title

Task Description:
The description on the next line.`}
            </pre>
          </div>
        </div>

        <h3>Creating the ZIP (Command Line)</h3>
        <div className="code-block">
          <div className="code-header">
            <span>Shell commands</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`# Create your evaluation folder
mkdir my-evaluation
cd my-evaluation

# Create manifest.json and primary_query.json files
# (see examples above)

# IMPORTANT: Zip the FILES, not the folder!
# ❌ Wrong: zip -r evaluation.zip my-evaluation/
# ✅ Correct:
cd my-evaluation
zip -r ../evaluation.zip .

# Upload to IPFS (using Pinata CLI as example)
pinata upload evaluation.zip`, 'zip-commands')}
            >
              {copiedCode === 'zip-commands' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`# Create your evaluation folder
mkdir my-evaluation
cd my-evaluation

# Create manifest.json and primary_query.json files
# (see examples above)

# IMPORTANT: Zip the FILES, not the folder!
# ❌ Wrong: zip -r evaluation.zip my-evaluation/
# ✅ Correct:
cd my-evaluation
zip -r ../evaluation.zip .

# Upload to IPFS (using Pinata CLI as example)
pinata upload evaluation.zip`}</code></pre>
        </div>

        <h3>Complete Upload Flow (Node.js)</h3>
        <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
          Two-step process: upload rubric first, then create ZIP that references it.
        </p>
        <div className="code-block">
          <div className="code-header">
            <span>JavaScript / Node.js</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(`const archiver = require('archiver');

// ============================================
// STEP 1: Upload grading rubric to IPFS first
// ============================================
const gradingRubric = {
  version: "rubric-1",
  title: "My Bounty Grading Rubric",
  description: "Evaluate the submitted work product",
  threshold: 70,
  criteria: [
    { id: "requirements", label: "Meets Requirements", weight: 0.5, must: true, description: "Does the submission address all stated requirements?" },
    { id: "quality", label: "Overall Quality", weight: 0.5, must: false, description: "Is the work well-crafted and professional?" }
  ],
  forbiddenContent: ["Plagiarism", "NSFW content"]
};

// Upload rubric as JSON (this one CAN use pinJSONToIPFS since it's just data)
async function uploadJsonToPinata(data, name) {
  const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.PINATA_JWT}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      pinataContent: data,
      pinataMetadata: { name }
    })
  });
  const result = await response.json();
  return result.IpfsHash;
}

const rubricCid = await uploadJsonToPinata(gradingRubric, 'rubric.json');
console.log('Rubric CID:', rubricCid);

// ============================================
// STEP 2: Create evaluation ZIP referencing rubric
// ============================================
async function createEvaluationZip(title, description, workProductType, rubricCid, juryNodes) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip');
    const chunks = [];

    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    // manifest.json - MUST include additional array AND bCIDs
    archive.append(JSON.stringify({
      version: "1.0",
      name: \`\${title} - Evaluation for Payment Release\`,
      primary: { filename: "primary_query.json" },
      juryParameters: {
        NUMBER_OF_OUTCOMES: 2,
        AI_NODES: juryNodes.map(n => ({
          AI_MODEL: n.model,
          AI_PROVIDER: n.provider,
          NO_COUNTS: n.runs || 1,
          WEIGHT: n.weight
        })),
        ITERATIONS: 1
      },
      additional: [
        {
          name: "gradingRubric",
          type: "ipfs/cid",
          hash: rubricCid,
          description: "Work Product grading rubric with evaluation criteria"
        }
      ],
      bCIDs: {
        submittedWork: "The work submitted by a hunter."
      }
    }, null, 2), { name: 'manifest.json' });

    // primary_query.json - MUST have "query" field with full instructions
    const query = \`WORK PRODUCT EVALUATION REQUEST

You are evaluating a work product submission to determine whether it meets the required quality standards for payment release from escrow.

=== TASK DESCRIPTION ===
Work Product Type: \${workProductType}
Task Title: \${title}
Task Description: \${description}

=== EVALUATION INSTRUCTIONS ===
A detailed grading rubric is provided as an attachment (gradingRubric). You must thoroughly evaluate the submitted work product against ALL criteria specified in the rubric.

For each evaluation criterion in the rubric:
1. Assess how well the work product meets the requirement
2. Note specific strengths and weaknesses
3. Consider the overall quality and completeness

=== YOUR TASK ===
Evaluate the quality of the submitted work product and provide scores for two outcomes:
- DONT_FUND: The work product does not meet quality standards
- FUND: The work product meets quality standards

Base your scoring on the overall quality assessment from the rubric criteria. Higher quality work should receive higher FUND scores, while lower quality work should receive higher DONT_FUND scores.

In your justification, explain your evaluation of each rubric criterion and how the work product performs against the stated requirements.

The submitted work product will be provided in the next section.\`;

    archive.append(JSON.stringify({
      query,
      references: ["gradingRubric"],  // ← REQUIRED: links to rubric
      outcomes: ["DONT_FUND", "FUND"]
    }, null, 2), { name: 'primary_query.json' });

    archive.finalize();
  });
}

const zipBuffer = await createEvaluationZip(
  "Write a Blog Post",                    // title
  "Create an engaging blog post about AI", // description
  "Blog Post",                            // workProductType
  rubricCid,                              // rubric CID from step 1
  [
    { provider: "OpenAI", model: "gpt-5.2-2025-12-11", weight: 0.5 },
    { provider: "Anthropic", model: "claude-3-5-haiku-20241022", weight: 0.5 }
  ]
);

// ============================================
// STEP 3: Upload ZIP to IPFS (NOT pinJSONToIPFS!)
// ============================================
async function uploadZipToPinata(buffer, filename) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: 'application/zip' });
  formData.append('file', blob, filename);
  formData.append('pinataMetadata', JSON.stringify({ name: filename }));

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { 'Authorization': \`Bearer \${process.env.PINATA_JWT}\` },
    body: formData
  });
  const result = await response.json();
  return result.IpfsHash;
}

const evaluationCid = await uploadZipToPinata(zipBuffer, 'evaluation.zip');
console.log('Evaluation CID:', evaluationCid);

// Verify upload is actually a ZIP
async function verifyZipFormat(cid) {
  const resp = await fetch(\`https://gateway.pinata.cloud/ipfs/\${cid}\`);
  const bytes = new Uint8Array(await resp.arrayBuffer()).slice(0, 4);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B; // "PK" magic bytes
  if (!isZip) throw new Error('Upload is not a ZIP! Did you use pinJSONToIPFS by mistake?');
  console.log('✅ Verified: CID is a valid ZIP archive');
}

await verifyZipFormat(evaluationCid);
// Use evaluationCid when calling createBounty()`, 'js-zip-example')}
            >
              {copiedCode === 'js-zip-example' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{`const archiver = require('archiver');

// ============================================
// STEP 1: Upload grading rubric to IPFS first
// ============================================
const gradingRubric = {
  version: "rubric-1",
  title: "My Bounty Grading Rubric",
  description: "Evaluate the submitted work product",
  threshold: 70,
  criteria: [
    { id: "requirements", label: "Meets Requirements", weight: 0.5, must: true, description: "..." },
    { id: "quality", label: "Overall Quality", weight: 0.5, must: false, description: "..." }
  ],
  forbiddenContent: ["Plagiarism", "NSFW content"]
};

// Upload rubric as JSON (this one CAN use pinJSONToIPFS since it's just data)
async function uploadJsonToPinata(data, name) {
  const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.PINATA_JWT}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pinataContent: data, pinataMetadata: { name } })
  });
  return (await response.json()).IpfsHash;
}

const rubricCid = await uploadJsonToPinata(gradingRubric, 'rubric.json');
console.log('Rubric CID:', rubricCid);

// ============================================
// STEP 2: Create evaluation ZIP with FULL query format
// ============================================
function buildEvaluationQuery(title, description, workProductType) {
  return \`WORK PRODUCT EVALUATION REQUEST

You are evaluating a work product submission to determine whether it meets the required quality standards for payment release from escrow.

=== TASK DESCRIPTION ===
Work Product Type: \${workProductType}
Task Title: \${title}
Task Description: \${description}

=== EVALUATION INSTRUCTIONS ===
A detailed grading rubric is provided as an attachment (gradingRubric). You must thoroughly evaluate the submitted work product against ALL criteria specified in the rubric.

=== YOUR TASK ===
Evaluate the quality and provide scores for:
- DONT_FUND: Does not meet quality standards
- FUND: Meets quality standards

The submitted work product will be provided in the next section.\`;
}

async function createEvaluationZip(title, desc, workType, rubricCid, juryNodes) {
  // ... archiver setup ...

  // manifest.json - with bCIDs
  archive.append(JSON.stringify({
    version: "1.0",
    name: \`\${title} - Evaluation for Payment Release\`,
    primary: { filename: "primary_query.json" },
    juryParameters: { /* ... */ },
    additional: [{ name: "gradingRubric", type: "ipfs/cid", hash: rubricCid, description: "..." }],
    bCIDs: { submittedWork: "The work submitted by a hunter." }  // ← REQUIRED
  }, null, 2), { name: 'manifest.json' });

  // primary_query.json - MUST use "query" format, NOT title/description!
  archive.append(JSON.stringify({
    query: buildEvaluationQuery(title, desc, workType),  // ← Full prompt
    references: ["gradingRubric"],                        // ← Links to rubric
    outcomes: ["DONT_FUND", "FUND"]
  }, null, 2), { name: 'primary_query.json' });
}

const zipBuffer = await createEvaluationZip(
  "Write a Blog Post", "Create an engaging blog post about AI",
  "Blog Post", rubricCid,
  [{ provider: "OpenAI", model: "gpt-5.2-2025-12-11", weight: 1 }]
);

// ============================================
// STEP 3: Upload ZIP to IPFS (NOT pinJSONToIPFS!)
// ============================================
async function uploadZipToPinata(buffer, filename) {
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: 'application/zip' }), filename);
  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { 'Authorization': \`Bearer \${process.env.PINATA_JWT}\` },
    body: formData
  });
  return (await response.json()).IpfsHash;
}

const evaluationCid = await uploadZipToPinata(zipBuffer, 'evaluation.zip');
console.log('Evaluation CID:', evaluationCid);
// Use evaluationCid when calling createBounty()`}</code></pre>
        </div>

        <div className="callout callout-critical" style={{ marginTop: '1.5rem' }}>
          <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>Pinata Users: Do NOT use pinJSONToIPFS for the evaluation ZIP!</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              The <code>pinJSONToIPFS</code> endpoint uploads raw JSON, not a ZIP archive.
              You <strong>MUST</strong> use <code>pinFileToIPFS</code> for the evaluation package.
            </p>
            <div style={{ marginTop: '0.75rem', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
              <div style={{ color: '#16a34a' }}>✅ <code>pinJSONToIPFS</code> — OK for grading rubric (it's just JSON data)</div>
              <div style={{ color: '#dc2626', marginTop: '0.25rem' }}>❌ <code>pinJSONToIPFS</code> — WRONG for evaluation package (must be ZIP)</div>
              <div style={{ color: '#16a34a', marginTop: '0.25rem' }}>✅ <code>pinFileToIPFS</code> — CORRECT for evaluation package ZIP</div>
            </div>
          </div>
        </div>

        <div className="callout callout-info" style={{ marginTop: '1rem' }}>
          <div>
            <strong>Common Mistakes to Avoid:</strong>
            <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.5rem' }}>
              <li><strong>❌ Incomplete primary_query.json</strong> — Must have all three fields: <code>query</code> (full prompt string), <code>references</code>, and <code>outcomes</code></li>
              <li><strong>❌ Missing "bCIDs" in manifest</strong> — Required for oracles to find submitted work</li>
              <li><strong>❌ Using pinJSONToIPFS for ZIP</strong> — Use <code>pinFileToIPFS</code> for the evaluation package</li>
              <li><strong>❌ Uploading raw JSON as evaluation</strong> — Always ZIP first, then upload the ZIP file</li>
              <li><strong>❌ Missing manifest.additional array</strong> — Required for rubric reference</li>
              <li><strong>❌ Zipping the folder</strong> — Zip the <em>contents</em>, not the containing folder</li>
              <li><strong>❌ Using unsupported AI models</strong> — Models like <code>gpt-4o</code> or <code>claude-3-5-sonnet-20241022</code> are not registered on the oracle network. Use only verified models (see supported list above)</li>
              <li><strong>❌ Custom or abbreviated query template</strong> — The oracle parses exact section headers (<code>=== TASK DESCRIPTION ===</code>, <code>=== EVALUATION INSTRUCTIONS ===</code>, <code>=== YOUR TASK ===</code>). Do not rewrite or shorten the template</li>
              <li><strong>❌ Multiline Task Description field</strong> — Inside the TASK DESCRIPTION section, write <code>Task Description: your text here</code> on a single line. Putting the description on a separate line or adding blank lines between fields causes oracle timeout</li>
            </ul>
          </div>
        </div>

        <h3 style={{ marginTop: '2rem' }}>Always Validate Before Announcing</h3>
        <p>After creating a bounty, validate it before sharing publicly:</p>
        <div className="code-block" style={{ marginTop: '1rem' }}>
          <div className="code-header">
            <span>Validation Check</span>
          </div>
          <pre><code>{`# Validate your bounty's evaluation package
curl -H "X-Bot-API-Key: YOUR_KEY" \\
  "https://bounties-testnet.verdikta.org/api/jobs/YOUR_JOB_ID/validate"

# ✅ GOOD - No issues at all:
{ "valid": true, "issues": [] }

# ⚠️ WARNING - Works but not ideal (missing rubric reference):
{ "valid": true, "issues": [
  {"severity": "warning", "message": "Manifest does not reference a grading rubric..."}
]}

# ❌ ERROR - Will not work with oracles:
{ "valid": false, "issues": [
  {"severity": "error", "message": "Evaluation package is plain JSON, not a ZIP archive..."}
]}`}</code></pre>
        </div>
      </section>

      {/* IPFS Content Structure */}
      <section className="blockchain-section">
        <h2>Complete IPFS Package Reference</h2>
        <p className="section-intro">
          Full reference for evaluation and submission package formats.
        </p>
        <div className="code-block">
          <div className="code-header">
            <span>Content Package Formats</span>
            <button
              className="btn-icon"
              onClick={() => copyToClipboard(ipfsStructure, 'ipfs')}
            >
              {copiedCode === 'ipfs' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <pre><code>{ipfsStructure}</code></pre>
        </div>
      </section>

      {/* Troubleshooting Section */}
      <section className="blockchain-section">
        <h2>Troubleshooting</h2>
        <div className="faq-list">
          <div className="faq-item">
            <button
              className="faq-question"
              onClick={() => toggleSection('trouble1')}
            >
              <span>Transaction reverts with "bad bountyId"</span>
              {expandedSection === 'trouble1' ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>
            {expandedSection === 'trouble1' && (
              <div className="faq-answer">
                <p>
                  The bounty ID doesn't exist on-chain. Verify by calling <code>bountyCount()</code> to see
                  the total number of bounties. IDs are 0-indexed, so valid IDs are 0 to count-1.
                </p>
              </div>
            )}
          </div>
          <div className="faq-item">
            <button
              className="faq-question"
              onClick={() => toggleSection('trouble2')}
            >
              <span>startPreparedSubmission fails with "insufficient allowance"</span>
              {expandedSection === 'trouble2' ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>
            {expandedSection === 'trouble2' && (
              <div className="faq-answer">
                <p>
                  You haven't approved enough LINK to the EvaluationWallet. Make sure you:
                </p>
                <ol>
                  <li>Approve LINK to the <code>evalWallet</code> address (not the BountyEscrow)</li>
                  <li>Approve the full <code>linkMaxBudget</code> amount returned from prepareSubmission</li>
                  <li>Wait for the approval transaction to confirm before calling startPreparedSubmission</li>
                </ol>
              </div>
            )}
          </div>
          <div className="faq-item">
            <button
              className="faq-question"
              onClick={() => toggleSection('trouble3')}
            >
              <span>Submission stuck in PendingVerdikta status</span>
              {expandedSection === 'trouble3' ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>
            {expandedSection === 'trouble3' && (
              <div className="faq-answer">
                <p>
                  AI evaluations take some time. Normal evaluation time is ~30 seconds to 2 minutes.
                  If stuck longer than 10 minutes, you can call <code>failTimedOutSubmission()</code>
                  to mark it as failed and recover your LINK.
                </p>
              </div>
            )}
          </div>
          <div className="faq-item">
            <button
              className="faq-question"
              onClick={() => toggleSection('trouble4')}
            >
              <span>How do I know when evaluation is complete?</span>
              {expandedSection === 'trouble4' ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>
            {expandedSection === 'trouble4' && (
              <div className="faq-answer">
                <p>
                  Poll the Verdikta Aggregator contract. Get the <code>verdiktaAggId</code> from the
                  <code>WorkSubmitted</code> event, then call <code>verdikta.getEvaluation(aggId)</code>.
                  When the third return value (<code>ok</code>) is true, finalization is ready.
                </p>
              </div>
            )}
          </div>
          <div className="faq-item">
            <button
              className="faq-question"
              onClick={() => toggleSection('trouble5')}
            >
              <span>My score is in a strange format (e.g., 880000)</span>
              {expandedSection === 'trouble5' ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>
            {expandedSection === 'trouble5' && (
              <div className="faq-answer">
                <p>
                  Verdikta returns scores with 6 decimal precision (0-1,000,000 representing 0%-100%).
                  Divide by 10,000 to get a percentage. For example, 880000 = 88%.
                </p>
                <pre><code>{`const percentage = score / 10000;  // 880000 → 88%`}</code></pre>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="blockchain-footer-cta">
        <h2>Choose Your Integration Path</h2>
        <p>
          Direct blockchain access gives you full control. For a simpler integration,
          use the REST API with automatic IPFS handling.
        </p>
        <div className="footer-actions">
          <Link to="/agents" className="btn btn-secondary btn-lg">
            <Bot size={18} />
            API Documentation
          </Link>
          <a
            href={`${contracts.sepolia.explorer}/address/${contracts.sepolia.bountyEscrow}#code`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-lg"
          >
            <ExternalLink size={18} />
            View Contract Source
          </a>
        </div>
      </section>
    </div>
  );
}

export default Blockchain;
