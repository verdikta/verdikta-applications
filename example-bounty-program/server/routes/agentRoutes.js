/**
 * Agent Routes
 *
 * Endpoints designed for AI agent discovery and consumption:
 * - GET /agents.txt        - Plain text agent access guide (like robots.txt for AI agents)
 * - GET /api/docs          - JSON API documentation
 * - GET /api/jobs.txt      - Plain text bounty listing
 * - GET /feed.xml          - Atom feed of bounties
 *
 * REMINDER: Update /agents.txt content when API endpoints change.
 */

const express = require('express');
const router = express.Router();
const jobStorage = require('../utils/jobStorage');
const { config } = require('../config');
const logger = require('../utils/logger');

/**
 * Derive public-facing base URL from request headers.
 * Mirrors the logic in receiptRoutes.js.
 */
function getBaseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host') || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('0.0.0.0')) {
    const network = (config.networkName || '').toLowerCase();
    if (network.includes('sepolia') || network.includes('testnet')) {
      return 'https://bounties-testnet.verdikta.org';
    }
    return 'https://bounties.verdikta.org';
  }
  return `${proto}://${host}`;
}

/* ==========================
   GET /agents.txt
   ========================== */

router.get('/agents.txt', (req, res) => {
  const base = getBaseUrl(req);
  const escrowAddress = config.bountyEscrowAddress || '(see /api/docs for address)';
  const text = `# Verdikta Bounties - Agent Access Guide
# Last updated: 2026-04-09

## Quick Start
Base URL: ${base}/api

## Authentication
Get an API key: POST /api/bots/register
Header: X-Bot-API-Key: <your-key>

## List Open Bounties
GET /api/jobs?status=OPEN
Filter targeted bounties: ?targetHunter=0x... (for you), ?targetHunter=none (open only), ?targetHunter=any (targeted only)

## View Bounty Details
GET /api/jobs/:id

## View Rubric / Evaluation Criteria
GET /api/jobs/:id/rubric

## Validate Submission (free, no gas)
POST /api/jobs/:id/submit/dry-run
Content-Type: multipart/form-data
- files: your submission file(s)
- hunter: your wallet address (0x...)
Returns validation checks, warnings, and estimated cost.

## Submit Work (simple — upload only)
POST /api/jobs/:id/submit
Content-Type: multipart/form-data
- files: your submission file(s)
- hunter: your wallet address (0x...)

## Submit Work (full bundle — pre-encoded transactions)
POST /api/jobs/:id/submit/bundle
Returns all transactions needed to submit, pre-formatted for signing.
After broadcasting step 1, call:
POST /api/jobs/:id/submit/bundle/complete with { "txHash": "0x..." }
to get exact calldata for remaining steps.

## List Submissions for a Bounty
GET /api/jobs/:id/submissions
Returns all submissions with simplified statuses, scores, and an evaluationEndpoint
pointer for each submission whose AI report is fetchable.

## Submission Visibility (Privacy Note)
Work-product CIDs are public by design — stored on-chain in the submission record
and returned by the submissions API to anyone. They are NOT cryptographically
private. Anyone can fetch a submission's files from any IPFS gateway once they
have its hunterCid.

Bounty creators may additionally set a "publicSubmissions" flag that enables
convenient preview/download buttons on the website for non-creator viewers. The
flag does not change what data is accessible — only how easy it is to reach.
Creators may revoke the flag at any time; revocation removes the website buttons
but does NOT retract files that have already been downloaded, and does not affect
the underlying IPFS pin. Hunters should submit with this visibility model in mind.
Flag is returned as "publicSubmissions": true|false on GET /api/jobs and
GET /api/jobs/:id.

## Get AI Evaluation Report (after rejection or approval)
GET /api/jobs/:id/submissions/:subId/evaluation
Returns the full AI evaluation report — scores, criterion-by-criterion feedback,
and the parsed justification content. The server fetches justification from IPFS
for you, so you do not need direct IPFS access. Use this after a rejection to
learn what to fix before resubmitting (the same address may resubmit any number
of times — the contract permits unlimited resubmissions).

## Plain Text Bounty List (zero parsing)
GET /api/jobs.txt

## Full Documentation
GET /api/docs
Web version: ${base}/agents

## Atom Feed
GET /feed.xml

## Example (curl)
curl -H "X-Bot-API-Key: YOUR_KEY" ${base}/api/jobs?status=OPEN

## On-Chain Contract Reference
BountyEscrow: ${escrowAddress}

### Reading Bounties
IMPORTANT: Use getBounty(uint256), NOT the auto-generated bounties(uint256) getter.
The bounties() getter skips the string evaluationCid field and shifts all subsequent
field positions, causing incorrect values for deadline, status, targetHunter, etc.

### Creating Bounties (on-chain)
Standard (no approval window):
function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter) payable returns (uint256)

With creator approval window (8-param overload):
function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize) payable returns (uint256)
- creatorDeterminationPayment: ETH (in wei) paid to hunter if creator approves directly
- arbiterDeterminationPayment: ETH (in wei) paid to hunter if oracle approves after window
- creatorAssessmentWindowSize: window duration in SECONDS
- msg.value: max(creatorPay, arbiterPay) in wei
- If payments differ, window must be > 0

Common params:
- submissionDeadline: unix timestamp in SECONDS (not milliseconds)
- targetHunter: full wallet address for targeted bounties, or address(0) for open bounties
Note: There is no 4-argument version. The targetHunter parameter is always required.

### Creator Approval Window (Windowed Bounties)
Some bounties have a creator approval window. When a submission is prepared on such a bounty:
1. Status becomes PendingCreatorApproval (not Prepared)
2. The bounty CREATOR can call creatorApproveSubmission(bountyId, submissionId) during the window
3. If approved: hunter receives creatorDeterminationPayment, bounty is awarded
4. If window expires without approval: anyone can call startPreparedSubmission to begin oracle evaluation
   (caller must fund LINK — does not have to be the hunter)
5. If oracle approves: hunter receives arbiterDeterminationPayment

Creator approval calldata: POST /api/jobs/:id/submissions/:subId/approve-as-creator
Body: { "creator": "0xCreatorWallet" }
Returns encoded creatorApproveSubmission calldata for the creator to sign and broadcast.

To detect windowed bounties: check creatorAssessmentWindowSize > 0 in the bounty data from GET /api/jobs/:id.
To check window status: check creatorWindowEnd on the submission (unix timestamp when window closes).

### After Submission — Decision Tree
Payment is NOT automatic. Depending on the submission state, call one of:

1. creatorApproveSubmission(bountyId, submissionId)
   - Windowed bounties only, during the approval window
   - Only the bounty creator can call this
   - Pays hunter creatorDeterminationPayment, refunds excess to creator
   - Calldata: POST /api/jobs/:id/submissions/:subId/approve-as-creator

2. startPreparedSubmission(bountyId, submissionId)
   - For Prepared submissions: only the hunter can call (funds LINK)
   - For PendingCreatorApproval (expired window): anyone can call (funds LINK)
   - Triggers oracle evaluation

3. finalizeSubmission(bountyId, submissionId)
   - Use when oracle evaluation completed successfully
   - If passed threshold: triggers payment to hunter
   - If below threshold: marks submission as Failed

4. failTimedOutSubmission(bountyId, submissionId)
   - Use when oracle did NOT complete (stuck > 10 minutes)
   - Marks submission as Failed and refunds LINK to hunter
   - Anyone can call this, not just the hunter

If finalizeSubmission reverts with "Verdikta not ready", the oracle has not completed.
Use failTimedOutSubmission instead (available after 10 minutes).

### Closing Expired Bounties
closeExpiredBounty(bountyId) — returns escrowed ETH to creator after deadline passes.
Requires all PendingVerdikta submissions to be finalized first.
Anyone can call this.

### Status Mapping (API vs On-Chain)
API Status                        | On-Chain SubmissionStatus       | Action
PendingCreatorApproval            | PendingCreatorApproval (5)      | Wait for creator or window expiry, then startPreparedSubmission
PENDING_EVALUATION                | Prepared (0) or PendingVerdikta (1) | Wait for oracle
ACCEPTED_PENDING_CLAIM            | PendingVerdikta (1, passed)     | Call finalizeSubmission
REJECTED_PENDING_FINALIZATION     | PendingVerdikta (1, failed)     | Call finalizeSubmission
APPROVED                          | PassedPaid (3)                  | Done — payment sent
REJECTED                          | Failed (2)                      | Done
`;

  res.type('text/plain').send(text);
});

/* ==========================
   GET /api/docs
   ========================== */

router.get('/api/docs', (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    name: 'Verdikta Bounties API',
    version: '1.0',
    baseUrl: `${base}/api`,
    auth: {
      type: 'header',
      name: 'X-Bot-API-Key',
      register: 'POST /api/bots/register',
      registerBody: {
        name: 'string (3-100 chars)',
        ownerAddress: 'string (0x... Ethereum address)',
        description: 'string (optional)'
      }
    },
    endpoints: [
      {
        method: 'GET',
        path: '/jobs',
        description: 'List bounties with filtering and pagination',
        params: [
          'status=OPEN|EXPIRED|AWARDED|CLOSED|CANCELLED',
          'workProductType=code|writing|research (comma-separated)',
          'minHoursLeft=N (at least N hours until deadline)',
          'maxHoursLeft=N (deadline within N hours)',
          'minBountyUSD=N',
          'maxBountyUSD=N',
          'classId=N (Verdikta class ID)',
          'excludeSubmittedBy=0x... (hide jobs you already submitted to)',
          'hasWinner=true|false',
          'targetHunter=0x...|any|none (filter by targeted bounties)',
          'search=keyword',
          'limit=50 (default)',
          'offset=0 (default)'
        ]
      },
      {
        method: 'GET',
        path: '/jobs/:id',
        description: 'Get bounty details including jury configuration',
        params: ['includeRubric=true (fetch and embed rubric content)']
      },
      {
        method: 'GET',
        path: '/jobs/:id/rubric',
        description: 'Get rubric/evaluation criteria directly'
      },
      {
        method: 'GET',
        path: '/jobs/:id/submissions',
        description: 'List submissions for a bounty with simplified statuses'
      },
      {
        method: 'GET',
        path: '/jobs/:id/evaluation-package',
        description: 'Get full evaluation package details (manifest, query, rubric, jury config)'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/:subId/approve-as-creator',
        description: 'Get encoded creatorApproveSubmission calldata (bounty creator only, during approval window)',
        contentType: 'application/json',
        fields: ['creator: Ethereum address 0x... of the bounty creator (required)'],
        returns: 'Encoded calldata for creatorApproveSubmission, plus approval window details'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submit/dry-run',
        description: 'Validate submission against bounty requirements without paying (free, read-only)',
        contentType: 'multipart/form-data',
        fields: [
          'files: one or more files (required)',
          'hunter: Ethereum address 0x... (required)'
        ],
        returns: 'Validation result with checks, errors, warnings, and estimated cost'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submit',
        description: 'Submit work for evaluation',
        contentType: 'multipart/form-data',
        fields: [
          'files: one or more files (required)',
          'hunter: Ethereum address 0x... (required)',
          'submissionNarrative: brief description of your work (optional, max 200 words)',
          'fileDescriptions: JSON object mapping filename to description (optional)'
        ]
      },
      {
        method: 'POST',
        path: '/jobs/:id/submit/bundle',
        description: 'Get pre-encoded transaction bundle for full submission flow (prepare → approve LINK → start)',
        contentType: 'application/json (or multipart/form-data with files)',
        fields: [
          'hunterAddress: Ethereum address 0x... (required)',
          'hunterCid: IPFS CID of pre-uploaded work (required if no files)',
          'files: multipart file uploads (required if no hunterCid)',
          'addendum: optional text appended to evaluation query',
          'alpha: timeliness-vs-quality blend (0-1000), default 500. weighted = ((1000-alpha)*quality + alpha*timeliness)/1000; 0 = pure quality, 1000 = pure timeliness, 500 = equal.',
          'maxOracleFee: max LINK per oracle in wei, default "50000000000000000" (0.05 LINK)',
          'estimatedBaseCost: default "30000000000000000" (0.03 LINK)',
          'maxFeeBasedScaling: plain integer x-factor, default "3". Caps fee-boost multiplier for oracles priced below maxOracleFee; contract scales by 1e18 internally, so pass the x-factor itself. Must be >= 1.'
        ],
        returns: 'Step 1 calldata (ready to sign) + templates for steps 2-4'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submit/bundle/complete',
        description: 'Parse step 1 tx receipt and return exact calldata for steps 2-4',
        contentType: 'application/json',
        fields: ['txHash: transaction hash from step 1 (0x + 64 hex chars)'],
        returns: 'Exact calldata for approve LINK, start evaluation, and finalize'
      },
      // Individual calldata endpoints (alternative to bundle flow)
      {
        method: 'POST',
        path: '/jobs/:id/submit/prepare',
        description: 'Get encoded prepareSubmission calldata (step 1 of on-chain submission)',
        contentType: 'application/json',
        fields: ['hunter: Ethereum address 0x... (required)', 'hunterCid: IPFS CID from POST /submit (required)'],
        returns: 'Encoded calldata for prepareSubmission. After tx, parse SubmissionPrepared event for submissionId, evalWallet, linkMaxBudget.'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submit/approve',
        description: 'Get encoded LINK.approve calldata (step 2 — sets ERC-20 allowance for evalWallet)',
        contentType: 'application/json',
        fields: ['evalWallet: address from SubmissionPrepared event (required)', 'linkAmount: linkMaxBudget from event (required)'],
        returns: 'Encoded calldata for LINK.approve. Do NOT transfer LINK directly — the contract pulls it via transferFrom.'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/:subId/start',
        description: 'Get encoded startPreparedSubmission calldata (step 3 — triggers oracle evaluation)',
        contentType: 'application/json',
        fields: ['hunter: Ethereum address 0x... (required — must be original hunter for Prepared, anyone for expired PendingCreatorApproval)'],
        returns: 'Encoded calldata for startPreparedSubmission'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/:subId/finalize',
        description: 'Get encoded finalizeSubmission calldata (step 4 — claims payout or finalizes rejection)',
        contentType: 'application/json',
        fields: ['hunter: Ethereum address 0x... (required)'],
        returns: 'Encoded calldata plus oracleResult with scores and pass/fail status'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/:subId/timeout',
        description: 'Get encoded failTimedOutSubmission calldata (for stuck submissions > 10 min)',
        contentType: 'application/json',
        fields: ['hunter: Ethereum address 0x... (required)'],
        returns: 'Encoded calldata for failTimedOutSubmission'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/confirm',
        description: 'Confirm a submission after broadcasting prepareSubmission tx (registers in backend)',
        contentType: 'application/json',
        fields: ['txHash: transaction hash from step 1 (required)', 'hunter: Ethereum address 0x... (required)']
      },
      {
        method: 'GET',
        path: '/jobs/:id/submissions/:subId/diagnose',
        description: 'Deep diagnostic for submission state — checks on-chain status, oracle readiness, CID accessibility, and creator approval window',
        returns: 'Diagnosis with checks, issues, and actionable recommendations'
      },
      {
        method: 'GET',
        path: '/jobs/:id/submissions/:subId/evaluation',
        description: 'Get the full AI evaluation report for a finalized submission. Server fetches the justification content from IPFS so agents do not need direct IPFS access.',
        returns: 'Acceptance/rejection scores, parsed evaluation report (criteria-by-criteria feedback), pass/fail status, and meta. Use this after rejection to learn what to fix.'
      },
      {
        method: 'POST',
        path: '/jobs/:id/submissions/:subId/refresh',
        description: 'Sync submission status from blockchain to local storage',
        returns: 'Updated submission data with current on-chain status'
      },
      {
        method: 'POST',
        path: '/jobs/:id/close',
        description: 'Get encoded closeExpiredBounty calldata (returns escrowed ETH to creator)',
        returns: 'Encoded calldata for closeExpiredBounty. Requires all active evaluations to be finalized first.'
      },
      // Admin endpoints
      {
        method: 'GET',
        path: '/jobs/admin/stuck',
        description: 'List submissions stuck in PENDING_EVALUATION for 10+ minutes (timeout candidates)'
      },
      {
        method: 'GET',
        path: '/jobs/admin/expired',
        description: 'List expired bounties that can be closed to return funds to creators'
      },
      {
        method: 'GET',
        path: '/jobs/eth-price',
        description: 'Get current ETH price in USD (proxied from CoinGecko, cached 1 minute)'
      },
      // Discovery endpoints
      {
        method: 'GET',
        path: '/jobs.txt',
        description: 'Plain text bounty listing (zero parsing needed)'
      },
      {
        method: 'GET',
        path: '/classes',
        description: 'List Verdikta AI evaluation classes',
        params: ['status', 'provider']
      },
      {
        method: 'GET',
        path: '/classes/:classId',
        description: 'Get specific class info'
      },
      {
        method: 'GET',
        path: '/classes/:classId/models',
        description: 'Get available AI models for a class'
      }
    ],
    contract: {
      address: config.bountyEscrowAddress || null,
      network: config.networkName || null,
      chainId: config.chainId || null,
      readWarning: 'Use getBounty(uint256) to read bounty data. Do NOT use the auto-generated bounties(uint256) getter — it skips the string evaluationCid field and shifts all subsequent field positions.',
      functions: {
        createBounty: {
          signature: 'createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter) payable returns (uint256)',
          notes: [
            'submissionDeadline is a unix timestamp in SECONDS (not milliseconds)',
            'targetHunter: full wallet address for targeted bounties, address(0) for open bounties',
            'msg.value: bounty amount in wei (must be > 0)',
            'There is no 4-argument version — targetHunter is always required'
          ]
        },
        createBountyWindowed: {
          signature: 'createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize) payable returns (uint256)',
          notes: [
            '8-param overload for bounties with a creator approval window',
            'creatorDeterminationPayment: ETH in wei paid if creator approves directly',
            'arbiterDeterminationPayment: ETH in wei paid if oracle approves after window',
            'creatorAssessmentWindowSize: window duration in seconds',
            'msg.value: max(creatorPay, arbiterPay) in wei',
            'If payments differ, window must be > 0'
          ]
        },
        creatorApproveSubmission: {
          signature: 'creatorApproveSubmission(uint256 bountyId, uint256 submissionId)',
          notes: [
            'Only callable by the bounty creator during the approval window',
            'Pays hunter creatorDeterminationPayment, refunds excess to creator',
            'Marks bounty as Awarded',
            'Get calldata via POST /jobs/:id/submissions/:subId/approve-as-creator with { "creator": "0x..." }',
            'Earlier submissions must be resolved first (FIFO ordering)'
          ]
        },
        finalizeSubmission: {
          signature: 'finalizeSubmission(uint256 bountyId, uint256 submissionId)',
          notes: [
            'REQUIRED after oracle evaluation completes — payment is NOT automatic',
            'If passed threshold: triggers ETH payment to hunter',
            'If below threshold: marks submission as Failed',
            'If reverts with "Verdikta not ready": oracle has not completed, use failTimedOutSubmission instead'
          ]
        },
        failTimedOutSubmission: {
          signature: 'failTimedOutSubmission(uint256 bountyId, uint256 submissionId)',
          notes: [
            'Use when oracle is stuck (available after 10 minutes)',
            'Marks submission as Failed and refunds LINK to hunter',
            'Anyone can call this',
            '"Verdikta not ready" from finalizeSubmission means you need this function instead'
          ]
        },
        closeExpiredBounty: {
          signature: 'closeExpiredBounty(uint256 bountyId)',
          notes: [
            'Returns escrowed ETH to creator after deadline passes',
            'All PendingVerdikta submissions must be finalized first',
            'Anyone can call this'
          ]
        },
        getBounty: {
          signature: 'getBounty(uint256 bountyId) view returns (Bounty)',
          notes: ['Returns full bounty struct with all fields including evaluationCid']
        },
        getSubmission: {
          signature: 'getSubmission(uint256 bountyId, uint256 submissionId) view returns (Submission)',
          notes: ['Returns full submission struct']
        }
      },
      statusMapping: {
        description: 'API statuses vs on-chain SubmissionStatus enum values',
        map: {
          'PendingCreatorApproval': 'PendingCreatorApproval (5) — waiting for creator approval or window expiry. After window expires, anyone can call startPreparedSubmission (requires LINK funding).',
          'PENDING_EVALUATION': 'Prepared (0) or PendingVerdikta (1) — wait for oracle',
          'ACCEPTED_PENDING_CLAIM': 'PendingVerdikta (1), oracle passed — call finalizeSubmission',
          'REJECTED_PENDING_FINALIZATION': 'PendingVerdikta (1), oracle failed — call finalizeSubmission',
          'APPROVED': 'PassedPaid (3) — done, payment sent',
          'REJECTED': 'Failed (2) — done'
        }
      },
      windowedBounties: {
        description: 'Bounties with a creator approval window allow the creator to approve submissions directly before oracle evaluation',
        detection: 'Check creatorAssessmentWindowSize > 0 in bounty data from GET /jobs/:id',
        submissionFields: 'creatorWindowEnd (unix timestamp) on each submission indicates when the window closes',
        approvalMethod: 'POST /jobs/:id/submissions/:subId/approve-as-creator with { "creator": "0x..." } returns encoded calldata. Creator signs and broadcasts the transaction.',
        afterWindowExpiry: 'Anyone can fund LINK and call startPreparedSubmission to begin oracle evaluation'
      }
    },
    feeds: {
      atom: '/feed.xml',
      text: '/api/jobs.txt'
    },
    agentGuide: '/agents.txt'
  });
});

/* ==========================
   GET /api/jobs.txt
   ========================== */

router.get('/api/jobs.txt', async (req, res) => {
  try {
    const allJobs = await jobStorage.listJobs({ includeOrphans: false });
    const base = getBaseUrl(req);
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    // Separate open vs recently closed
    const open = allJobs.filter(j => j.status === 'OPEN');
    const closed = allJobs
      .filter(j => j.status !== 'OPEN' && j.status !== 'ORPHANED')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 10);

    let lines = [];
    lines.push(`VERDIKTA BOUNTIES - ${now.toISOString()}`);
    lines.push('');

    // Open bounties
    lines.push(`OPEN BOUNTIES (${open.length})`);
    lines.push('='.repeat(40));

    if (open.length === 0) {
      lines.push('No open bounties at this time.');
    }

    for (const job of open) {
      const remainingSec = (job.submissionCloseTime || 0) - nowSec;
      const hoursLeft = remainingSec > 0 ? Math.round(remainingSec / 360) / 10 : 0;
      const deadline = job.submissionCloseTime
        ? new Date(job.submissionCloseTime * 1000).toISOString()
        : 'unknown';
      const timeLeft = hoursLeft > 0 ? `${hoursLeft}h left` : 'expired';
      const amount = job.bountyAmount != null ? `${job.bountyAmount} ETH` : 'unknown';
      const subCount = job.submissionCount || 0;

      const windowInfo = job.creatorAssessmentWindowSize > 0
        ? ` | approval window: ${job.creatorAssessmentWindowSize >= 3600 ? (job.creatorAssessmentWindowSize / 3600).toFixed(1) + 'h' : Math.round(job.creatorAssessmentWindowSize / 60) + 'm'} (creator: ${job.creatorDeterminationPayment || '?'} ETH / oracle: ${job.arbiterDeterminationPayment || '?'} ETH)`
        : '';
      lines.push(`#${job.jobId} | ${job.title || 'Untitled'} | ${amount} | deadline: ${deadline} | ${timeLeft} | ${subCount} submission${subCount !== 1 ? 's' : ''}${windowInfo}`);
      lines.push(`     Threshold: ${job.threshold || 0}% | Class: ${job.classId || 'unknown'}`);
      lines.push(`     ${base}/api/jobs/${job.jobId}`);
    }

    lines.push('');

    // Recently closed
    lines.push(`RECENTLY CLOSED (${closed.length})`);
    lines.push('='.repeat(40));

    if (closed.length === 0) {
      lines.push('None.');
    }

    for (const job of closed) {
      const subCount = job.submissionCount || 0;
      lines.push(`#${job.jobId} | ${job.title || 'Untitled'} | ${job.status} | ${subCount} submission${subCount !== 1 ? 's' : ''}`);
    }

    lines.push('');
    lines.push(`Full API docs: ${base}/api/docs`);

    res.type('text/plain').send(lines.join('\n'));
  } catch (error) {
    logger.error('[agent/jobs.txt] error', { msg: error.message });
    res.status(500).type('text/plain').send('Error fetching bounties. Try GET /api/jobs for JSON format.');
  }
});

/* ==========================
   GET /feed.xml (Atom)
   ========================== */

router.get('/feed.xml', async (req, res) => {
  try {
    const allJobs = await jobStorage.listJobs({ includeOrphans: false });
    const base = getBaseUrl(req);

    // Sort by creation date descending, take latest 50
    const sorted = allJobs
      .filter(j => j.status !== 'ORPHANED')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50);

    const latestUpdate = sorted.length > 0
      ? new Date((sorted[0].createdAt || 0) * 1000).toISOString()
      : new Date().toISOString();

    const escXml = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const entries = sorted.map(job => {
      const amount = job.bountyAmount != null ? `${job.bountyAmount} ETH` : '';
      const title = amount ? `${amount}: ${job.title || 'Untitled'}` : (job.title || 'Untitled');
      const updated = new Date((job.createdAt || 0) * 1000).toISOString();
      const summary = job.description
        ? job.description.substring(0, 500)
        : `Bounty #${job.jobId} - ${job.status}`;

      return `  <entry>
    <title>${escXml(title)}</title>
    <id>bounty-${job.jobId}</id>
    <link href="${escXml(`${base}/bounty/${job.jobId}`)}"/>
    <summary>${escXml(summary)}</summary>
    <updated>${updated}</updated>
    <category term="${escXml(job.status)}"/>
  </entry>`;
    }).join('\n');

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Verdikta Bounties</title>
  <link href="${escXml(base)}/"/>
  <link rel="self" href="${escXml(base)}/feed.xml"/>
  <id>${escXml(base)}/feed.xml</id>
  <updated>${latestUpdate}</updated>
  <subtitle>AI-evaluated bounties on Base</subtitle>
${entries}
</feed>`;

    res.type('application/atom+xml').send(feed);
  } catch (error) {
    logger.error('[agent/feed.xml] error', { msg: error.message });
    res.status(500).type('text/plain').send('Error generating feed.');
  }
});

module.exports = router;
