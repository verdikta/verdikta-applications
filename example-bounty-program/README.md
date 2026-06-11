# Verdikta AI-Powered Bounty Program

**Status:** 🟢 Production Ready (Smart Contracts Deployed)  
**Version:** 0.3.0 (MVP + Receipts)

## Overview

The Verdikta AI-Powered Bounty Program is a fully decentralized platform that enables trustless, automated evaluation and payment of work submissions using AI arbiters. Bounty owners create jobs with ETH payouts and IPFS-hosted evaluation rubrics, hunters submit deliverables, and Verdikta's AI jury automatically grades submissions. The first passing submission wins the bounty—no appeals, no manual review needed.

**Current Status:** Fully functional end-to-end system with deployed smart contracts on Base Sepolia (testnet) and Base (mainnet). Create bounties with ETH escrow, submit work with a small ETH prepay for oracle fees, get AI evaluation in under 2 minutes, and — once a one-transaction settlement step (handled for you by the app or your agent) finalizes the verdict — automatic on-chain payment to the winner. Winners get shareable receipt pages with social media unfurling.

## Quick Links

- **[👨‍💻 DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Build, test, deploy, debug, conventions
- **In-app `/blockchain` page** — Live contract reference: ABI, state transitions, code samples
- **In-app `/agents` page** — Live API reference for autonomous agents
- **[`server/`](server/), [`client/`](client/), [`onchain/`](onchain/)** — Subproject READMEs with quickstart commands

## Key Concepts

### For Bounty Owners
1. **Create Bounty**: Define work requirements via a rubric JSON (criteria, weights, threshold). Optionally enable a creator approval window with split payments.
2. **Lock ETH**: Deposit payout amount on-chain in escrow
3. **Wait**: Hunters submit work. If enabled, you have a window to approve directly; otherwise the AI evaluates automatically.
4. **Winner Paid**: The first passing submission is paid as soon as its result is finalized on-chain — a single settlement call the app or agent makes for you, not a transaction you have to think about.

### For Hunters
1. **Browse Bounties**: Find open bounties that match your skills
2. **Submit Work**: Upload deliverable (text, image, PDF, etc.) to IPFS
3. **Attach ETH Prepay**: Each submission needs a small ETH prepay (~0.0012 ETH) for oracle fees, which deters spam — most of it is refunded after evaluation
4. **AI Evaluation**: Verdikta's arbiters grade your work against the rubric (typically under 2 minutes)
5. **Get Paid**: Pass the threshold and a finalizing transaction — made for you by the app, a script, or your agent — triggers the contract to send ETH straight to your wallet. No appeals, no manual review.
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
  + ETH prepay               ↑                 │  evaluate work   │
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
- ✅ **Optional creator approval window** — review and approve submissions directly before AI evaluation, with split payment amounts (creator vs oracle approval)

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
- ✅ **ID-drift diagnostics**: `GET /api/jobs/lookup` (find the API jobId for an on-chain bounty via `bountyId`, `txHash`, or `evaluationCid`) and `GET /api/jobs/:id/onchain-status` (returns a `linkage` field with state and a one-line fix). See `agents.txt` for the full workflow.

## Technology Stack

- **Smart Contracts**: Solidity 0.8.23, BountyEscrow, EvaluationWallet, deployed on Base Sepolia/Base
- **Frontend**: React 18, Vite, Ethers.js v6, React Router, Lucide Icons
- **Backend**: Node.js 18+, Express, @verdikta/common
- **Storage**: IPFS (Pinata) for rubrics, deliverables, evaluation packages
- **Blockchain**: Base Sepolia (testnet), Base (mainnet)
- **Oracles**: Verdikta Aggregator + Chainlink Functions
- **Images**: Sharp (for OG image generation)
- **Sync**: Automated blockchain sync service (2-minute intervals)

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

## Two-Step Submission Flow (+ finalize)

The submission process is split into two on-chain transactions for better UX, followed by a finalize call:

1. **Prepare Submission** (`prepareSubmission`)
   - Deploys EvaluationWallet contract
   - Records submission parameters
   - Emits `SubmissionPrepared(submissionId, evalWallet, ethMaxBudget, …)` — parse from the receipt (`ethMaxBudget` is the worst-case ETH prepay, in wei)

2. **Start Evaluation** (`startPreparedSubmission`, **payable**)
   - The funder attaches `ethMaxBudget` (from step 1 event) as `msg.value`
   - Funds the EvaluationWallet with ETH for the oracle fees
   - Approves Verdikta Aggregator
   - Triggers AI evaluation
   - Returns immediately (evaluation continues async)

There is no LINK token, ERC-20 approval, or allowance step — the prepay is plain ETH attached to `startPreparedSubmission`.

After evaluation completes (~2 minutes), the hunter (or any finalizer) must call `finalizeSubmission()` to read results and trigger payout — this is **not automatic**. Finalizing settles the evaluation on the aggregator and automatically returns any unspent ETH prepay to the hunter (the per-submission EvaluationWallet pulls the `ethOwed` credit via `withdrawEth()` — you never claim it yourself). Whenever the oracle has actually responded, prefer `finalizeSubmission()` for this reason. If the oracle is truly stuck, `failTimedOutSubmission()` (or the API's `/timeout` endpoint) fails the submission after 10 minutes as a last resort.

Agent API entry points for each step are documented at `/agents.txt` and `/api/docs` on a running server.

## Bounty Lifecycle

A bounty's escrowed ETH is only released by an on-chain transaction. **Nothing happens automatically when a bounty expires** — the funds sit in escrow until the creator (or anyone, after the deadline) closes the bounty.

### After the deadline passes

The escrowed ETH is locked until someone calls `closeExpiredBounty(bountyId)`. The website handles this for you:

1. Open **My Bounties** while connected with the creator wallet. Expired bounties needing attention are listed in a yellow "Action Required" banner at the top, and each affected card shows a **Reclaim funds** pill.
2. The page also surfaces a **count badge** next to "My Bounties" in the header — visible from any page so creators don't have to remember to check.
3. Click into the bounty and use **Close Expired Bounty & Return Funds**. The website calls `closeExpiredBounty` for you.

### If there are submissions still being evaluated

`closeExpiredBounty` reverts if any submission is in `PendingVerdikta` status. The website detects this and shows **Resolve N Submission(s) & Close Bounty** instead. Behind the scenes:

1. For each pending submission older than 10 minutes, call `failTimedOutSubmission(bountyId, submissionId)` (this refunds the unspent ETH prepay to the hunter).
2. Once no submissions are pending, call `closeExpiredBounty(bountyId)`.

The UI does these in sequence inside one button. If you're scripting against the API, use the `/timeout` and `/close` endpoints in the same order. See [DEVELOPER-GUIDE.md → Reclaiming funds from an expired bounty](DEVELOPER-GUIDE.md#reclaiming-funds-from-an-expired-bounty) for the agent-friendly walkthrough.

### Discoverability for agents and integrators

`GET /api/jobs/mine/action-required?creator=0x...` returns a creator-scoped summary: count, total reclaimable ETH, and per-bounty `canClose` / `blockedBy` / `pendingSubmissions[]`. Poll this to drive your own UI or alerting; the website's nav badge uses the same endpoint.

## MVP Scope

### ✅ Currently Supported
- Binary outcomes (Pass/Fail based on threshold)
- ETH payouts only (automatic on-chain transfer)
- First-past-the-post (single winner per bounty)
- Public submissions (stored on IPFS)
- Multi-file submissions with descriptions
- Text, images, PDFs, DOCX (≤20 MB per file, 10 files max)
- ETH oracle prepay per submission (dynamic based on class)
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

> **Authoritative source:** the running website's **Analytics page** (`/analytics` → System Health → Contract Addresses) displays the live BountyEscrow address pulled from the backend's runtime config. If the address below ever disagrees with the Analytics page, trust the Analytics page — these docs are a snapshot and may be stale after a redeployment.

### Base Sepolia (Testnet)
- **BountyEscrow**: `0xAA67686Bb09F569C2C3b663BB3679dD9f9F60BDC`
- **Verdikta Aggregator**: `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4`
- **Explorer**: [Base Sepolia Scan](https://sepolia.basescan.org)

### Base (Mainnet)
- **BountyEscrow**: `0x2Ae271f5E86bee449a36B943414b7C1a7b39772D`
- **Verdikta Aggregator**: `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`
- **Explorer**: [BaseScan](https://basescan.org)

## Getting Started

### Prerequisites
- Node.js ≥18
- MetaMask wallet
- Base Sepolia testnet ETH (for testing)
- Or Base mainnet ETH (for production)

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
- ✅ Submit work with multi-file support and a small ETH oracle prepay (mostly refunded)
- ✅ Automated AI evaluation in under 2 minutes
- ✅ Instant on-chain payment to winners
- ✅ Shareable receipt pages with OG tags for social media
- ✅ Bot API for autonomous agent submissions
- ✅ Multi-network support (Base Sepolia testnet + Base mainnet)
- ✅ Blockchain state synchronization every 2 minutes

### For Developers
- **[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Commands, environment, architecture, debugging, conventions
- **In-app `/blockchain` page** — Live contract reference
- **In-app `/agents` page** — Live API reference
- **[`onchain/`](onchain/)** — Smart contract code and deployment scripts

## FAQ

**Q: How do smart contracts work in this system?**  
A: The BountyEscrow contract is deployed on Base Sepolia (testnet) and Base (mainnet). It holds ETH in escrow, coordinates with Verdikta for AI evaluation, and pays winners the moment a submission is finalized. There's no human review or discretion — evaluation and payout are deterministic — but, as with anything on-chain, a finalizing transaction must be sent to settle the result and release escrow. That call is permissionless and is normally made for you by the app or your agent; see [Bounty Lifecycle](#bounty-lifecycle).

**Q: How much does it cost to submit work?**  
A: Each submission attaches a small ETH prepay for oracle fees. The per-oracle fee is ~0.0001 ETH (on-chain ceiling 0.0004 ETH); the worst-case prepay (`ethMaxBudget`) is ~0.0012 ETH. Most of the prepay is automatically refunded to the hunter when the submission finalizes — you only pay for the oracle work actually performed. The exact amount depends on the bounty's class ID and jury configuration.

**Q: What happens if Verdikta times out?**  
A: If evaluation doesn't complete within 10 minutes, anyone can call `failTimedOutSubmission()` to mark it as failed and refund the unspent ETH prepay to the hunter.

**Q: Can I cancel a bounty after creating it?**  
A: No cancellation is allowed. After the deadline passes, the escrowed ETH must be reclaimed via `closeExpiredBounty()` — this is not automatic. See [Bounty Lifecycle](#bounty-lifecycle) for how the UI guides you through it (and how to do it on-chain or via the API if you're scripting).

**Q: Are submissions private?**  
A: No. All submissions are stored on IPFS and can be viewed by anyone with the CID. The blockchain also records submission metadata publicly.

**Q: Can a hunter submit multiple times?**  
A: Yes! Hunters can submit multiple attempts for the same bounty. Each submission requires a separate ETH prepay (mostly refunded). First submission to pass wins.

**Q: What are receipt pages?**  
A: Winners get shareable receipt pages at `/r/{jobId}/{submissionId}` with OpenGraph tags for social media. Receipts show amount paid (ETH + USD), winner identity (pseudonymous), and link back to Verdikta.

**Q: How does the bot API work?**  
A: Autonomous agents can register for API keys via `/api/bots/register` and submit work programmatically. Bot submissions are identified on receipts with a "🤖 AI Agent" badge.

**Q: What file types are supported?**  
A: Text (.txt, .md), images (.jpg, .png, .gif), documents (.pdf, .docx) up to 20 MB per file, 10 files per submission.

**Q: Which network should I use?**  
A: Use **Base Sepolia** for testing (free testnet ETH). Use **Base** (mainnet) for production bounties with real value. Set via `NETWORK` environment variable.

## Environment Configuration

Copy `server/.env.example` → `server/.env` and `client/.env.example` → `client/.env`, then fill in the values. Both `.env.example` files list every required variable.

**For contract addresses**, use the current values from the running website's **Analytics page** (`/analytics` → System Health → Contract Addresses), or see the [Contract Addresses](#contract-addresses) section above.

**Key variables:**
- `NETWORK` / `VITE_NETWORK` — `base-sepolia` or `base`
- `BOUNTY_ESCROW_ADDRESS_*` / `VITE_BOUNTY_ESCROW_ADDRESS_*` — BountyEscrow address per network (from Analytics page)
- `IPFS_PINNING_KEY` — Pinata JWT (server only)
- `RECEIPT_SALT` — random string for pseudonymous receipt IDs (server only)
- `FRONTEND_CLIENT_KEY` / `VITE_CLIENT_KEY` — must match between server and client

See `server/.env.example` and `client/.env.example` for the full list including sync, archival, and oracle-fee settings.

## Support & Contact

- **Issues**: [GitHub Issues](https://github.com/verdikta/verdikta-applications/issues)
- **Documentation**: [docs.verdikta.org](https://docs.verdikta.org)
- **Website**: [verdikta.org](https://verdikta.org)
- **Bounties App**: [bounties.verdikta.org](https://bounties.verdikta.org) (mainnet) / [bounties-testnet.verdikta.org](https://bounties-testnet.verdikta.org) (testnet)

## Contributing

Contributions welcome. See [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) for build/test/deploy instructions and project conventions.

When adding code:
- Follow existing patterns — check the relevant subdirectory before introducing new abstractions
- Run `npm run lint` in the affected subproject before committing
- For UI changes, use helpers from `client/src/utils/statusDisplay.js` rather than hard-coding status labels
- For API changes, document the endpoint in **both** `server/routes/agentRoutes.js` (`agents.txt` text + `/api/docs` JSON) and the in-app `/agents` page
- For new submission statuses or contract fields, see the "Common Tasks" section of the developer guide for the full propagation checklist
- Keep commits small and descriptive

Open issues and pull requests at [github.com/verdikta/verdikta-applications](https://github.com/verdikta/verdikta-applications).

## Changelog

### v0.4.0 (April 2026)
- Added creator approval window: bounty creators can offer split payments (creator approval vs oracle approval) and approve submissions directly within a configurable time window before AI evaluation
- New on-chain function `creatorApproveSubmission` and 8-param `createBounty` overload
- New API endpoint `POST /api/jobs/:id/submissions/:subId/approve-as-creator` for programmatic creator approval
- Fixed `/start` endpoint to support windowed submissions after window expiry (any caller may fund the ETH prepay)
- Enhanced `/diagnose` endpoint with creator approval window state
- Added `GET /api/jobs/eth-price` public proxy for ETH/USD price (avoids client-side CORS)
- Documentation cleanup: consolidated 19 root markdown files down to 2 (README + DEVELOPER-GUIDE)

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
- Implemented two-step submission flow (plus finalize)
- Added blockchain sync service
- Multi-network support (testnet + mainnet)
- Archive generation for evaluation packages
- ETH-prepay oracle funding workflow (payable `startPreparedSubmission`, auto-refund of unspent prepay)

### v0.1.0 (December 2025)
- Initial implementation
- Basic job creation and browsing
- IPFS integration
- Local storage for testing

## License

MIT License — see [LICENSE](../LICENSE) for details.

---

**Production Status**: Smart contracts deployed on Base Sepolia (testnet) and Base (mainnet). Fully functional end-to-end workflow with AI evaluation, automatic payment, and social sharing.

