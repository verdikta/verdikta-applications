# Quick Start Guide

**Phase 1 Foundation Setup** - Last Updated: October 2, 2025

## What's Been Created

We've set up the foundational structure for the Verdikta AI-Powered Bounty Program:

### ✅ Smart Contracts (Interfaces Complete)
- **BountyEscrow.sol** - Main contract with complete interface and TODOs
- **IVerdiktaAggregator.sol** - Interface for Verdikta integration
- **Hardhat project** - Configured for Base Sepolia and Base Mainnet
- **Test structure** - Scaffolded with comprehensive test cases

### ✅ Backend API (Structure Complete)
- **Express server** - With routing, logging, and error handling
- **Bounty routes** - Scaffolded with implementation TODOs
- **Submission routes** - File upload configured with multer
- **IPFS routes** - Validation complete, upload/fetch pending
- **Utilities** - Logger and validation helpers ready

### ✅ Documentation
- **DESIGN.md** - Complete 8500+ word design document
- **STATUS.md** - Progress tracking with detailed checklists
- **READMEs** - For contracts and server with clear instructions

## Current Status: 40% Complete

**Smart Contracts:** 50% (Interface ✅, Implementation ⏳)
**Backend API:** 30% (Structure ✅, Logic ⏳)

## Getting Started

### Option 1: Continue Smart Contract Implementation

```bash
cd contracts
npm install
```

**Next Steps:**
1. Open `contracts/BountyEscrow.sol`
2. Find the `// TODO` comments
3. Start with `createBounty()` function
4. Implement logic, then write tests

**Key TODOs:**
- Implement `createBounty()` - Accept ETH, store bounty data
- Implement `submitAndEvaluate()` - Call Verdikta Aggregator
- Implement `fulfillEvaluation()` - Process AI results, pay winner
- Implement `cancelBounty()` - Refund with lockout check
- Write tests in `test/BountyEscrow.test.js`

### Option 2: Continue Backend API Implementation

```bash
cd server
npm install
```

**Next Steps:**
1. Open `server/routes/bountyRoutes.js`
2. Find the `// TODO` comments in each route
3. Implement IPFS upload logic first (easiest)
4. Then add blockchain queries with ethers.js

**Key TODOs:**
- Implement rubric upload to IPFS (POST /api/bounties)
- Implement deliverable upload (POST /api/bounties/:id/submit)
- Implement IPFS fetching (GET /api/fetch/:cid)
- Add contract queries (GET /api/bounties)
- Write tests

### Option 3: Review and Understand

```bash
# Read the design document
cat DESIGN.md

# Check progress
cat STATUS.md

# Explore smart contract interface
cat contracts/contracts/BountyEscrow.sol

# Explore API structure
cat server/server.js
cat server/routes/bountyRoutes.js
```

## Implementation Priority

### Week 1: Core Functionality
1. **Smart Contract**: Implement `createBounty()` and `getBounty()`
2. **Backend**: Implement IPFS upload for rubrics
3. **Test**: Write basic tests for bounty creation

### Week 2: Full Lifecycle
1. **Smart Contract**: Implement submission and evaluation flow
2. **Backend**: Implement all routes
3. **Test**: Integration tests for full bounty lifecycle

## File Structure Overview

```
example-bounty-program/
├── DESIGN.md                    # Complete design document
├── STATUS.md                    # Progress tracking
├── README.md                    # Project overview
├── QUICKSTART.md               # This file
│
├── contracts/                   # Smart contracts
│   ├── contracts/
│   │   ├── BountyEscrow.sol    # Main contract (interface complete)
│   │   └── interfaces/
│   │       └── IVerdiktaAggregator.sol
│   ├── test/
│   │   └── BountyEscrow.test.js # Test scaffolds
│   ├── scripts/
│   │   └── deploy.js            # Deployment script
│   └── hardhat.config.js
│
├── server/                      # Backend API
│   ├── server.js               # Main Express app
│   ├── routes/                 # API routes (scaffolded)
│   │   ├── bountyRoutes.js
│   │   ├── submissionRoutes.js
│   │   └── ipfsRoutes.js
│   ├── utils/                  # Utilities (complete)
│   │   ├── logger.js
│   │   └── validation.js
│   ├── tmp/                    # Temp uploads
│   └── data/                   # Optional caching
│
└── client/                      # Frontend (not started)
    └── (planned for Phase 2)
```

## Key Concepts to Understand

Before implementing, make sure you understand:

1. **Bounty Lifecycle**
   - Created → Open → Evaluating → Paid/Cancelled
   - 24-hour cancellation lock
   - First-past-post (single winner)

2. **Verdikta Integration**
   - Rubric + deliverable sent to Verdikta
   - AI arbiters evaluate and return pass/fail
   - Contract automatically pays on pass

3. **IPFS Storage**
   - Rubrics stored on IPFS (immutable)
   - Deliverables stored on IPFS
   - AI reports stored on IPFS
   - Only CIDs stored on-chain

4. **LINK Fees**
   - Hunter pays LINK for each evaluation
   - Fee calculated based on class ID
   - Contract must be approved to spend LINK

## Common Commands

### Smart Contracts
```bash
cd contracts

# Install dependencies
npm install

# Compile contracts
npm run compile

# Run tests
npm test

# Deploy to testnet (after implementation)
npm run deploy:sepolia
```

### Backend API
```bash
cd server

# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Run tests
npm test
```

## Environment Setup

### Contracts (.env)
```bash
cd contracts
cp env.example .env
# Edit .env with your keys
```

Required:
- `PRIVATE_KEY` - Deployer wallet
- `VERDIKTA_AGGREGATOR_ADDRESS` - Deployed Verdikta contract
- `LINK_TOKEN_ADDRESS` - LINK token (use provided defaults)

### Server (.env)
```bash
cd server
cp env.example .env
# Edit .env with your keys
```

Required:
- `IPFS_PINNING_KEY` - Pinata JWT token
- `BOUNTY_ESCROW_ADDRESS` - Deployed contract (after deployment)

## Next Steps

1. **Choose your focus**: Smart contracts or backend API
2. **Set up environment**: Copy env.example files
3. **Start implementing**: Find TODOs in the code
4. **Test as you go**: Write tests alongside implementation
5. **Update STATUS.md**: Mark items complete as you finish

## Getting Help

- **Design Questions**: See DESIGN.md
- **Implementation Examples**: See example-frontend/ directory
- **Verdikta Integration**: See docs/user-guide.md
- **Progress Tracking**: See STATUS.md

## Phase 1 Goals

By the end of Phase 1, we should have:
- ✅ Functional BountyEscrow contract deployed to testnet
- ✅ Backend API with IPFS upload/fetch working
- ✅ Contract interaction via ethers.js
- ✅ Basic test coverage (>60%)

Then we move to Phase 2: Frontend development!

---

**Ready to code?** Pick a TODO and start implementing! 🚀

