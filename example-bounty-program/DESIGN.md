# Verdikta AI-Powered Bounty Program — Design Document

**Version:** 0.1.0 (MVP)  
**Status:** Planning Phase  
**Last Updated:** October 2, 2025

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Core Components](#core-components)
4. [Smart Contract Interface](#smart-contract-interface)
5. [Off-Chain API](#off-chain-api)
6. [Frontend Application](#frontend-application)
7. [Data Models](#data-models)
8. [Workflows](#workflows)
9. [Security & Abuse Controls](#security--abuse-controls)
10. [Development Roadmap](#development-roadmap)
11. [Future Enhancements](#future-enhancements)
12. [Technical Dependencies](#technical-dependencies)

---

## Executive Summary

### Purpose

The Verdikta AI-Powered Bounty Program is a decentralized platform that enables trustless, automated evaluation and payment of work submissions using AI arbiters. Bounty owners lock ETH in escrow and define evaluation criteria via an IPFS-hosted rubric. Hunters submit deliverables (text, images, documents), which are automatically graded by Verdikta's AI jury system. The first submission that passes the threshold receives the ETH payout automatically.

### Key Features

- **Trustless Escrow**: ETH locked on-chain until passing submission or cancellation
- **AI-Powered Evaluation**: Verdikta's multi-arbiter system grades submissions against rubric
- **IPFS Storage**: Immutable storage for rubrics and deliverables
- **First-Past-Post**: Simple payout model — first passing submission wins
- **Public Transparency**: All bounties, submissions, and results are publicly accessible
- **Spam Prevention**: LINK fees per submission deter frivolous attempts

### Non-Goals (MVP Scope)

- ❌ Multiple winners per bounty
- ❌ Appeals or dispute resolution
- ❌ Platform fees or revenue sharing
- ❌ Encrypted/private submissions
- ❌ Stablecoin payments (ETH only)
- ❌ Licensing automation beyond templates
- ❌ Hunter reputation system

---

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │  Bounty Creation │              │   Submission &   │         │
│  │     Interface    │              │  Result Viewing  │         │
│  └──────────────────┘              └──────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Backend API (Express.js)                     │
│  • IPFS Upload/Fetch (via Pinata)                              │
│  • File Validation & Processing                                │
│  • Bounty Metadata Management                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ↓                               ↓
┌─────────────────────────┐   ┌─────────────────────────────┐
│  BountyEscrow Contract  │   │    Verdikta Aggregator      │
│  (Base Sepolia/Base)    │   │  (Existing AI Evaluation)   │
│                         │   │                             │
│  • Create Bounty        │←──→  • Request Evaluation      │
│  • Submit & Evaluate    │   │  • Return AI Scores        │
│  • Payout Winner        │   │  • Store Justification     │
│  • Cancel Bounty        │   │                             │
└─────────────────────────┘   └─────────────────────────────┘
            ↓                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                        IPFS Network                             │
│  • Rubric JSON Storage                                          │
│  • Deliverable Storage (text, images, PDFs, DOCX)              │
│  • AI Justification Reports                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer          | Technology                                  |
|----------------|---------------------------------------------|
| **Blockchain** | Base Sepolia (testnet), Base (mainnet)     |
| **Oracle**     | Verdikta Aggregator + Chainlink Functions   |
| **Frontend**   | React 18, Ethers.js v6, React Router       |
| **Backend**    | Node.js 20, Express 4, @verdikta/common    |
| **Storage**    | IPFS (via Pinata or similar)               |
| **Tokens**     | ETH (bounty payouts), LINK (evaluation fees)|

---

## Core Components

### 1. BountyEscrow Smart Contract

**Purpose**: Manages bounty lifecycle, holds ETH in escrow, coordinates with Verdikta, and distributes payouts.

**Key Responsibilities**:
- Accept ETH deposits and lock them per bounty
- Store bounty metadata (rubric CID, payout amount, creator, creation time)
- Enforce 24-hour cancellation lockout period
- Submit evaluation requests to Verdikta Aggregator
- Process Verdikta's pass/fail results
- Automatically pay winner or allow cancellation/refunds
- Track bounty state (Open, Evaluating, Paid, Cancelled, Failed)

**State Variables** (conceptual):
```solidity
struct Bounty {
    address creator;
    uint256 payoutAmount;      // Wei
    string rubricCid;          // IPFS CID
    uint256 createdAt;         // Timestamp
    BountyStatus status;       // Open, Evaluating, Paid, Cancelled
    uint256 cancelLockUntil;   // Timestamp (createdAt + 24 hours)
}

struct Submission {
    uint256 bountyId;
    address hunter;
    string deliverableCid;     // IPFS CID
    bytes32 verdiktaRequestId; // Verdikta's request ID
    uint256 submittedAt;       // Timestamp
    SubmissionStatus status;   // Pending, Evaluating, Passed, Failed
    uint8 score;               // 0-100 from Verdikta
    string reportCid;          // Verdikta's justification CID
}

enum BountyStatus { Open, Evaluating, Paid, Cancelled }
enum SubmissionStatus { Pending, Evaluating, Passed, Failed, TimedOut }
```

---

### 2. Verdikta Integration

The bounty program leverages the **existing Verdikta Aggregator** contract to evaluate submissions. The workflow:

1. Hunter submits deliverable CID via `BountyEscrow.submitAndEvaluate()`
2. BountyEscrow calls `VerdiktaAggregator.requestAIEvaluationWithApproval()`
3. Hunter pays LINK fee (computed based on class ID, same as example-frontend)
4. Verdikta arbiters evaluate deliverable against rubric
5. Verdikta returns `pass/fail` decision and numeric score via callback
6. BountyEscrow automatically pays hunter if `pass`, or marks submission as `Failed`

**Key Integration Points**:
- **Class ID**: Configurable per bounty (default: 128 for frontier models)
- **LINK Allowance**: Hunter must approve BountyEscrow to spend LINK on their behalf
- **Evaluation Parameters**: Use same `alpha`, `maxFee`, `estimatedBaseCost` patterns as example-frontend
- **Timeout Handling**: Use Verdikta's 5-minute timeout mechanism; on timeout, mark submission as `TimedOut` and refund hunter

---

### 3. Off-Chain API (Node.js/Express)

**Purpose**: Provide IPFS upload/fetch, file validation, and bounty metadata aggregation.

**Endpoints**:

#### Bounty Endpoints
```
POST   /api/bounties
GET    /api/bounties
GET    /api/bounties/:bountyId
GET    /api/bounties/:bountyId/submissions
```

#### Submission Endpoints
```
POST   /api/bounties/:bountyId/submit
GET    /api/submissions/:submissionId
```

#### IPFS Endpoints (reuse from example-frontend)
```
POST   /api/upload              # Upload file to IPFS
GET    /api/fetch/:cid          # Fetch content from IPFS
```

#### Utility Endpoints
```
GET    /api/classes             # List available Verdikta classes
GET    /api/classes/:classId    # Get class details
POST   /api/rubrics/validate    # Validate rubric JSON format
```

**Key Features**:
- **File Validation**: Check file type (txt, md, jpg, png, pdf, docx) and size (≤20 MB)
- **IPFS Pinning**: Use Pinata or similar service (reuse `@verdikta/common` IPFSClient)
- **Metadata Caching**: Cache bounty/submission data from chain for faster queries
- **Error Handling**: Graceful failures with retry logic

---

### 4. Frontend Application (React)

**Purpose**: User-friendly interface for creating bounties and submitting work.

**Main Pages**:

#### 4.1 Home / Browse Bounties
- List all active bounties (filterable by status, payout amount)
- Display: Bounty title, payout amount, submission count, time remaining
- Search/filter capabilities

#### 4.2 Create Bounty
- **Step 1**: Define bounty details (title, description, payout amount)
- **Step 2**: Build rubric (criteria, weights, threshold, MUST rules)
- **Step 3**: Configure evaluation (class ID, model selection)
- **Step 4**: Review and deploy (upload rubric to IPFS, create bounty on-chain)

#### 4.3 Bounty Details
- Display rubric (fetched from IPFS)
- Show all submissions with their status and scores
- If owner: Cancel button (if past 24h lockout and no active evaluations)
- If hunter: Submit work button

#### 4.4 Submit Work
- Upload file or provide IPFS CID
- Preview deliverable
- Confirm LINK approval for evaluation fee
- Submit and track evaluation progress

#### 4.5 Results / Submission Details
- Display AI evaluation report (fetched from IPFS)
- Show pass/fail decision and score breakdown
- Display payout transaction if winner

#### 4.6 Wallet Integration
- MetaMask connection (similar to example-frontend)
- Display ETH and LINK balances
- Network switching (Base Sepolia ↔ Base)

**UI Components** (reusable):
- `BountyCard` — Compact bounty display
- `RubricBuilder` — Interactive rubric creation form
- `FileUploader` — Drag-and-drop with validation
- `EvaluationProgress` — Real-time status tracker
- `ScoreDisplay` — Visual score breakdown (Chart.js)

---

## Smart Contract Interface

### BountyEscrow.sol (API)

```solidity
// ============================================================
//                    BOUNTY MANAGEMENT
// ============================================================

/**
 * @notice Create a new bounty with ETH escrow
 * @param rubricCid IPFS CID of the rubric JSON
 * @param classId Verdikta class ID for evaluation (default: 128)
 * @return bountyId Unique identifier for the bounty
 */
function createBounty(
    string calldata rubricCid,
    uint64 classId
) external payable returns (uint256 bountyId);

/**
 * @notice Cancel a bounty (only after 24h lockout, no active evaluations)
 * @param bountyId The bounty to cancel
 */
function cancelBounty(uint256 bountyId) external;

/**
 * @notice Get bounty details
 * @param bountyId The bounty to query
 * @return Bounty struct (creator, payout, rubricCid, status, etc.)
 */
function getBounty(uint256 bountyId) external view returns (Bounty memory);

/**
 * @notice Get all submission IDs for a bounty
 * @param bountyId The bounty to query
 * @return Array of submission IDs
 */
function getBountySubmissions(uint256 bountyId) external view returns (bytes32[] memory);

// ============================================================
//                  SUBMISSION & EVALUATION
// ============================================================

/**
 * @notice Submit work and request Verdikta evaluation
 * @param bountyId The bounty to submit to
 * @param deliverableCid IPFS CID of the submission
 * @return submissionId Unique identifier for this submission
 * @dev Hunter must have approved LINK spend for evaluation fee
 */
function submitAndEvaluate(
    uint256 bountyId,
    string calldata deliverableCid
) external returns (bytes32 submissionId);

/**
 * @notice Callback from Verdikta with evaluation result
 * @param submissionId The submission being evaluated
 * @param likelihoods Score array from Verdikta (outcome probabilities)
 * @param justificationCid IPFS CID of AI report
 * @dev Only callable by Verdikta Aggregator
 */
function fulfillEvaluation(
    bytes32 submissionId,
    uint256[] memory likelihoods,
    string memory justificationCid
) external;

/**
 * @notice Mark evaluation as timed out (after 5 min) and refund hunter
 * @param submissionId The submission that timed out
 */
function markEvaluationTimeout(bytes32 submissionId) external;

/**
 * @notice Get submission details
 * @param submissionId The submission to query
 * @return Submission struct (hunter, deliverableCid, status, score, etc.)
 */
function getSubmission(bytes32 submissionId) external view returns (Submission memory);

// ============================================================
//                        EVENTS
// ============================================================

event BountyCreated(
    uint256 indexed bountyId,
    address indexed creator,
    uint256 payoutAmount,
    string rubricCid,
    uint64 classId,
    uint256 cancelLockUntil
);

event SubmissionQueued(
    uint256 indexed bountyId,
    bytes32 indexed submissionId,
    address indexed hunter,
    string deliverableCid,
    bytes32 verdiktaRequestId
);

event EvaluationResult(
    uint256 indexed bountyId,
    bytes32 indexed submissionId,
    bool pass,
    uint8 score,
    string reportCid
);

event BountyPaid(
    uint256 indexed bountyId,
    bytes32 indexed submissionId,
    address indexed winner,
    uint256 amountWei
);

event BountyCancelled(
    uint256 indexed bountyId,
    address indexed creator,
    uint256 refundedAmount
);

event SubmissionRefunded(
    bytes32 indexed submissionId,
    address indexed hunter,
    string reason
);
```

---

## Off-Chain API

### API Specification

#### POST /api/bounties
**Description**: Create bounty metadata (upload rubric, return CID)

**Request**:
```json
{
  "rubricJson": {
    "title": "Write a technical blog post about Solidity",
    "threshold": 82,
    "criteria": [...],
    "forbidden_content": ["NSFW", "Hate speech"],
    "license_template": "exclusive-license-v1"
  },
  "classId": 128
}
```

**Response**:
```json
{
  "success": true,
  "rubricCid": "QmXxxx...",
  "message": "Rubric uploaded to IPFS. Use this CID when calling createBounty()."
}
```

---

#### GET /api/bounties
**Description**: List all bounties (with optional filters)

**Query Params**:
- `status` — Filter by BountyStatus (open, evaluating, paid, cancelled)
- `creator` — Filter by creator address
- `minPayout` — Minimum payout in ETH
- `limit`, `offset` — Pagination

**Response**:
```json
{
  "success": true,
  "bounties": [
    {
      "bountyId": 1,
      "creator": "0xabc...",
      "payoutAmount": "1000000000000000000", // Wei
      "rubricCid": "QmXxxx...",
      "rubricTitle": "Write a technical blog post",
      "status": "Open",
      "createdAt": 1698765432,
      "cancelLockUntil": 1698851832,
      "submissionCount": 3
    }
  ],
  "total": 42,
  "page": 1
}
```

---

#### GET /api/bounties/:bountyId
**Description**: Get detailed bounty info (including rubric content)

**Response**:
```json
{
  "success": true,
  "bounty": {
    "bountyId": 1,
    "creator": "0xabc...",
    "payoutAmount": "1000000000000000000",
    "rubricCid": "QmXxxx...",
    "rubric": {
      "title": "...",
      "threshold": 82,
      "criteria": [...]
    },
    "status": "Open",
    "createdAt": 1698765432,
    "cancelLockUntil": 1698851832,
    "classId": 128
  },
  "submissions": [
    {
      "submissionId": "0x123...",
      "hunter": "0xdef...",
      "deliverableCid": "QmYyyy...",
      "status": "Passed",
      "score": 86,
      "submittedAt": 1698765500
    }
  ]
}
```

---

#### POST /api/bounties/:bountyId/submit
**Description**: Upload deliverable to IPFS and return CID (for on-chain submission)

**Request**: `multipart/form-data` with file upload

**Response**:
```json
{
  "success": true,
  "deliverableCid": "QmZzzz...",
  "filename": "essay.pdf",
  "size": 1048576,
  "message": "File uploaded. Call submitAndEvaluate() with this CID."
}
```

---

#### POST /api/rubrics/validate
**Description**: Validate rubric JSON format before uploading

**Request**:
```json
{
  "rubric": {
    "threshold": 82,
    "criteria": [...]
  }
}
```

**Response**:
```json
{
  "valid": true,
  "errors": [],
  "warnings": ["Criterion 'originality' has weight 0 and must=true (will be binary check)"]
}
```

---

## Data Models

### Rubric JSON Format

The rubric defines how Verdikta AI evaluates submissions. It's stored on IPFS and referenced by CID.

**Structure**:
```json
{
  "version": "1.0",
  "title": "Technical Blog Post on Solidity",
  "description": "Write a 1000+ word blog post explaining Solidity basics for beginners.",
  "threshold": 82,
  "criteria": [
    {
      "id": "originality",
      "description": "Content must be original (not plagiarized)",
      "must": true,
      "weight": 0.0
    },
    {
      "id": "accuracy",
      "description": "Technical accuracy and correctness",
      "must": false,
      "weight": 0.3
    },
    {
      "id": "clarity",
      "description": "Clear writing suitable for beginners",
      "must": false,
      "weight": 0.2
    },
    {
      "id": "completeness",
      "description": "Covers all required topics",
      "must": false,
      "weight": 0.2
    },
    {
      "id": "overall_quality",
      "description": "Overall quality and professionalism",
      "must": false,
      "weight": 0.3
    }
  ],
  "forbidden_content": [
    "NSFW content",
    "Hate speech",
    "Copyrighted material without attribution"
  ],
  "license_template": "exclusive-license-v1",
  "deliverable_requirements": {
    "min_words": 1000,
    "max_words": 3000,
    "format": ["markdown", "pdf", "docx"]
  }
}
```

**Validation Rules**:
- `threshold`: Integer 0-100 (required)
- `criteria`: Array of 1-10 criteria (required)
  - `id`: Unique string identifier
  - `must`: Boolean (if true, failure = automatic fail regardless of score)
  - `weight`: Float 0.0-1.0 (sum of all weighted criteria should ≈ 1.0)
- `forbidden_content`: Array of strings (optional)
- `license_template`: String reference to licensing terms (optional)

---

### Verdikta Evaluation Input

When BountyEscrow calls Verdikta, it constructs a query package similar to example-frontend:

**Manifest** (embedded in ZIP uploaded to IPFS):
```json
{
  "version": "1.0",
  "primary": {
    "filename": "evaluation_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_PROVIDER": "openai",
        "AI_MODEL": "gpt-4",
        "WEIGHT": 0.5
      },
      {
        "AI_PROVIDER": "anthropic",
        "AI_MODEL": "claude-3-5-sonnet-20241022",
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  },
  "support": [
    {
      "filename": "rubric.json",
      "description": "Evaluation rubric"
    },
    {
      "filename": "deliverable.pdf",
      "description": "Hunter's submission"
    }
  ]
}
```

**Primary Query** (`evaluation_query.json`):
```json
{
  "query": "Evaluate the attached deliverable against the provided rubric. Determine if it meets the threshold score and all MUST criteria. Return outcome 0 if PASS, outcome 1 if FAIL.",
  "outcomes": [
    "PASS - Submission meets all requirements",
    "FAIL - Submission does not meet requirements"
  ],
  "references": [
    "rubric.json",
    "deliverable.pdf"
  ]
}
```

---

### Verdikta Evaluation Output

Verdikta returns:
- `likelihoods`: `[probability_pass, probability_fail]` (e.g., `[85, 15]`)
- `justificationCid`: IPFS CID pointing to detailed AI report

**AI Report Structure** (fetched from IPFS):
```json
{
  "version": "1.0",
  "timestamp": "2025-10-02T14:30:00Z",
  "result": "PASS",
  "finalScore": 86,
  "thresholdUsed": 82,
  "criteriaScores": {
    "originality": { "score": 100, "passed": true, "notes": "No plagiarism detected" },
    "accuracy": { "score": 90, "notes": "Minor technical inaccuracy in section 3" },
    "clarity": { "score": 85, "notes": "Generally well-written" },
    "completeness": { "score": 80, "notes": "Missing discussion of events" },
    "overall_quality": { "score": 88, "notes": "Professional quality" }
  },
  "forbiddenContentCheck": {
    "passed": true,
    "violations": []
  },
  "arbiters": [
    {
      "model": "gpt-4",
      "score": 87,
      "weight": 0.5
    },
    {
      "model": "claude-3-5-sonnet-20241022",
      "score": 85,
      "weight": 0.5
    }
  ],
  "justification": "The submission is a well-researched and clearly written blog post that meets the technical requirements..."
}
```

**BountyEscrow Decision Logic**:
```javascript
// Extract pass/fail from likelihoods
const passLikelihood = likelihoods[0]; // Outcome 0 = PASS
const isPassing = passLikelihood >= 50; // Majority vote

// If passing, pay hunter
if (isPassing) {
    payoutWinner(submissionId);
} else {
    markSubmissionFailed(submissionId);
}
```

---

## Workflows

### Workflow 1: Create Bounty

```
┌──────────┐
│  Owner   │
└────┬─────┘
     │
     │ 1. Navigate to "Create Bounty"
     ↓
┌─────────────────────────────────────┐
│  Frontend: Bounty Creation Form     │
│  - Title, description, payout       │
│  - Build rubric (criteria, weights) │
│  - Select class ID (default: 128)   │
└────┬────────────────────────────────┘
     │
     │ 2. Click "Create Bounty"
     ↓
┌─────────────────────────────────────┐
│  Backend: POST /api/bounties        │
│  - Validate rubric JSON             │
│  - Upload rubric to IPFS            │
│  - Return rubricCid                 │
└────┬────────────────────────────────┘
     │
     │ 3. rubricCid returned
     ↓
┌─────────────────────────────────────┐
│  Frontend: Confirm Transaction      │
│  - Show rubric preview              │
│  - Prompt MetaMask for ETH amount   │
└────┬────────────────────────────────┘
     │
     │ 4. Call createBounty(rubricCid, classId) with ETH
     ↓
┌─────────────────────────────────────┐
│  BountyEscrow Contract              │
│  - Lock ETH in escrow               │
│  - Store bounty metadata            │
│  - Set cancelLockUntil = now + 24h  │
│  - Emit BountyCreated event         │
└────┬────────────────────────────────┘
     │
     │ 5. Event emitted
     ↓
┌─────────────────────────────────────┐
│  Frontend: Success                  │
│  - Display bounty page              │
│  - Show countdown to cancellation   │
└─────────────────────────────────────┘
```

---

### Workflow 2: Submit Work

```
┌──────────┐
│  Hunter  │
└────┬─────┘
     │
     │ 1. Browse bounties, select one
     ↓
┌─────────────────────────────────────┐
│  Frontend: Bounty Details Page      │
│  - Display rubric (from IPFS)       │
│  - Show "Submit Work" button        │
└────┬────────────────────────────────┘
     │
     │ 2. Click "Submit Work"
     ↓
┌─────────────────────────────────────┐
│  Frontend: Submission Form          │
│  - Upload file or paste CID         │
│  - Show LINK fee estimate           │
│  - Preview deliverable              │
└────┬────────────────────────────────┘
     │
     │ 3a. If uploading file: POST /api/bounties/:id/submit
     ↓
┌─────────────────────────────────────┐
│  Backend: File Upload               │
│  - Validate file (type, size)       │
│  - Upload to IPFS                   │
│  - Return deliverableCid            │
└────┬────────────────────────────────┘
     │
     │ 3b. deliverableCid obtained (uploaded or provided)
     ↓
┌─────────────────────────────────────┐
│  Frontend: LINK Approval            │
│  - Calculate LINK fee (via contract)│
│  - Prompt MetaMask to approve LINK  │
└────┬────────────────────────────────┘
     │
     │ 4. LINK approved
     ↓
┌─────────────────────────────────────┐
│  Frontend: Submit Transaction       │
│  - Call submitAndEvaluate(bountyId, │
│    deliverableCid)                  │
└────┬────────────────────────────────┘
     │
     │ 5. submitAndEvaluate() called
     ↓
┌─────────────────────────────────────┐
│  BountyEscrow Contract              │
│  - Verify bounty is Open            │
│  - Build evaluation query package   │
│  - Call Verdikta Aggregator         │
│  - Emit SubmissionQueued event      │
└────┬────────────────────────────────┘
     │
     │ 6. Verdikta request sent
     ↓
┌─────────────────────────────────────┐
│  Verdikta Aggregator                │
│  - Select AI arbiters               │
│  - Fetch rubric + deliverable       │
│  - Run AI evaluation                │
│  - Return pass/fail + score         │
└────┬────────────────────────────────┘
     │
     │ 7. Evaluation complete (1-5 min)
     ↓
┌─────────────────────────────────────┐
│  BountyEscrow: fulfillEvaluation()  │
│  - Extract pass/fail decision       │
│  - If PASS: Pay hunter, emit        │
│    BountyPaid event                 │
│  - If FAIL: Emit EvaluationResult   │
└────┬────────────────────────────────┘
     │
     │ 8. Result finalized
     ↓
┌─────────────────────────────────────┐
│  Frontend: Show Results             │
│  - Fetch AI report from IPFS        │
│  - Display score breakdown          │
│  - Show payout tx if winner         │
└─────────────────────────────────────┘
```

---

### Workflow 3: Cancel Bounty

```
┌──────────┐
│  Owner   │
└────┬─────┘
     │
     │ 1. Navigate to bounty details
     ↓
┌─────────────────────────────────────┐
│  Frontend: Bounty Details           │
│  - Check: now > cancelLockUntil?    │
│  - Check: no active evaluations?    │
│  - Show "Cancel Bounty" button      │
└────┬────────────────────────────────┘
     │
     │ 2. Click "Cancel Bounty"
     ↓
┌─────────────────────────────────────┐
│  Frontend: Confirm Cancellation     │
│  - Warn about refund policy         │
│  - Prompt MetaMask                  │
└────┬────────────────────────────────┘
     │
     │ 3. Call cancelBounty(bountyId)
     ↓
┌─────────────────────────────────────┐
│  BountyEscrow Contract              │
│  - Verify: msg.sender == creator    │
│  - Verify: now > cancelLockUntil    │
│  - Verify: status != Evaluating     │
│  - Mark pending submissions as void │
│  - Refund ETH to creator            │
│  - Emit BountyCancelled event       │
└────┬────────────────────────────────┘
     │
     │ 4. Refund processed
     ↓
┌─────────────────────────────────────┐
│  Frontend: Cancellation Success     │
│  - Show refund transaction          │
│  - Update bounty status to Cancelled│
└─────────────────────────────────────┘
```

---

### Workflow 4: Handle Timeout

```
(If Verdikta doesn't respond within 5 minutes)

┌──────────┐
│  Hunter  │
└────┬─────┘
     │
     │ 1. Evaluation times out (no response)
     ↓
┌─────────────────────────────────────┐
│  Frontend: Show Timeout Warning     │
│  - "Evaluation timed out"           │
│  - Show "Claim Refund" button       │
└────┬────────────────────────────────┘
     │
     │ 2. Click "Claim Refund"
     ↓
┌─────────────────────────────────────┐
│  Frontend: Call Timeout Function    │
│  - Call markEvaluationTimeout(      │
│    submissionId)                    │
└────┬────────────────────────────────┘
     │
     │ 3. Timeout marked
     ↓
┌─────────────────────────────────────┐
│  BountyEscrow Contract              │
│  - Verify: 5 min elapsed            │
│  - Verify: no evaluation result     │
│  - Mark submission as TimedOut      │
│  - Refund LINK fee to hunter        │
│  - Emit SubmissionRefunded event    │
└────┬────────────────────────────────┘
     │
     │ 4. Refund processed
     ↓
┌─────────────────────────────────────┐
│  Frontend: Show Refund Success      │
│  - Hunter can resubmit if desired   │
└─────────────────────────────────────┘
```

---

## Security & Abuse Controls

### On-Chain Security

1. **Reentrancy Protection**: Use OpenZeppelin's `ReentrancyGuard` for payout functions
2. **Access Control**: Only creator can cancel bounty, only Verdikta can fulfill evaluations
3. **State Validation**: Strict state machine enforcement (e.g., can't submit to Paid bounty)
4. **Cancellation Lock**: 24-hour minimum lock period prevents instant cancellation
5. **Overflow Protection**: Use Solidity 0.8+ built-in overflow checks
6. **LINK Fee Verification**: Require hunter to approve exact amount before submission

### Off-Chain Security

1. **File Validation**: Enforce file type whitelist and 20 MB size limit
2. **Rate Limiting**: Limit API requests per IP/wallet to prevent DoS
3. **IPFS Pinning**: Ensure rubrics and deliverables are pinned to prevent data loss
4. **Input Sanitization**: Validate all user inputs (rubric JSON, CIDs, etc.)
5. **CORS Configuration**: Restrict API access to frontend origin only

### Spam Prevention

1. **LINK Fee per Submission**: Deter frivolous submissions (dynamic fee based on class)
2. **Cancellation Lock**: Prevent owners from rapidly creating/canceling bounties
3. **Gas Costs**: Inherent cost of on-chain transactions limits abuse
4. **IPFS Pinning Costs**: Off-chain storage has minimal cost but still a barrier

### Limitations (MVP Accepts These)

- ❌ **No Sybil Resistance**: Same person can create multiple wallets
- ❌ **No Reputation System**: Hunters can't build trust scores
- ❌ **No Appeals**: Once Verdikta decides, result is final
- ❌ **Public Submissions**: Anyone with CID can view deliverables
- ❌ **First-Win-Only**: No multi-winner support or partial payouts

---

## Development Roadmap

### Phase 1: Foundation (Weeks 1-2)
**Status**: 🔴 Not Started

#### Smart Contract Development
- [ ] Design BountyEscrow contract architecture
- [ ] Implement core structs (Bounty, Submission)
- [ ] Implement `createBounty()` and state management
- [ ] Implement `submitAndEvaluate()` with Verdikta integration
- [ ] Implement `fulfillEvaluation()` callback handler
- [ ] Implement `cancelBounty()` with lockout logic
- [ ] Implement `markEvaluationTimeout()` and refund logic
- [ ] Add comprehensive events
- [ ] Write unit tests (Hardhat/Foundry)
- [ ] Deploy to Base Sepolia testnet

#### Backend API Setup
- [ ] Initialize Express.js project structure
- [ ] Integrate `@verdikta/common` for IPFS
- [ ] Implement `/api/bounties` CRUD endpoints
- [ ] Implement `/api/upload` for file uploads
- [ ] Implement rubric validation logic
- [ ] Add error handling and logging
- [ ] Set up environment configuration
- [ ] Add health check endpoints

---

### Phase 2: Frontend MVP (Weeks 3-4)
**Status**: 🔴 Not Started

#### Core UI Components
- [ ] Set up React 18 + React Router project
- [ ] Create wallet connection component (MetaMask)
- [ ] Create network switching logic (Base Sepolia ↔ Base)
- [ ] Build `BountyCard` component
- [ ] Build `RubricBuilder` component
- [ ] Build `FileUploader` component
- [ ] Build `EvaluationProgress` component
- [ ] Build `ScoreDisplay` component (Chart.js)

#### Main Pages
- [ ] Home page: Browse bounties (list + filters)
- [ ] Create Bounty page: Multi-step form
- [ ] Bounty Details page: Display rubric + submissions
- [ ] Submit Work page: Upload/provide CID, LINK approval
- [ ] Results page: Show AI report, score breakdown
- [ ] Navigation header: Wallet status, network indicator

#### Integration
- [ ] Connect frontend to backend API
- [ ] Connect frontend to BountyEscrow contract (ethers.js)
- [ ] Implement event listeners for contract updates
- [ ] Add IPFS fetching for rubrics/reports
- [ ] Add loading states and error handling

---

### Phase 3: Testing & Refinement (Week 5)
**Status**: 🔴 Not Started

#### Contract Testing
- [ ] Write integration tests for full bounty lifecycle
- [ ] Test Verdikta integration (pass/fail scenarios)
- [ ] Test cancellation and timeout logic
- [ ] Test edge cases (multiple submissions, rapid cancellation)
- [ ] Gas optimization review
- [ ] Security audit (self-review + external if budget allows)

#### E2E Testing
- [ ] Test full user flow: Create → Submit → Evaluate → Payout
- [ ] Test LINK approval workflow
- [ ] Test file upload/validation
- [ ] Test timeout handling
- [ ] Cross-browser testing (Chrome, Firefox, Safari)
- [ ] Mobile responsiveness testing

#### Documentation
- [ ] Write contract documentation (NatSpec)
- [ ] Write API documentation (OpenAPI/Swagger)
- [ ] Write user guide (how to create/submit)
- [ ] Write deployment guide
- [ ] Add inline code comments

---

### Phase 4: Deployment & Launch (Week 6)
**Status**: 🔴 Not Started

#### Deployment
- [ ] Deploy contracts to Base Sepolia (testnet)
- [ ] Deploy backend API (Render, Heroku, or VPS)
- [ ] Deploy frontend (Vercel, Netlify, or IPFS)
- [ ] Set up monitoring (Sentry, LogRocket)
- [ ] Set up analytics (Mixpanel, Google Analytics)

#### Launch
- [ ] Create demo video/tutorial
- [ ] Write launch blog post
- [ ] Share on social media (Twitter, Discord)
- [ ] Onboard initial test users
- [ ] Monitor for issues and gather feedback

#### Post-Launch
- [ ] Bug fixes and hotfixes
- [ ] Performance optimization
- [ ] Collect user feedback
- [ ] Plan Phase 2 features

---

## Future Enhancements

### Phase 2 Features (Post-MVP)

#### Multi-Winner Support
- Allow multiple payouts per bounty (e.g., top 3 submissions)
- Implement proportional payouts based on score ranking
- Add "unlimited winners" mode (all passing submissions win fixed amount)

#### Encrypted Submissions
- Integrate Lit Protocol or similar for encrypted deliverables
- Owner decrypts after evaluation (blind evaluation)
- Prevents plagiarism between submissions

#### Advanced Rubrics
- Support nested criteria hierarchies
- Add conditional logic ("if criterion X fails, skip Y")
- Support custom scoring functions (not just weighted average)

#### Hunter Reputation System
- Track success rate, average score, on-time submissions
- Display reputation badges on profiles
- Reputation-based bonuses or fee discounts

#### Platform Fees & Monetization
- Add optional platform fee (e.g., 2% of bounty)
- Fee split between treasury and LINK stakers
- Premium features (featured bounties, priority evaluation)

#### Dispute Resolution
- Add appeal mechanism (submitter pays fee, re-evaluation with different arbiters)
- Owner can dispute evaluation (rare, requires justification)
- Community arbitration for edge cases

#### Stablecoin Support
- Accept bounties in USDC, DAI, USDT
- Automatic conversion at payout time
- Multi-currency support (ETH + stablecoins)

#### Licensing Automation
- Smart contract-based licensing (NFT-based IP transfer)
- Automatic royalty distribution
- Integration with Creative Commons, Arweave

#### Social Features
- Comments on bounties/submissions
- Hunter profiles with portfolio
- Bounty templates library
- Leaderboards (top hunters, top bounties)

#### Analytics Dashboard
- Owner: Track submission quality over time
- Hunter: Track earnings, success rate
- Platform: Total volume, popular categories

---

### Phase 3 Features (Long-Term)

#### Multi-Chain Support
- Deploy to Ethereum, Polygon, Arbitrum, Optimism
- Cross-chain bounty funding
- Unified frontend for all chains

#### On-Chain Governance
- DAO for platform decisions (fees, dispute resolution)
- BOUNTY token for voting/staking
- Treasury management

#### Advanced AI Features
- Custom AI model selection per bounty
- Fine-tuned models for specific domains (art, code, writing)
- AI co-creation (AI assists hunter in drafting)

#### Bounty Marketplace
- Secondary market for bounty assignments
- Hunters can bid for exclusive rights
- Team collaboration on submissions

#### Enterprise Features
- Private bounties (invite-only)
- Bulk bounty creation API
- White-label deployments
- SLA guarantees

---

## Technical Dependencies

### Smart Contracts
- **Solidity**: ^0.8.20
- **OpenZeppelin Contracts**: ^5.0.0
  - `ReentrancyGuard`, `Ownable`, `Pausable`
- **Chainlink Contracts**: ^1.0.0 (for LINK token interactions)
- **Hardhat**: ^2.19.0 (development framework)
- **Ethers.js**: ^6.0.0 (testing)

### Backend
- **Node.js**: >=18.0.0
- **Express**: ^4.18.0
- **@verdikta/common**: Latest (IPFS client, class map)
- **ethers.js**: ^6.0.0 (contract interaction)
- **multer**: ^1.4.5-lts.1 (file uploads)
- **dotenv**: ^16.0.0 (environment config)
- **node-fetch**: ^3.3.0 (IPFS gateway fetching)

### Frontend
- **React**: ^18.2.0
- **React Router**: ^6.20.0
- **ethers.js**: ^6.0.0 (wallet + contract interaction)
- **Chart.js**: ^4.4.0 + `react-chartjs-2` (score visualization)
- **JSZip**: ^3.10.0 (optional: client-side ZIP handling)
- **axios**: ^1.6.0 (API requests)
- **react-dropzone**: ^14.2.0 (file uploads)

### Infrastructure
- **IPFS**: Pinata or Infura (pinning service)
- **RPC Provider**: Alchemy, Infura, or QuickNode (Base Sepolia/Base)
- **Deployment**:
  - Backend: Render, Heroku, Fly.io, or self-hosted
  - Frontend: Vercel, Netlify, or IPFS (via Fleek)
  - Contracts: Base Sepolia (testnet), Base (mainnet)

### Development Tools
- **TypeScript**: ^5.3.0 (optional, recommended for frontend)
- **ESLint**: ^8.55.0 (code quality)
- **Prettier**: ^3.1.0 (code formatting)
- **Jest**: ^29.7.0 (backend testing)
- **React Testing Library**: ^14.1.0 (frontend testing)
- **Hardhat**: ^2.19.0 (contract testing)

---

## Appendix A: Comparison with Example-Frontend

| Aspect                  | Example-Frontend                | Bounty Program                     |
|-------------------------|---------------------------------|------------------------------------|
| **Purpose**             | AI jury for disputes/queries    | Automated bounty evaluation        |
| **User Flow**           | Define query → Select jury      | Create bounty → Submit work        |
| **Outcomes**            | Multiple outcomes (2-10)        | Binary: Pass/Fail                  |
| **Payment Direction**   | Requester pays LINK for AI      | Hunter pays LINK, wins ETH         |
| **Escrow**              | No escrow (direct payment)      | ETH locked in BountyEscrow         |
| **Evaluation Trigger**  | User initiates manually         | Automatic on submission            |
| **Result Use**          | Display to user                 | Trigger payout or rejection        |
| **Smart Contract**      | Verdikta Aggregator only        | BountyEscrow + Verdikta Aggregator |
| **IPFS Usage**          | Query package + justification   | Rubric + deliverable + report      |
| **Multi-Step Wizard**   | Yes (4 pages)                   | Yes (bounty creation)              |
| **Real-Time Polling**   | Yes (5-min timeout)             | Yes (same mechanism)               |

**Key Reusable Code**:
- IPFS upload/fetch logic (`serverUtils.js`, `IPFSClient`)
- LINK approval handling (`topUpLinkAllowance()`)
- Verdikta integration pattern (`requestAIEvaluationWithApproval()`)
- Timeout handling (`waitForFulfilOrTimeout()`)
- Network switching (`ensureCorrectNetwork()`)
- File upload UI (`FileUploader` component)

---

## Appendix B: Example Rubrics

### Example 1: Technical Writing

```json
{
  "version": "1.0",
  "title": "Solidity Smart Contract Tutorial",
  "description": "Write a beginner-friendly tutorial on writing Solidity smart contracts",
  "threshold": 80,
  "criteria": [
    {
      "id": "plagiarism_check",
      "description": "Content must be original and not plagiarized",
      "must": true,
      "weight": 0.0
    },
    {
      "id": "technical_accuracy",
      "description": "Code examples must be correct and follow best practices",
      "must": false,
      "weight": 0.35
    },
    {
      "id": "clarity",
      "description": "Clear explanations suitable for beginners",
      "must": false,
      "weight": 0.25
    },
    {
      "id": "completeness",
      "description": "Covers essential topics: variables, functions, events, testing",
      "must": false,
      "weight": 0.20
    },
    {
      "id": "presentation",
      "description": "Well-formatted with proper code blocks and structure",
      "must": false,
      "weight": 0.20
    }
  ],
  "forbidden_content": ["NSFW", "Hate speech", "Malicious code"],
  "license_template": "cc-by-4.0",
  "deliverable_requirements": {
    "min_words": 1500,
    "format": ["markdown", "pdf"],
    "code_examples": true
  }
}
```

### Example 2: Graphic Design

```json
{
  "version": "1.0",
  "title": "Logo Design for DeFi Protocol",
  "description": "Create a modern, professional logo for a DeFi lending protocol",
  "threshold": 85,
  "criteria": [
    {
      "id": "originality",
      "description": "Design must be original, not copied or heavily derivative",
      "must": true,
      "weight": 0.0
    },
    {
      "id": "brand_alignment",
      "description": "Fits DeFi/crypto aesthetic, conveys trust and innovation",
      "must": false,
      "weight": 0.30
    },
    {
      "id": "technical_quality",
      "description": "High resolution, clean lines, scalable design",
      "must": false,
      "weight": 0.25
    },
    {
      "id": "versatility",
      "description": "Works in color and monochrome, at various sizes",
      "must": false,
      "weight": 0.20
    },
    {
      "id": "creativity",
      "description": "Unique and memorable",
      "must": false,
      "weight": 0.25
    }
  ],
  "forbidden_content": ["Copyrighted logos", "NSFW imagery"],
  "license_template": "exclusive-license-v1",
  "deliverable_requirements": {
    "format": ["png", "svg"],
    "min_resolution": "1024x1024",
    "color_modes": ["full-color", "monochrome"]
  }
}
```

---

## Appendix C: Glossary

- **Arbiter**: An AI node in the Verdikta network that evaluates submissions
- **Bounty**: An on-chain escrow with defined payout and evaluation criteria
- **CID**: Content Identifier, a hash-based reference to IPFS data
- **Class ID**: Verdikta's categorization of AI model capabilities (e.g., 128 = frontier models)
- **Deliverable**: Hunter's submission (text, image, PDF, etc.)
- **Hunter**: User who submits work to claim bounty
- **LINK**: Chainlink token, used to pay for AI evaluation fees
- **Owner**: User who creates and funds a bounty
- **Rubric**: JSON document defining evaluation criteria and thresholds
- **Threshold**: Minimum score (0-100) required for a submission to pass
- **Verdikta Aggregator**: Smart contract that coordinates AI evaluations

---

## Version History

| Version | Date       | Changes                                      |
|---------|------------|----------------------------------------------|
| 0.1.0   | 2025-10-02 | Initial design document created              |

---

## Maintainers

- **Design Lead**: TBD
- **Smart Contract Dev**: TBD
- **Backend Dev**: TBD
- **Frontend Dev**: TBD

---

**End of Design Document**

