# Verdikta AI-Powered Bounty Program - Project Overview

**Version:** 0.1.0 (MVP)  
**Status:** 92% Complete - Ready for Contract Integration  
**Last Updated:** October 14, 2025

---

## Executive Summary

The Verdikta AI-Powered Bounty Program is a **decentralized platform for trustless, AI-evaluated work submissions**. Bounty owners lock ETH in escrow with evaluation criteria, hunters submit deliverables, and Verdikta's AI jury automatically evaluates and pays winners. The first submission passing the threshold wins automatically.

**Current State:** Frontend, backend, and all IPFS functionality complete. Awaiting smart contract implementation and integration.

---

## System Architecture

### High-Level Flow

```
┌─────────────┐
│   Bounty    │  1. Creates bounty + locks ETH + uploads rubric to IPFS
│    Owner    │────────────────┐
└─────────────┘                │
                               ↓
                    ┌──────────────────────┐
                    │  BountyEscrow        │
                    │  Smart Contract      │ ← ETH locked here
                    │  (Base Sepolia)      │
┌─────────────┐    └──────────────────────┘
│   Hunter    │               │                    ┌──────────────────┐
│             │ 2. Submits    │ 3. Requests       │    Verdikta      │
│             │    work CID   │    evaluation     │   Aggregator     │
└─────────────┘    + LINK fee │──────────────────→│                  │
                               │                   │  AI Arbiters     │
                               │ 4. Returns result │  evaluate work   │
                               │←──────────────────│                  │
                               │                   └──────────────────┘
                               ↓
                    5. Auto-pays winner if PASS
```

### Technology Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8+, OpenZeppelin, Base Sepolia/Base Mainnet |
| **Oracle** | Verdikta Aggregator + Chainlink Functions |
| **Frontend** | React 18, Vite, Ethers.js v6, React Router v6 |
| **Backend** | Node.js, Express, @verdikta/common |
| **Storage** | IPFS (Pinata) for rubrics, deliverables, AI reports |
| **Tokens** | ETH (bounty payouts), LINK (AI evaluation fees) |

---

## Core Components

### 1. Smart Contract: BountyEscrow.sol

**Status:** ⏳ Interface complete, implementation pending

**Purpose:** Manages bounty lifecycle, holds ETH in escrow, coordinates with Verdikta, distributes payouts.

**Key Functions:**
- `createBounty(rubricCid, classId)` → Locks ETH, stores rubric CID
- `submitAndEvaluate(bountyId, deliverableCid)` → Hunter submits, pays LINK, requests AI evaluation
- `fulfillEvaluation(submissionId, likelihoods, justificationCid)` → Verdikta callback, auto-pays if pass
- `cancelBounty(bountyId)` → Refunds creator (24h lockout + no active evaluations)

**Key State:**
```solidity
struct Bounty {
    address creator;
    uint256 payoutAmount;
    string rubricCid;          // IPFS CID
    uint64 classId;            // Verdikta AI class
    BountyStatus status;       // Open, Evaluating, Paid, Cancelled
    uint256 createdAt;
    uint256 cancelLockUntil;   // createdAt + 24 hours
}

struct Submission {
    uint256 bountyId;
    address hunter;
    string deliverableCid;     // IPFS CID
    bytes32 verdiktaRequestId;
    SubmissionStatus status;   // Pending, Evaluating, Passed, Failed, TimedOut
    uint8 score;               // 0-100
    string reportCid;          // AI justification CID
    uint256 submittedAt;
}
```

---

### 2. Backend API (Express.js)

**Status:** ✅ 95% Complete (IPFS fully functional)

**Base URL:** `http://localhost:5005` (dev)

**Working Endpoints:**

| Method | Endpoint | Purpose | Status |
|--------|----------|---------|--------|
| POST | `/api/bounties` | Upload rubric to IPFS | ✅ Working |
| POST | `/api/bounties/:id/submit` | Upload deliverable to IPFS | ✅ Working |
| GET | `/api/fetch/:cid` | Fetch content from IPFS | ✅ Working |
| POST | `/api/rubrics/validate` | Validate rubric structure | ✅ Working |
| GET | `/api/classes` | List Verdikta AI classes | ✅ Working |
| GET | `/api/classes/:classId` | Get class details | ✅ Working |
| GET | `/api/classes/:classId/models` | Get available models | ✅ Working |
| GET | `/health` | Health check | ✅ Working |

**Pending (needs contracts):**
- `GET /api/bounties` - List bounties from blockchain
- `GET /api/bounties/:id` - Get bounty details + rubric
- `GET /api/bounties/:id/submissions` - List submissions

**Key Features:**
- IPFS integration via `@verdikta/common`
- File validation (type: txt, md, jpg, png, pdf, docx | size: ≤20 MB)
- Rubric validation (threshold 0-100, criteria 1-10, weight sum = 1.0)
- Comprehensive logging and error handling

---

### 3. Frontend (React + Vite)

**Status:** ✅ 95% Complete (all UI functional)

**URL:** `http://localhost:5173` (dev)

**Pages:**
- `/` - Home page with navigation
- `/create` - Create Bounty with rubric builder ✅
- `/bounty/:id` - Bounty details (structure ready)
- `/bounty/:id/submit` - Submit work (structure ready)

**Key Features:**

#### Wallet Integration ✅
- MetaMask connection
- Network switching (Base Sepolia ↔ Base)
- Account change handling
- Balance display

#### Rubric Template System ✅
- 6 predefined professional templates:
  - 📝 Blog Post
  - 💻 Code Review
  - 📚 Technical Documentation
  - 🎨 Design Work
  - 🎥 Video Content
  - 📋 General Submission
- CriterionEditor component (expand/collapse, must-pass vs scored, weight sliders)
- localStorage-based personal library (wallet-scoped)
- RubricLibrary modal (load/delete saved rubrics)
- Real-time weight validation

#### AI Jury Configuration ✅
- ClassSelector component (visual class cards)
- Dynamic model loading per class
- Jury composition table (add/remove models)
- Configure: provider, model, runs, weight, iterations
- Real-time jury summary (total models, evaluations)

#### Form Validation ✅
- All required fields validated
- Weight sum must = 1.00 (±0.01 tolerance)
- At least 1 criterion required
- Wallet connection required

---

## Data Models

### Rubric JSON Structure

Stored on IPFS, referenced by CID in smart contract:

```json
{
  "version": "rubric-1",
  "title": "Technical Blog Post on Solidity",
  "criteria": [
    {
      "id": "safety_and_rights",
      "label": "Forbidden content & rights",
      "must": true,
      "weight": 0.0,
      "instructions": "Reject if NSFW, hate speech, or copyright infringement"
    },
    {
      "id": "technical_accuracy",
      "label": "Technical accuracy",
      "must": false,
      "weight": 0.30,
      "instructions": "Code examples must be correct and follow best practices"
    },
    {
      "id": "clarity",
      "label": "Clarity",
      "must": false,
      "weight": 0.25,
      "instructions": "Clear explanations suitable for beginners"
    }
    // ... more criteria (up to 10 total)
  ],
  "forbiddenContent": [
    "NSFW/sexual content",
    "Hate speech or harassment",
    "Copyrighted material without permission"
  ],
  "jury": [
    {
      "provider": "openai",
      "model": "gpt-4",
      "runs": 1,
      "weight": 1.0
    },
    {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "runs": 1,
      "weight": 0.8
    }
  ],
  "iterations": 1
}
```

**Important Note on Threshold:**
The threshold value (0-100) is **not included in the rubric JSON sent to AI nodes**. It's stored separately in the smart contract and used to determine pass/fail funding decisions after AI evaluation. The AI nodes only see the criteria and evaluation instructions.

**Validation Rules:**
- `criteria`: 1-10 items (required)
- Must-pass criteria have `weight: 0.0`
- Scored criteria weights must sum to 1.00 (±0.01)
- `jury`: At least 1 model (required)
- `threshold` (separate): 0-100, stored on-chain in bounty struct

---

### Verdikta Evaluation Flow

**Input to Verdikta:**
1. Frontend uploads rubric → IPFS CID
2. Hunter uploads deliverable → IPFS CID
3. Contract calls `VerdiktaAggregator.requestAIEvaluationWithApproval()`
4. Verdikta fetches both CIDs from IPFS
5. AI arbiters evaluate deliverable against rubric

**Output from Verdikta:**
```json
{
  "likelihoods": [85, 15],  // [PASS probability, FAIL probability]
  "justificationCid": "QmXxx..."  // Points to detailed AI report
}
```

**AI Report Structure (fetched from IPFS):**
```json
{
  "version": "1.0",
  "result": "PASS",
  "finalScore": 86,
  "criteriaScores": {
    "safety_and_rights": { "score": 100, "passed": true, "notes": "No violations" },
    "technical_accuracy": { "score": 90, "notes": "Minor inaccuracy in section 3" },
    "clarity": { "score": 85, "notes": "Generally well-written" }
  },
  "forbiddenContentCheck": { "passed": true, "violations": [] },
  "arbiters": [
    { "model": "gpt-4", "score": 87, "weight": 1.0 },
    { "model": "claude-3-5-sonnet-20241022", "score": 85, "weight": 0.8 }
  ],
  "justification": "The submission is well-researched and clearly written..."
}
```

**Decision Logic (Smart Contract):**
```solidity
// Smart contract receives AI score and compares to stored threshold
function fulfillEvaluation(bytes32 submissionId, uint8 aiScore, string calldata reportCid) {
    Submission storage submission = submissions[submissionId];
    Bounty storage bounty = bounties[submission.bountyId];
    
    submission.score = aiScore;
    submission.reportCid = reportCid;
    
    // Compare AI score to threshold stored on-chain
    if (aiScore >= bounty.threshold) {
        payoutWinner(submissionId);
    } else {
        submission.status = SubmissionStatus.Failed;
    }
}
```

---

## Key Workflows

### Workflow 1: Create Bounty

1. **Owner connects wallet** (MetaMask)
2. **Fills bounty details:**
   - Title, description, payout amount (ETH)
3. **Builds rubric:**
   - Select template or create from scratch
   - Edit criteria (must-pass vs scored, weights)
   - Set threshold (0-100)
4. **Configures AI jury:**
   - Select AI class (e.g., 128 = Frontier Models)
   - Add models (OpenAI GPT-4, Anthropic Claude, etc.)
   - Set runs and weights per model
5. **Saves rubric (optional):**
   - Uploads to IPFS → Get CID
   - Saves to localStorage for reuse
6. **Creates bounty on-chain:**
   - Frontend calls `createBounty(rubricCid, classId)` with ETH value
   - Contract locks ETH, stores metadata, emits `BountyCreated` event

### Workflow 2: Submit Work

1. **Hunter connects wallet**
2. **Browses bounties** (views rubric from IPFS)
3. **Prepares deliverable** (essay, image, PDF, etc.)
4. **Uploads to IPFS:**
   - Frontend uploads file via backend API → Get CID
5. **Approves LINK spend:**
   - Calculate fee: `contract.calculateFee(classId)`
   - Approve: `LINK.approve(BountyEscrow, fee)`
6. **Submits on-chain:**
   - `submitAndEvaluate(bountyId, deliverableCid)`
   - Contract deducts LINK, calls Verdikta
7. **Waits for evaluation** (1-5 minutes)
8. **Verdikta callback:**
   - `fulfillEvaluation()` called with result
   - If PASS → ETH transferred to hunter automatically
   - If FAIL → Submission marked failed

### Workflow 3: Cancel Bounty

1. **Owner waits 24 hours** after creation
2. **Ensures no active evaluations** in progress
3. **Calls `cancelBounty(bountyId)`**
4. **Contract refunds ETH** to creator

---

## Security & Business Logic

### On-Chain Protections

- **Reentrancy Guard:** OpenZeppelin's `ReentrancyGuard` on payout functions
- **Access Control:** Only creator can cancel, only Verdikta can fulfill
- **State Machine:** Strict status transitions (Open → Evaluating → Paid/Cancelled)
- **24-Hour Lock:** Prevents instant cancellation after creation
- **LINK Fee:** Prevents spam submissions (hunter must pay per evaluation)
- **First-Past-Post:** First passing submission wins, bounty closes

### Off-Chain Validations

- **File Type Whitelist:** txt, md, jpg, png, pdf, docx only
- **File Size Limit:** 20 MB maximum
- **Rubric Validation:** Criteria 1-10, threshold 0-100, weights sum to 1.0
- **CID Format:** Validates IPFS CID format
- **Rate Limiting:** Backend can add rate limits per IP/wallet

### Timeout Handling

- **Evaluation Timeout:** 5 minutes
- **If Verdikta doesn't respond:**
  - Hunter calls `markEvaluationTimeout(submissionId)`
  - LINK fee refunded
  - Hunter can resubmit

---

## MVP Scope

### ✅ In Scope

- Binary outcomes (Pass/Fail only)
- ETH payouts (Base Sepolia/Base)
- First-past-post (single winner)
- Public submissions (IPFS)
- Text, images, PDFs, DOCX (≤20 MB)
- LINK fees per submission
- 24-hour cancellation lockout
- Rubric templates and personal library
- AI jury configuration
- Wallet integration (MetaMask)

### ❌ Out of Scope (Future)

- Multiple winners per bounty
- Appeals or dispute resolution
- Platform fees
- Encrypted/private submissions
- Stablecoin payments (USDC, DAI)
- Hunter reputation system
- Licensing automation
- Cross-chain support
- DAO governance

---

## Project Structure

```
example-bounty-program/
├── contracts/                       # Smart contract interfaces (implementation pending)
│   ├── contracts/
│   │   ├── BountyEscrow.sol        # Main contract interface
│   │   └── interfaces/
│   │       └── IVerdiktaAggregator.sol
│   ├── test/
│   │   └── BountyEscrow.test.js    # Test scaffolds
│   ├── deploy/
│   │   └── 01_deploy_bounty.js
│   └── hardhat.config.js
│
├── server/                          # Backend API (95% complete)
│   ├── routes/
│   │   ├── bountyRoutes.js         # Rubric upload ✅
│   │   ├── submissionRoutes.js     # File upload ✅
│   │   └── ipfsRoutes.js           # Fetch & validation ✅
│   ├── utils/
│   │   ├── logger.js               # Logging ✅
│   │   └── validation.js           # Input validation ✅
│   ├── test/
│   │   ├── ipfs.test.js
│   │   └── manual-tests.md
│   └── server.js                   # Main Express app
│
├── client/                          # Frontend (95% complete)
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.jsx          # Wallet connection ✅
│   │   │   ├── ClassSelector.jsx   # AI class selection ✅
│   │   │   ├── CriterionEditor.jsx # Rubric criteria editing ✅
│   │   │   └── RubricLibrary.jsx   # Saved rubrics library ✅
│   │   ├── pages/
│   │   │   ├── Home.jsx            # Landing page ✅
│   │   │   ├── CreateBounty.jsx    # Bounty creation ✅
│   │   │   ├── BountyDetails.jsx   # Structure ready
│   │   │   └── SubmitWork.jsx      # Structure ready
│   │   ├── services/
│   │   │   ├── api.js              # Backend API calls ✅
│   │   │   ├── wallet.js           # MetaMask integration ✅
│   │   │   ├── classMapService.js  # Class data ✅
│   │   │   ├── modelProviderService.js  # Model data ✅
│   │   │   └── rubricStorage.js    # localStorage library ✅
│   │   ├── data/
│   │   │   └── rubricTemplates.js  # 6 templates ✅
│   │   └── App.jsx
│   └── package.json
│
└── docs/                            # Documentation
    ├── PROJECT-OVERVIEW.md          # This file
    ├── CURRENT-STATE.md             # Status & getting started
    ├── DESIGN.md                    # Full architecture (1400 lines)
    └── *-IMPLEMENTATION-SUMMARY.md  # Feature details
```

---

## Integration Points

### With Verdikta Protocol

- **Class IDs:** Map to Verdikta's on-chain class registry
- **Model Names:** Must match Verdikta's supported models
- **Jury Format:** Follows Verdikta manifest structure
- **Evaluation Request:** Uses `VerdiktaAggregator.requestAIEvaluationWithApproval()`
- **Callback:** Contract implements `fulfillEvaluation()`

### With IPFS

- **Rubric Upload:** Frontend → Backend API → Pinata → CID
- **Deliverable Upload:** Same flow
- **Content Fetch:** Backend API → IPFS gateway → Content
- **Immutability:** CIDs ensure content can't be changed

### With Smart Contracts

- **Rubric CID:** Stored in `Bounty.rubricCid`
- **Class ID:** Stored in `Bounty.classId` for fee calculation
- **Deliverable CID:** Stored in `Submission.deliverableCid`
- **AI Report CID:** Stored in `Submission.reportCid` after evaluation

---

## Development Phases

### Phase 0: Planning ✅ (100%)
- ✅ Design document (1400+ lines)
- ✅ Architecture planning
- ✅ Requirements gathering

### Phase 1: Backend ✅ (95%)
- ✅ Express server + IPFS integration
- ✅ All file upload/fetch endpoints
- ✅ Validation utilities
- ⏳ Contract query endpoints (pending deployment)

### Phase 2: Frontend ✅ (95%)
- ✅ React 18 + Vite + React Router
- ✅ Wallet integration (MetaMask)
- ✅ All UI pages and components
- ✅ Rubric template system
- ✅ AI jury configuration
- ⏳ Contract interaction (pending deployment)

### Phase 3: Smart Contracts ⏳ (50%)
- ✅ Interface complete (BountyEscrow.sol)
- ✅ Hardhat configuration
- ⏳ Implementation (in progress)
- ⏳ Testing
- ⏳ Deployment

### Phase 4: Integration ⏳ (0%)
- ⏳ Connect frontend to contracts
- ⏳ Add contract services (ethers.js)
- ⏳ Event listeners
- ⏳ End-to-end testing

### Phase 5: Deployment ⏳ (0%)
- ⏳ Deploy contracts to Base Sepolia
- ⏳ Deploy backend to hosting
- ⏳ Deploy frontend to hosting
- ⏳ Production testing

---

## Key Metrics

**Code Statistics:**
- Total Files: 60+
- Frontend Components: 8
- Backend Routes: 3
- Services: 5
- Smart Contract Interfaces: 2
- Rubric Templates: 6
- Total Lines: ~8,000+

**Test Coverage:**
- Backend: 8/8 passing (IPFS tests)
- Frontend: ~90% manual testing complete
- Smart Contracts: Pending implementation

**Performance:**
- IPFS Upload: 2-4 seconds
- IPFS Fetch: 1-3 seconds
- localStorage Operations: < 30ms
- UI Interactions: < 100ms

---

## External Dependencies

### Required Services

1. **Pinata (IPFS):** JWT token for file pinning
2. **Alchemy/Infura:** RPC endpoint for Base Sepolia
3. **MetaMask:** Browser wallet extension
4. **Verdikta Aggregator:** Deployed contract address

### Required Tokens

1. **Test ETH:** For gas fees (Base Sepolia faucet)
2. **Test LINK:** For AI evaluation fees
3. **Wallet:** With private key for deployment

### Environment Variables

**Backend (.env):**
```bash
PORT=5005
IPFS_PINNING_KEY=your_pinata_jwt
BOUNTY_ESCROW_ADDRESS=0x...  # After deployment
RPC_URL=https://base-sepolia.g.alchemy.com/v2/...
```

**Frontend (.env):**
```bash
VITE_API_URL=http://localhost:5005
VITE_BOUNTY_ESCROW_ADDRESS=0x...  # After deployment
```

**Contracts (.env):**
```bash
PRIVATE_KEY=your_deployer_private_key
VERDIKTA_AGGREGATOR_ADDRESS=0x...
LINK_TOKEN_ADDRESS=0x...  # Base Sepolia LINK
RPC_URL=https://base-sepolia.g.alchemy.com/v2/...
BASESCAN_API_KEY=your_api_key  # For verification
```

---

## Glossary

- **Bounty:** On-chain escrow with ETH, rubric CID, and evaluation criteria
- **Hunter:** User who submits work to claim bounty
- **Rubric:** JSON document defining evaluation criteria and thresholds (stored on IPFS)
- **CID:** Content Identifier, IPFS hash reference
- **Threshold:** Minimum score (0-100) required to pass
- **Must-Pass Criterion:** Binary check, failure = automatic fail (weight 0.0)
- **Scored Criterion:** Contributes to final score (weight 0.1-1.0)
- **Jury:** Set of AI models that evaluate submissions
- **Class ID:** Verdikta's categorization of AI model capabilities (e.g., 128 = frontier models)
- **Iteration:** Number of times the entire jury evaluates (for consistency)
- **Runs:** Number of times a specific model evaluates per iteration

---

## Next Steps for AI Agent

To contribute to this project, an AI agent should:

1. **Read:** `CURRENT-STATE.md` for implementation status and setup instructions
2. **Review:** Smart contract interface in `contracts/contracts/BountyEscrow.sol`
3. **Understand:** Data flow: Frontend → Backend → IPFS → Smart Contract → Verdikta → Callback
4. **Focus Area:** Contract implementation is the critical path
5. **Test:** Follow `TEST-AND-RUN.md` to verify existing functionality

**Primary Task:** Implement the logic within `BountyEscrow.sol` functions marked with `// TODO` comments, following the patterns from `example-frontend` for Verdikta integration.

---

**Document Version:** 1.0  
**Last Updated:** October 14, 2025

