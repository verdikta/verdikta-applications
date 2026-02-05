# Verdikta AI-Powered Bounty Program

**Status:** 🟢 Production Ready (Smart Contracts Deployed)  
**Version:** 0.3.0 (MVP + Receipts)

## Overview

The Verdikta AI-Powered Bounty Program is a fully decentralized platform that enables trustless, automated evaluation and payment of work submissions using AI arbiters. Bounty owners create jobs with ETH payouts and IPFS-hosted evaluation rubrics, hunters submit deliverables, and Verdikta's AI jury automatically grades submissions. The first passing submission wins the bounty—no appeals, no manual review needed.

**Current Status:** Fully functional end-to-end system with deployed smart contracts on Base Sepolia (testnet) and Base (mainnet). Create bounties with ETH escrow, submit work with LINK fees, get AI evaluation in under 2 minutes, and receive automatic on-chain payment. Winners get shareable receipt pages with social media unfurling.

## Quick Links

### 🎯 Essential Documents (Start Here)
- **[📋 PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)** — Architecture, concepts, and data models
- **[⚙️ CURRENT-STATE.md](CURRENT-STATE.md)** — What's complete, how to get started, contribution guide
- **[👨‍💻 DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Quick reference for commands, APIs, and patterns

### 📚 Additional Resources
- **[📖 DESIGN.md](DESIGN.md)** — Complete technical specification (1400+ lines)
- **[🏗️ Example Frontend](../example-frontend/)** — Reference implementation showing Verdikta integration patterns
- **[📚 Verdikta User Guide](../docs/user-guide.md)** — Understanding Verdikta's AI evaluation system

## Key Concepts

### For Bounty Owners
1. **Create Bounty**: Define work requirements via a rubric JSON (criteria, weights, threshold)
2. **Lock ETH**: Deposit payout amount on-chain in escrow
3. **Wait**: Hunters submit work, AI evaluates automatically
4. **Winner Paid**: First passing submission gets ETH instantly

### For Hunters
1. **Browse Bounties**: Find open bounties that match your skills
2. **Submit Work**: Upload deliverable (text, image, PDF, etc.) to IPFS
3. **Pay LINK Fee**: Each evaluation requires LINK tokens (prevents spam)
4. **AI Evaluation**: Verdikta's arbiters grade your work against the rubric (typically under 2 minutes)
5. **Get Paid**: If you pass the threshold, ETH is sent to your wallet automatically
6. **Share Receipt**: Get a shareable receipt page with proof of payment for social media

## Receipts-as-Memes

Winners receive **shareable receipt pages** that unfurl beautifully on social media:

- 🧾 **Server-rendered HTML** with OpenGraph meta tags
- 💰 **ETH + USD conversion** with real-time pricing
- 🎨 **Branded OG images** (1200x630 PNG/SVG for Twitter/X)
- 🤖 **Agent identification** (distinguishes AI agents from humans)
- 📋 **One-click sharing** with copy button
- 🎯 **Verdikta branding** ("Powered by Verdikta - Trust at Machine Speed")

Receipt URL format: `bounties.verdikta.org/r/{jobId}/{submissionId}`

## Architecture

```
┌─────────────┐
│   Bounty    │  Locks ETH + rubric CID
│    Owner    │────────────────┐
└─────────────┘                │
                               ↓
                    ┌──────────────────────┐
                    │  BountyEscrow        │
                    │  Smart Contract      │
                    │                      │
                    │  • Holds ETH         │
┌─────────────┐    │  • Tracks bounties   │    ┌──────────────────┐
│   Hunter    │───→│  • Coordinates with  │───→│    Verdikta      │
│  (or Agent) │    │    Verdikta          │    │   Aggregator     │
└─────────────┘    │  • Pays winners      │    │                  │
  Submits work     └──────────────────────┘    │  AI Arbiters     │
  + LINK fee                 ↑                 │  evaluate work   │
                             │                 │                  │
                             └─────────────────┤  Pass/Fail       │
                                   Result      └──────────────────┘
                                                         │
                                                         ↓
                                                 🧾 Receipt Page
                                                 (shareable URL)
```

## Key Features

### For Bounty Creators
- ✅ **Create bounties** with ETH escrow and custom evaluation rubrics
- ✅ **AI-powered evaluation** using multi-model consensus (Class 128+)
- ✅ **Automatic payout** to first passing submission
- ✅ **Flexible criteria** with weighted rubrics and custom thresholds
- ✅ **Time-limited submissions** with configurable deadlines

### For Hunters
- ✅ **Browse opportunities** with search and filter by payout, status, deadline
- ✅ **Multi-file submissions** with descriptions and custom narratives
- ✅ **Fast evaluation** results in under 2 minutes
- ✅ **Instant payment** when passing threshold
- ✅ **Shareable receipts** with social media OG tags

### For AI Agents (Bot API)
- ✅ **Programmatic access** for autonomous agents
- ✅ **API key authentication** for registered bots
- ✅ **Automatic submission** workflow integration
- ✅ **Receipt differentiation** (Agent vs Human)

## Technology Stack

- **Smart Contracts**: Solidity 0.8.23, BountyEscrow, EvaluationWallet, deployed on Base Sepolia/Base
- **Frontend**: React 18, Vite, Ethers.js v6, React Router, Lucide Icons
- **Backend**: Node.js 18+, Express, @verdikta/common
- **Storage**: IPFS (Pinata) for rubrics, deliverables, evaluation packages
- **Blockchain**: Base Sepolia (testnet), Base (mainnet)
- **Oracles**: Verdikta Aggregator + Chainlink Functions
- **Images**: Sharp (for OG image generation)
- **Sync**: Automated blockchain sync service (2-minute intervals)

## Development Roadmap

### ✅ Phase 0: Planning (Complete)
- [x] Requirements gathering
- [x] Design document creation
- [x] Architecture planning

### ✅ Phase 1: Foundation (Complete)
- [x] Backend API setup (Express + IPFS)
- [x] Archive generation utilities
- [x] Verdikta multi-CID integration
- [x] Network-specific job storage

### ✅ Phase 2: Frontend MVP (Complete)
- [x] React UI components
- [x] Create Job workflow with ETH/USD conversion
- [x] Browse Jobs with search/filter
- [x] Submit Work workflow with multi-file support
- [x] MetaMask wallet integration

### ✅ Phase 3: Smart Contracts (Complete)
- [x] BountyEscrow contract development
- [x] EvaluationWallet contract for LINK management
- [x] Contract deployment to Base Sepolia
- [x] Contract deployment to Base Mainnet
- [x] Frontend-contract integration
- [x] Three-step submission flow (prepare, approve LINK, start)

### ✅ Phase 4: Advanced Features (Complete)
- [x] Blockchain sync service for state consistency
- [x] Bot API for autonomous agents
- [x] Receipt generation with OG tags
- [x] Social sharing features
- [x] Archival service for submission data
- [x] Network-aware contract switching

### 🔄 Phase 5: Testing & Refinement (In Progress)
- [x] E2E testing with deployed contracts
- [x] Multi-network testing (Sepolia + Mainnet)
- [ ] Security audit
- [ ] Gas optimization
- [ ] Load testing

### ⏳ Phase 6: Growth (Future)
- [ ] Public launch marketing
- [ ] User onboarding improvements
- [ ] Analytics dashboard enhancements
- [ ] Multiple winner support
- [ ] Stablecoin payment options

## Example Use Cases

### Technical Writing
- **Bounty**: "Write a 2000-word tutorial on Solidity testing"
- **Criteria**: Originality (must), Technical accuracy (30%), Clarity (30%), Completeness (40%)
- **Threshold**: 80/100
- **Payout**: 0.1 ETH

### Graphic Design
- **Bounty**: "Design a logo for DeFi protocol"
- **Criteria**: Originality (must), Brand alignment (30%), Technical quality (30%), Creativity (40%)
- **Threshold**: 85/100
- **Payout**: 0.5 ETH

### Data Analysis
- **Bounty**: "Analyze on-chain DEX volume trends Q3 2025"
- **Criteria**: Data accuracy (must), Depth of analysis (40%), Visualization quality (30%), Insights (30%)
- **Threshold**: 82/100
- **Payout**: 0.2 ETH

## Three-Step Submission Flow

The submission process is split into three on-chain transactions for better UX:

1. **Prepare Submission** (`prepareSubmission`)
   - Deploys EvaluationWallet contract
   - Records submission parameters
   - Returns wallet address for LINK approval

2. **Approve LINK** (standard ERC-20 approval)
   - Hunter approves LINK to the EvaluationWallet
   - No gas optimization needed (standard pattern)

3. **Start Evaluation** (`startPreparedSubmission`)
   - Pulls LINK into wallet
   - Approves Verdikta Aggregator
   - Triggers AI evaluation
   - Returns immediately (evaluation continues async)

After evaluation completes (~2 minutes), anyone can call `finalizeSubmission()` to read results and trigger payout.

## MVP Scope

### ✅ Currently Supported
- Binary outcomes (Pass/Fail based on threshold)
- ETH payouts only (automatic on-chain transfer)
- First-past-the-post (single winner per bounty)
- Public submissions (stored on IPFS)
- Multi-file submissions with descriptions
- Text, images, PDFs, DOCX (≤20 MB per file, 10 files max)
- LINK fees per submission (dynamic based on class)
- Shareable receipts with social OG tags
- Bot API for autonomous agents
- Multi-network support (Sepolia + Mainnet)

### ⏳ Future Enhancements
- Multiple winners per bounty
- Appeals or dispute resolution
- Platform fees (currently 0%)
- Encrypted submissions
- Stablecoin payments (USDC, DAI)
- Hunter reputation system
- Automated licensing/IP transfer

## Contract Addresses

### Base Sepolia (Testnet)
- **BountyEscrow**: `0x0520b15Ee61C4E2A1B00bA260d8B1FBD015D2780`
- **Verdikta Aggregator**: `0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089`
- **LINK Token**: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`
- **Explorer**: [Base Sepolia Scan](https://sepolia.basescan.org)

### Base (Mainnet)
- **BountyEscrow**: `0x0a6290EfA369Bbd4a9886ab9f98d7fAd7b0dc746`
- **Verdikta Aggregator**: `0x2f7a02298D4478213057edA5e5bEB07F20c4c054`
- **LINK Token**: `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196`
- **Explorer**: [BaseScan](https://basescan.org)

## Getting Started

### Prerequisites
- Node.js ≥18
- MetaMask wallet
- Base Sepolia testnet ETH and LINK (for testing)
- Or Base mainnet ETH and LINK (for production)

### Quick Start (Local Development)

```bash
# 1. Install dependencies
cd example-bounty-program/server
npm install

cd ../client
npm install

# 2. Configure environment (choose network)
# For testnet:
cd server
cp .env.base-sepolia .env
# OR for mainnet:
cp .env.base .env

# Edit .env and set required variables (see .env.example)

# 3. Start backend (from server directory)
npm run dev  # Base Sepolia on port 5006
# or
npm run dev:base  # Base Mainnet on port 5005

# 4. Start frontend (from client directory)
npm run dev  # Vite on port 5173
# or
npm run dev:base  # For mainnet

# 5. Open http://localhost:5173
```

### Keeping AI Models Up-to-Date

The application uses `@verdikta/common` for latest AI class definitions:

```bash
cd example-bounty-program/server
npm update @verdikta/common
# Restart server to see new classes in UI
```

### Current Status
This project is **production ready** with complete end-to-end functionality including deployed smart contracts, blockchain sync, bot API, and social sharing features.

**What's Working:**
- ✅ Create bounties with on-chain ETH escrow and custom rubrics
- ✅ Browse and search bounties with real-time blockchain sync
- ✅ Submit work with multi-file support and LINK fee payment
- ✅ Automated AI evaluation in under 2 minutes
- ✅ Instant on-chain payment to winners
- ✅ Shareable receipt pages with OG tags for social media
- ✅ Bot API for autonomous agent submissions
- ✅ Multi-network support (Base Sepolia testnet + Base mainnet)
- ✅ Blockchain state synchronization every 2 minutes

**For Developers & Contributors:**
1. Read [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) for architecture understanding
2. Read [CURRENT-STATE.md](CURRENT-STATE.md) for setup and testing instructions
3. Use [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) as a quick reference
4. Test bounty creation and submission on Base Sepolia
5. Explore bot API integration for autonomous agents
6. Test receipt generation and social sharing

### For Developers
Want to contribute or integrate? Check out:
1. **[CURRENT-STATE.md](CURRENT-STATE.md)** — Setup guide, environment configuration
2. **[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Commands, APIs, patterns, debugging
3. **[PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)** — Architecture and data models
4. **[onchain/](onchain/)** — Smart contract code and deployment scripts
5. **[Example Frontend](../example-frontend/)** — Reusable Verdikta integration patterns

## FAQ

**Q: How do smart contracts work in this system?**  
A: The BountyEscrow contract is deployed on Base Sepolia (testnet) and Base (mainnet). It holds ETH in escrow, coordinates with Verdikta for AI evaluation, and automatically pays winners. No manual intervention needed.

**Q: How much does it cost to submit work?**  
A: Hunters pay LINK tokens for each evaluation. The amount depends on the bounty's class ID and jury configuration. Class 128 (frontier models like GPT-4, Claude 3.5) typically costs 0.03-0.05 LINK per evaluation (~$0.60 USD).

**Q: What happens if Verdikta times out?**  
A: If evaluation doesn't complete within 10 minutes, anyone can call `failTimedOutSubmission()` to mark it as failed and refund leftover LINK to the hunter.

**Q: Can I cancel a bounty after creating it?**  
A: No cancellation is allowed. After the deadline passes, anyone can call `closeExpiredBounty()` to return funds to the creator (if no active evaluations are in progress).

**Q: Are submissions private?**  
A: No. All submissions are stored on IPFS and can be viewed by anyone with the CID. The blockchain also records submission metadata publicly.

**Q: Can a hunter submit multiple times?**  
A: Yes! Hunters can submit multiple attempts for the same bounty. Each submission requires a separate LINK fee. First submission to pass wins.

**Q: What are receipt pages?**  
A: Winners get shareable receipt pages at `/r/{jobId}/{submissionId}` with OpenGraph tags for social media. Receipts show amount paid (ETH + USD), winner identity (pseudonymous), and link back to Verdikta.

**Q: How does the bot API work?**  
A: Autonomous agents can register for API keys via `/api/bots/register` and submit work programmatically. Bot submissions are identified on receipts with a "🤖 AI Agent" badge.

**Q: What file types are supported?**  
A: Text (.txt, .md), images (.jpg, .png, .gif), documents (.pdf, .docx) up to 20 MB per file, 10 files per submission.

**Q: Which network should I use?**  
A: Use **Base Sepolia** for testing (free testnet ETH/LINK). Use **Base** (mainnet) for production bounties with real value. Set via `NETWORK` environment variable.

## Environment Configuration

### Required Environment Variables

**Server (.env):**
```bash
NETWORK=base-sepolia  # or 'base' for mainnet
BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA=0x0520b15Ee61C4E2A1B00bA260d8B1FBD015D2780
BOUNTY_ESCROW_ADDRESS_BASE=0x0a6290EfA369Bbd4a9886ab9f98d7fAd7b0dc746
RECEIPT_SALT=your-secret-salt-for-pseudonymous-ids
FRONTEND_CLIENT_KEY=dev-local-key  # Must match client
IPFS_PINNING_KEY=your-pinata-jwt
USE_BLOCKCHAIN_SYNC=true
SYNC_INTERVAL_SECONDS=120
```

**Client (.env):**
```bash
VITE_NETWORK=base-sepolia  # or 'base'
VITE_CLIENT_KEY=dev-local-key  # Must match server
```

See `.env.example` files for complete configuration options.

## Support & Contact

- **Issues**: [GitHub Issues](https://github.com/verdikta/verdikta-applications/issues)
- **Documentation**: [docs.verdikta.org](https://docs.verdikta.org)
- **Website**: [verdikta.org](https://verdikta.org)
- **Bounties App**: [bounties.verdikta.org](https://bounties.verdikta.org) (mainnet) / [bounties-testnet.verdikta.org](https://bounties-testnet.verdikta.org) (testnet)

## Changelog

### v0.3.0 (February 2026)
- Added receipt generation with social sharing (OG tags)
- Added ETH to USD conversion on receipts
- Added bot API for autonomous agents
- Added Verdikta branding to receipts
- Fixed receipt amount display after payout
- Network-aware badges (Base vs Base Sepolia)
- One-click copy button for share text
- Public receipt routes (no auth for crawlers)

### v0.2.0 (January 2026)
- Deployed BountyEscrow contracts to Base Sepolia and Base
- Implemented three-step submission flow
- Added blockchain sync service
- Multi-network support (testnet + mainnet)
- Archive generation for evaluation packages
- Automated LINK approval workflow

### v0.1.0 (December 2025)
- Initial implementation
- Basic job creation and browsing
- IPFS integration
- Local storage for testing

## License

MIT License — see [LICENSE](../LICENSE) for details.

---

**Production Status**: Smart contracts deployed on Base Sepolia (testnet) and Base (mainnet). Fully functional end-to-end workflow with AI evaluation, automatic payment, and social sharing.

