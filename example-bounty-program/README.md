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
3. **Attach ETH Prepay**: Each submission needs a small ETH prepay (~0.00024 ETH) for oracle fees, which deters spam — most of it is refunded after evaluation
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

1. **Prepare Submission** (`prepareSubmission(bountyId, evaluationCid, hunterCid)`)
   - Deploys EvaluationWallet contract
   - Records the submission. The hunter supplies only their work CID (plus the bounty's evaluation CID as a guard that they are submitting against the package they think they are). Everything in the oracle request comes from the **bounty**: the evaluation package, the class, and the creator's oracle settings (`maxOracleFee`, `alpha`, `estimatedBaseCost`, `maxFeeBasedScaling`, chosen at `createBounty` and visible on the bounty), plus an always-empty addendum. The judged party cannot append text to the arbiters' query, steer arbiter selection, or shrink the eligible-arbiter pool by lowering the fee ceiling.
   - `ethMaxBudget` is `maxTotalFee(bounty.oracle.maxOracleFee)` at prepare time — an estimate of the prepay; `requiredPrepay(bountyId)` gives the live value to attach at start. It is identical for every submission to a bounty at any given moment.
   - `hunterCid` must be a bare CID (46–100 alphanumeric characters: CIDv0 `Qm…` or base32 CIDv1 `b…`); anything containing delimiters, a path prefix, or whitespace reverts with `bad hunterCid`. The same rule applies to `evaluationCid` at bounty creation (`bad evaluationCid`). The aggregator serializes the request as `1:<evaluationCid>,<hunterCid>:<addendum>` for the oracle nodes, so a stray comma or colon would smuggle an extra archive or an addendum into the evaluation.
   - Emits `SubmissionPrepared(bountyId, submissionId, hunter, evalWallet, ethMaxBudget, evaluationCid)` — `ethMaxBudget` is the worst-case ETH prepay (wei); it comes **before** the dynamic `string evaluationCid`, so even a naive `(address,uint256)` decode of the data reads it correctly. Simplest: use the `transaction.value` returned by the `/start` calldata endpoint, or `parsed.ethMaxBudget` from `/submit/bundle/complete`.
   - Its `topic0` is `0x147341637c0b8d941e61a743cd410afff8526bec154904bb54f857b8f59cd6ca` = `keccak256("SubmissionPrepared(uint256,uint256,address,address,uint256,string)")`. Don't hand-write it: `/submit/prepare` and `/submit/bundle` both return an `event` descriptor with the signature, topic0 and full ABI.

2. **Start Evaluation** (`startPreparedSubmission`, **payable**)
   - The funder attaches `requiredPrepay(bountyId)` as `msg.value` — the aggregator's current maximum total fee for the bounty's oracle fee, read live from the escrow. The `ethMaxBudget` in the step-1 event is that same figure at prepare time and is only an estimate: aggregator parameters can change in between, and the contract checks against the live value so a prepared submission can never be stranded by such a change. The `/start` calldata endpoint and the website read the live value for you.
   - Funds the EvaluationWallet with ETH for the oracle fees
   - Prepays the Verdikta aggregator (no approval step — the oracle is ETH-funded)
   - Triggers AI evaluation
   - Returns immediately (evaluation continues async)

There is no LINK token, ERC-20 approval, or allowance step — the prepay is plain ETH attached to `startPreparedSubmission`.

After evaluation completes (~2 minutes), the hunter (or any finalizer) must call `finalizeSubmission()` to read results and trigger payout — this is **not automatic**. Finalizing reads the result (it settles the round on the aggregator only if the round timed out) and automatically returns any unspent ETH prepay to whoever funded the start — the hunter in the common case (the per-submission EvaluationWallet pulls the `ethOwed` credit via `withdrawEth()` — you never claim it yourself). Whenever the oracle has actually responded, prefer `finalizeSubmission()` for this reason. If the oracle never responds, `failTimedOutSubmission()` (or the API's `/timeout` endpoint) fails the submission as a last resort — it has no timer of its own; it succeeds only once the aggregator reports the oracle round as timed out with no result (its response timeout, currently 5 minutes, after the start transaction — `nextAction` says `FORCE_FAIL` when it is callable). See [Submission timing rules](#submission-timing-rules).

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

1. For each pending submission, call `finalizeSubmission(bountyId, submissionId)` if the oracle has responded. If it never responded, call `failTimedOutSubmission(bountyId, submissionId)` instead — it works once the aggregator's oracle round has timed out (about 5 minutes after the start transaction) and refunds the unspent ETH prepay to whoever funded the start. It reverts with `result available - use finalizeSubmission` if a result exists, and `evaluation not settled` if the round is still open.
2. Once no submissions are pending, call `closeExpiredBounty(bountyId)`.

The UI does these in sequence inside one button. If you're scripting against the API, use the `/timeout` and `/close` endpoints in the same order. See [DEVELOPER-GUIDE.md → Reclaiming funds from an expired bounty](DEVELOPER-GUIDE.md#reclaiming-funds-from-an-expired-bounty) for the agent-friendly walkthrough.

### Submission timing rules

- **Everything a hunter must do happens before the deadline.** Both `prepareSubmission` and `startPreparedSubmission` require the current time to be before `submissionDeadline` (start reverts with `deadline passed`). Finalizing after the deadline is fine. At the deadline every submission is therefore paid, in oracle evaluation, or dead, which is what makes `closeExpiredBounty` safe to call as soon as the deadline passes.
- **Windowed bounties have an earlier effective cutoff.** The creator approval window is a per-submission timer that starts at `prepareSubmission`. It must end before the deadline with at least one second to spare, so a windowed submission can only be prepared up to `submissionDeadline − creatorAssessmentWindowSize − 2` — read `prepareCutoff(bountyId)` rather than computing it (later attempts revert with `window would end after deadline`). The hunter waits out the window, then starts arbitration before the deadline if the creator did not approve.
- **Payout priority on every bounty.** Payout priority is by submission index among submissions in evaluation: a passing submission is paid only once every earlier-submitted (lower-index) submission by another hunter has left evaluation — until then `finalizeSubmission` reverts `earlier submission pending - retry after it resolves` (a retry, not a failure; the result is kept). If an earlier one passes, it takes the bounty. This protects an original against a copy of its public work CID submitted later, whatever order the oracle rounds complete in. Only submissions in evaluation hold priority (a prepared-but-unstarted one holds none — start promptly after preparing), and a hunter's own earlier submission never blocks them.
- **Creator-approval priority on windowed bounties.** An earlier submission blocks creator approval of a later one only while it can still win: it is in oracle evaluation, or its approval window is still open. A hunter's own earlier version sitting in its window never blocks their newer one (a resubmission supersedes it — the creator can approve the revision immediately, and nobody has to pay to arbitrate the stale one). But a hunter's own earlier version that is already in oracle evaluation does block **creator approval** of a newer one: that earlier version is the hunter's live, paid-for claim to the arbiter-approval amount, and approving a revision for the (possibly smaller) creator-approval amount would extinguish it. The creator can approve the revision once the earlier evaluation has failed. An earlier submission also stops blocking once its window expires without arbitration being started. If a passing `finalizeSubmission` is blocked by another hunter's in-flight evaluation it reverts with `earlier submission pending - retry after it resolves`; the submission stays `PendingVerdikta` and the call is simply retried after the earlier one resolves.
- **Force-fail is gated on the oracle, not a clock.** `failTimedOutSubmission` first tries to settle the round on the aggregator, then succeeds only if the round is settled with no valid result. It can never discard a passing score.
- **The creator owns the oracle settings.** `createBounty` takes one struct that includes `oracle: { maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling }`, validated on-chain at creation (fee > 0 and ≤ the aggregator ceiling of that moment, base cost < fee, scaling 1–1000, alpha 0–1000). They are used for every evaluation of that bounty, clamped at start to the aggregator's live fee ceiling if it has since dropped (`effectiveOracleParams(bountyId)` shows what is forwarded; the stored settings never change). A hunter can inspect them before committing work and the website's validate check warns when they look rigged (few eligible arbiters at that fee, one operator dominating the eligible pool, price boost enabled); the creator cannot inspect a hunter, which is why these settings are not the hunter's.
- **Leftover prepay goes to whoever funded the start.** After a creator window expires anyone may fund `startPreparedSubmission`; the unspent oracle prepay is refunded to that funder (recorded as `funder` on the submission), not necessarily to the hunter.
- **Resolution never depends on the oracle refund.** Recovering the unspent prepay is attempted inline, wrapped and gas-capped (200k), so it cannot block or inflate a finalize or force-fail; if it fails, `RefundDeferred` is emitted and anyone can retry with `recoverLeftoverEth(bountyId, submissionId)` once the submission is resolved.
- **Ask the contract what to do.** `nextAction(bountyId, submissionId)` answers START, AWAIT_SLOT, AWAIT_CREATOR, AWAIT_ORACLE, AWAIT_EARLIER, FINALIZE, FORCE_FAIL, RECOVER_REFUND, DONE or DEAD from live state — always the call that will succeed now (AWAIT_SLOT: the 256 concurrency cap is reached; AWAIT_EARLIER: a passing result waiting for an earlier in-flight submission) (the API's `/diagnose` returns the same value as `nextAction`); `getOracleResult` reports the oracle round without the aggregator's ABI; `getSubmissions` / `getBounties` batch-read; `prepareCutoff` and `requiredPrepay` give the two numbers a hunter needs. See DEVELOPER-GUIDE → "Driving the contract without the API".
- **Payouts never depend on the recipient.** ETH is sent directly with a 120k gas cap; a recipient that rejects it, needs more gas, or burns what it is given is credited on the contract's pull ledger instead and collects with `withdraw()`. Settlement cannot be blocked or made expensive by a hostile recipient.
- **Malformed oracle results fail safely.** A score vector is valid only if it is the expected two-entry `[DONT_FUND, FUND]` with each entry at most 1,000,000. Anything else finalizes the submission as `Failed` with zero scores and refunds the prepay; it never pays out (out-of-range values are rejected, not clamped up to a pass) and never reverts, so the bounty stays open for other submissions and can still be closed. The same interpreter is used when checking whether another submission already passed, so start-time and payout-time decisions always agree.

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
A: Each submission attaches a small ETH prepay for oracle fees. The per-oracle fee is ~0.00002 ETH (on-chain ceiling 0.0004 ETH); the worst-case prepay (`ethMaxBudget`) is ~0.00024 ETH. Most of the prepay is automatically refunded to whoever funded the start (normally the hunter) when the submission finalizes — you only pay for the oracle work actually performed. The exact amount depends on the bounty's class ID and jury configuration.

**Q: What happens if Verdikta times out?**  
A: The aggregator's oracle round times out after its response timeout (currently 5 minutes, owner-settable) following `startPreparedSubmission` if not enough oracles respond. Once that has happened, anyone can call `failTimedOutSubmission()` to mark the submission as failed and refund the unspent ETH prepay to whoever funded the start. The call is gated on the aggregator's state rather than a fixed delay: it reverts with `evaluation not settled` while the round is still open, and with `result available - use finalizeSubmission` if the oracle did respond (in which case finalize instead).

**Q: Can I cancel a bounty after creating it?**  
A: No cancellation is allowed. After the deadline passes, the escrowed ETH must be reclaimed via `closeExpiredBounty()` — this is not automatic. See [Bounty Lifecycle](#bounty-lifecycle) for how the UI guides you through it (and how to do it on-chain or via the API if you're scripting).

**Q: Are submissions private?**  
A: No. All submissions are stored on IPFS and can be viewed by anyone with the CID. The blockchain also records submission metadata publicly.

**Q: Can a hunter submit multiple times?**  
A: Yes! Hunters can submit multiple attempts for the same bounty, without any cap on non-windowed bounties (windowed bounties cap prepared submissions at 128 across all hunters). What every bounty caps is concurrent oracle evaluations: at most 256 in flight at once, and a start that finds the slots full reverts `evaluation slots full - retry later` until any in-flight round resolves. Each submission requires a separate ETH prepay (mostly refunded). The earliest-submitted submission whose evaluation passes wins: a later passing submission waits (its finalize reverts `earlier submission pending - retry after it resolves`) until every earlier in-flight submission by another hunter has resolved, and if one of those passes it takes the bounty. So copying someone's public work CID after they have started their evaluation cannot beat them; only submissions already in evaluation hold priority, so start yours promptly after preparing.

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
GitHub issues and pull requests are not bounties and are not paid; bounties are
paid only for work submitted through [bounties.verdikta.org](https://bounties.verdikta.org).
See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Changelog

### v0.5.0 (September 2026) — BountyEscrow hardening (breaking contract revision, redeploy + ABI cutover; procedure in `deploy/CUTOVER-2026-09-12.md`)

- Gas: every submission wallet is now an EIP-1167 minimal-proxy clone of one `EvaluationWallet` implementation created by the escrow (`walletImplementation()`), cutting `prepareSubmission` from ~650k to ~282k gas; `Bounty` / `Submission` integer fields are narrowed for storage packing (finalize, create, force-fail and creator approval each 15–25% cheaper; decoder-compatible — every integer is still one ABI word). `Submission.justificationCids` is no longer stored on-chain (the `SubmissionFinalized` event and `getOracleResult` / the aggregator carry it permanently), which cuts a typical finalize from ~315k to ~123k gas; the `getSubmission` tuple drops that field. Escrow bytecode 17.8 KB.
- **Breaking ABI:** `createBounty` is one function taking a `CreateParams` struct (no more 5-/8-argument overloads) and includes creator-chosen oracle settings; `prepareSubmission(bountyId, evaluationCid, hunterCid)` — the hunter supplies nothing that reaches the aggregator except their work CID; `getBounty` gained a nested `oracle` struct; `getSubmission` lost the echo fields (`evaluationCid`, `maxOracleFee`, `alpha`, `estimatedBaseCost`, `maxFeeBasedScaling`, `addendum`) and gained `funder`; `SubmissionFinalized` gained `bool paid`; `SubmissionPrepared` reordered (`ethMaxBudget` before the `evaluationCid` string); legacy LINK interface and mock removed
- Force-fail (`failTimedOutSubmission`) gated on the aggregator's round state instead of a 10-minute timer; it can never discard a passing result
- Malformed oracle score vectors (wrong length, or any entry above 1,000,000) finalize as `Failed` with a refund instead of reverting or being clamped into a pass; one interpreter serves finalize and the already-passed checks
- Deadline rule: prepare AND start must happen before the deadline; a creator window must end before the deadline (`window would end after deadline`)
- Windowed priority: same-hunter resubmissions and expired never-started submissions no longer block; a same-hunter submission already under evaluation blocks creator approval; a blocked passing finalize reverts (retryable) instead of becoming terminal `PassedUnpaid`
- Payout priority by submission index among in-flight submissions, on every bounty (copy protection): a later passing finalize waits (`earlier submission pending - retry after it resolves`) for earlier in-flight submissions by other hunters; order-independent
- `MAX_ACTIVE_EVALUATIONS = 256` — cap on concurrent evaluations per bounty (the pending list); bounds the on-chain scans without letting gas-only junk prepares consume anything
- `MAX_SUBMISSIONS_PER_BOUNTY = 128` — cap on prepared submissions, WINDOWED bounties only (their priority scan must see in-window entries)
- CID validation: `evaluationCid` and `hunterCid` must be bare CIDs (46–100 alphanumeric characters) — `bad evaluationCid` / `bad hunterCid`
- Payout gas cap: direct sends forward at most `PAYOUT_GAS_LIMIT = 120000` gas; recipients needing more are credited to the pull ledger (`withdrawable` / `withdraw()`)
- Unspent oracle prepay is refunded to the address that funded the start (`funder`); recovery is best-effort inside resolution, gas-capped, with a permissionless retry `recoverLeftoverEth` (event `RefundDeferred`)
- Oracle settings are clamped to the aggregator's live fee ceiling at start (`effectiveOracleParams`), so a later aggregator configuration change cannot strand prepared submissions
- Start checks `msg.value` against the live `requiredPrepay(bountyId)` and clamps the bounty's oracle settings to the aggregator's live fee ceiling (`effectiveOracleParams`), so no later aggregator configuration change can strand a prepared submission; the prepare-time `ethMaxBudget` is an estimate
- Agent-facing views so the whole lifecycle can be driven with the escrow ABI alone: `getSubmissions`, `getBounties(start, count)`, `getOracleResult` (no aggregator ABI needed), `nextAction` (START / AWAIT_SLOT / AWAIT_CREATOR / AWAIT_ORACLE / AWAIT_EARLIER / FINALIZE / FORCE_FAIL / RECOVER_REFUND / DONE / DEAD), `prepareCutoff`, `requiredPrepay`; API: `nextAction` on `/diagnose`, `requiredPrepay` + `prepareCutoff` on `/onchain-status`, new `POST /submissions/:subId/recover-refund` and `GET /jobs/withdrawable/:address` calldata endpoints
- Website: oracle settings on the create wizard (advanced, defaulted) and an oracle-settings check on validate; force-fail gating follows the aggregator; new revert reasons mapped
- See [Submission timing rules](#submission-timing-rules) and DEVELOPER-GUIDE → "Submission timing and priority rules"

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

