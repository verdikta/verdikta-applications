# Developer Guide

Quick reference for building, testing, and deploying the Verdikta Bounty Program.

For project overview, architecture, and changelog, see [README.md](README.md).
For detailed API and contract docs, see the in-app `/agents` and `/blockchain` pages.

---

## Repository Layout

```
example-bounty-program/
├── client/      # React + Vite frontend
├── server/      # Express + IPFS backend
├── onchain/     # Solidity contracts + Hardhat
├── README.md
├── DEVELOPER-GUIDE.md
└── CLAUDE.md
```

---

## Local Development

### Backend (`server/`)

```bash
cd server
npm install
cp .env.example .env       # then fill in IPFS_PINNING_KEY etc.
npm run dev                # nodemon, default port 5005
npm test                   # Jest test suite
npm run lint               # ESLint
```

Useful npm scripts:
- `npm start` — run with `node` (no nodemon)
- `npm run create-bounties` — populate test bounties via `scripts/createBounties.js`

### Frontend (`client/`)

```bash
cd client
npm install
cp .env.example .env       # set VITE_NETWORK and VITE_*_ADDRESS_* vars
npm run dev                # Vite dev server, port 5173
npm run build              # production bundle to dist/
npm run preview            # serve dist/ locally
npm run lint               # ESLint
```

The client uses a relative `/api` URL — Vite is configured to proxy to the backend, so the server must be running on the expected port.

### Smart Contracts (`onchain/`)

```bash
cd onchain
npm install
cp .env.example .env       # add PRIVATE_KEY, RPC URLs, BASESCAN_API_KEY
npm run compile            # hardhat compile
npm test                   # hardhat test
npm run coverage           # solidity-coverage report
npm run deploy:sepolia     # deploy to Base Sepolia
npm run deploy:base        # deploy to Base mainnet
```

Deployment scripts: `deploy/01_deploy_bounty.js`. Convenience wrappers: `deploy_testnet.sh`, `deploy_mainnet.sh`.

---

## Environment Configuration

### Server (`server/.env`)

Start from the `server/.env.example` template and fill in the values. Required keys include:

- `NETWORK` — `base-sepolia` or `base`
- `PORT` — default 5005
- `IPFS_PINNING_KEY` — Pinata JWT
- `RPC_PROVIDER_URL` — RPC endpoint for the active network
- `BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA` and `BOUNTY_ESCROW_ADDRESS_BASE` — BountyEscrow contract per network. **Get the current values from the running website's Analytics page** (`/analytics` → System Health → Contract Addresses) or from the [Contract Addresses](../README.md#contract-addresses) section of the root README.
- `FRONTEND_CLIENT_KEY` — must match `VITE_CLIENT_KEY` on the client
- `FRONTEND_ALLOWED_ORIGINS` — comma-separated allowed origins
- `RECEIPT_SALT` — random string for pseudonymous receipt IDs
- `USE_BLOCKCHAIN_SYNC=true` — enable the 2-minute polling sync service
- `SYNC_INTERVAL_MINUTES=2`

See `server/.env.example` for the complete set including archival, rate-limiting, and oracle config.

### Client (`client/.env`)

Start from `client/.env.example` and fill in the values. Required:

- `VITE_NETWORK` — `base-sepolia` or `base`
- `VITE_CLIENT_KEY` — must match `FRONTEND_CLIENT_KEY` on the server
- `VITE_BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA` and `VITE_BOUNTY_ESCROW_ADDRESS_BASE` — **current values from the Analytics page** (`/analytics` → System Health → Contract Addresses)
- `VITE_VERDIKTA_AGGREGATOR_ADDRESS_*` — the ETH-funded Verdikta aggregator address per network; available from the Analytics page, from `onchain/deployments/*.json`, or from the [Contract Addresses](../README.md#contract-addresses) section of the README

### Contracts (`onchain/.env`)

```bash
PRIVATE_KEY=<deployer-private-key>      # NEVER commit
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_MAINNET_RPC_URL=https://mainnet.base.org
BASESCAN_API_KEY=<for-source-verification>
```

---

## Architecture Overview

```
Browser  ──HTTP──▶  server (Express)  ──RPC──▶  Base Sepolia / Base
   │                     │
   │                     ├──▶  IPFS (Pinata)
   │                     └──▶  jobs.json (per-network local storage)
   │
   └──MetaMask──▶  BountyEscrow contract  ──▶  VerdiktaAggregator
```

- **`server/utils/syncService.js`** — polls the contract every 2 min, mirrors on-chain state into `server/data/{network}/jobs.json`
- **`server/utils/contractService.js`** — read-only contract calls used by sync and refresh endpoints
- **`server/routes/jobRoutes.js`** — main API: bounty CRUD, calldata endpoints, diagnose, refresh
- **`server/routes/agentRoutes.js`** — public agent discovery (`/agents.txt`, `/api/docs`, `/api/jobs.txt`, `/feed.xml`)
- **`client/src/services/contractService.js`** — frontend ethers v6 wrapper for write operations
- **`client/src/utils/statusDisplay.js`** — single source of truth for status labels and badges
- **`onchain/contracts/BountyEscrow.sol`** — main contract; see [README.md#contract-addresses](README.md#contract-addresses)

---

## Testing

### Backend
```bash
cd server
npm test                   # Jest, all suites
npm test -- --watch        # watch mode
npm test path/to/file      # single file
```

### Contracts
```bash
cd onchain
npm test                   # full Hardhat test suite
npx hardhat test test/BountyEscrow.test.js
npm run coverage           # solidity-coverage
```

### Frontend
No automated UI tests. Manual smoke check before commit:
```bash
cd client
npm run lint
npm run build              # production bundle must build clean
```

### End-to-end on testnet
1. Start backend pointing at Base Sepolia (`NETWORK=base-sepolia`)
2. Start frontend with matching network env vars
3. Connect MetaMask to Base Sepolia
4. Get test ETH from a faucet
5. Create a bounty, submit work, finalize, verify payout

---

## Deployment

### Smart contracts
```bash
cd onchain
npm run deploy:sepolia     # or deploy:base
# Deployer key from .env, RPC from hardhat.config.js
```

For a **breaking** contract revision (any ABI change) do not deploy in isolation — follow the cutover runbook in `deploy/` for that release (currently `deploy/CUTOVER-2026-09-12.md`): close out the old contract's open bounties, deploy testnet then mainnet, stop services, apply the off-chain migration patch, flip the addresses and `deploymentBlocks`, archive and reset `jobs.json` (bounty IDs restart at 0 on a new contract and `jobId == bountyId`), restart, smoke-test. The runbook has a rollback section.

After deployment:
1. Note the new BountyEscrow address from console output. The deploy script also auto-writes it to `onchain/deployments/{chainId}-{network}.json`.
2. Update `BOUNTY_ESCROW_ADDRESS_*` in `server/.env` and `VITE_BOUNTY_ESCROW_ADDRESS_*` in `client/.env` to the new address for this network.
3. Restart the server (`cd server && ./restartServer.sh`) and rebuild the client (`cd client && ./rebuildClient.sh` or `npm run build`).
4. **Update `README.md`** — the "Contract Addresses" section has the two canonical addresses hardcoded as a snapshot. Edit the relevant network's `BountyEscrow` line. **Do not leave this stale** — the running website's `/analytics` page is the live source of truth, and the README should agree with it.
5. Verify the new address is live via Basescan, and cross-check against the `/analytics` page on the running website (System Health → Contract Addresses → Bounty Escrow).

#### Is the contract source in this tree safe to deploy as-is?

**Yes. Deploy it and follow the checklist above — nothing else is required.**

Whatever is committed here compiles to an ABI that the current server and client already speak, so a redeploy needs no coordinated code change beyond the address swap in steps 2-3. If you are ever unsure, prove it in 30 seconds rather than trusting this paragraph:

```bash
cd onchain
git stash                                        # or: git show <last-deployed-tag>:...
npx hardhat compile --force
node -e "console.log(JSON.stringify(require('./artifacts/contracts/BountyEscrow.sol/BountyEscrow.json').abi))" > /tmp/abi_old.json
git stash pop
npx hardhat compile --force
node -e "console.log(JSON.stringify(require('./artifacts/contracts/BountyEscrow.sol/BountyEscrow.json').abi))" > /tmp/abi_new.json
cmp /tmp/abi_old.json /tmp/abi_new.json && echo "identical ABI — drop-in"
```

Identical ABI means internal-logic-only changes: safe to deploy against the existing off-chain code.

**The September 2026 revision is NOT drop-in.** It is a breaking release: the contract must be deployed to a new address AND every off-chain ABI copy must flip in the same release. The step-by-step procedure is `deploy/CUTOVER-2026-09-12.md`, and the off-chain code migration is `deploy/cutover-2026-09-12.patch` (21 server/client/script files, verified with `git apply --check` and the server test suite). The patch is applied at cutover with `git apply`, never earlier: the client build-watch publishes any edit to the live site immediately, and the migrated code encodes the new ABI. Until then the migrated code exists in applied form only in a throw-away git worktree (`../example-bounty-program-cutover`, listed in `.git/info/exclude`), which the runbook removes at the end. What changed in the interface:

| Piece | Before | After |
|---|---|---|
| `createBounty` | two positional overloads (5 and 8 args) | one function taking a `CreateParams` struct, including `oracle: {maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling}` |
| `prepareSubmission` | 8 args (hunter-supplied addendum / alpha / fee / base cost / scaling) | `(bountyId, evaluationCid, hunterCid)` |
| `getBounty` tuple | 14 fields | + trailing nested `oracle` struct |
| `getSubmission` tuple | 18 fields | 12 fields: `justificationCids` REMOVED (not stored on-chain — read `SubmissionFinalized` or `getOracleResult`; the aggregator keeps it permanently), `evaluationCid`, `maxOracleFee`, `alpha`, `estimatedBaseCost`, `maxFeeBasedScaling`, `addendum` removed; `funder` added last |
| `SubmissionFinalized` | `(…, bool passed, acceptance, rejection, justification)` | `(…, bool passed, bool paid, acceptance, rejection, justification)` |
| `SubmissionPrepared` | `(…, evalWallet, string evaluationCid, ethMaxBudget)` | `(…, evalWallet, ethMaxBudget, string evaluationCid)` — new topic0 |
| New functions/events | — | `recoverLeftoverEth(bountyId, submissionId)`, event `RefundDeferred(bountyId, submissionId)`, views `requiredPrepay(bountyId)`, `effectiveOracleParams(bountyId)` |
| Agent-facing views | — | `getSubmissions(bountyId)`, `getBounties(start, count)` (≤ `MAX_BATCH` = 100), `getOracleResult(bountyId, submissionId)`, `nextAction(bountyId, submissionId)`, `prepareCutoff(bountyId)` |
| Gas (Tier A, 2026-09-12) | full `EvaluationWallet` deployment per prepare; 15/12-slot structs | every submission wallet is an EIP-1167 clone of `walletImplementation()` (new getter; created in the constructor; verify it so explorers label the clones); `Bounty`/`Submission` integer fields narrowed for packing (decoder-compatible, see below); `Submission.justificationCids` REMOVED — the tuple has 12 fields, positional decoders and every fragment copy must drop it (the event and `getOracleResult` still carry the CIDs); `hunter()` removed from `EvaluationWallet`. Measured: prepare 650k → 282k, create 384k → 322k, finalize (3-CID justification) 315k → 123k, start 440k → 424k, force-fail 149k → 134k, creator approve 94k → 78k, deploy −1.5M; escrow 21.2 KB → 18.1 KB |
| Read-only lens | — | these five plus `getSubmissionsPage(bountyId, start, count)` (≤ `MAX_BATCH`), `canBeClosed`, `isAcceptingSubmissions`, `getEffectiveBountyStatus` live in `BountyEscrowLens` (bytecode-size split) and are served **at the escrow address** through a static-delegatecall fallback; new getter `lens()`; `lensDelegate(bytes)` is fallback plumbing (reverts `self only`). The compiled `BountyEscrow` artifact / explorer ABI does not list them — use the merged ABI (`onchain/deploy/helpers.js → mergedAbi()`) |
| New constants | — | `SCORE_SCALE`, `SCORE_DIVISOR` (score normalization, documented on-chain); `INLINE_REFUND_GAS_LIMIT` (gas cap on the inline prepay recovery) |
| New views | — | `withdraw()`, `withdrawable`, `canBeClosed`, `activeEvaluations` (now a function: the pending list's length), `pendingSubmissionIds(bountyId)`, `submissionCount`, constants `MAX_ACTIVE_EVALUATIONS` (256, concurrent evaluations per bounty), `MAX_SUBMISSIONS_PER_BOUNTY` (128, windowed bounties only), `PAYOUT_GAS_LIMIT`, `MIN/MAX_CID_LENGTH`, `MAX_ALPHA`, `MAX_FEE_SCALING_FACTOR`, `ADDENDUM` |
| Removed | `ILinkToken`, `MockLinkToken` | — |

Exact fragments (copy verbatim into ABI lists):

```
function createBounty((string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle) p) payable returns (uint256 bountyId)
function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)
function getBounty(uint256 bountyId) view returns ((address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint128 payoutWei, uint64 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint64 submissions, address targetHunter, uint128 creatorDeterminationPayment, uint128 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle))
function getSubmission(uint256 bountyId, uint256 submissionId) view returns ((address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint8 acceptance, uint8 rejection, uint64 submittedAt, uint64 finalizedAt, uint96 ethMaxBudget, uint64 creatorWindowEnd, address funder))
event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, bool passed, bool paid, uint256 acceptance, uint256 rejection, string justificationCids)
event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)
```

The integer fields of `Bounty` / `Submission` are typed as narrowly as their domain allows (storage packing: 12 and 6 slots instead of 15 and 12). Every integer still ABI-encodes as one 32-byte word, so a fragment that declares them as `uint256` — as the server, client and scripts do — decodes identically; only the type names differ.

Behavioral changes shipped in the same revision (all documented in [Submission timing and priority rules](#submission-timing-and-priority-rules)):

- `PassedUnpaid` payout-deadlock fix; payout priority by submission index among IN-FLIGHT submissions on EVERY bounty (copy protection — a later passing finalize waits, retryable, for earlier in-flight submissions by other hunters; order-independent). `PassedUnpaid` is written only once the bounty is Awarded/Closed.
- `failTimedOutSubmission` gated on aggregator state instead of a 10-minute timer.
- Malformed score vectors (wrong length, or any entry above `SCORE_SCALE`) finalize as `Failed` instead of reverting; one interpreter (`_scoreVector`) serves finalize and both sibling scans.
- Deadline rule: `startPreparedSubmission` must happen before the deadline; windowed `prepareSubmission` requires the window to end before the deadline.
- Windowed priority: same-hunter resubmissions and expired never-started submissions no longer block; a same-hunter in-flight evaluation blocks creator approval; a blocked passing finalize reverts (retryable).
- Submission bounds split by bounty kind: non-windowed bounties have NO prepare cap and their scans walk a per-bounty PENDING LIST of in-flight evaluations, capped at `MAX_ACTIVE_EVALUATIONS = 256` at start; windowed bounties keep `MAX_SUBMISSIONS_PER_BOUNTY = 128` on prepares. Payout gas cap `PAYOUT_GAS_LIMIT = 120000` and inline-refund gas cap `INLINE_REFUND_GAS_LIMIT = 200000`; CID shape validation; creator-owned oracle settings; leftover prepay refunded to the funder.

New/changed revert strings: `deadline passed`, `window would end after deadline`, `earlier submission pending - retry after it resolves`, `result available - use finalizeSubmission`, `evaluation not settled`, `submission limit reached` (windowed bounties only), `evaluation slots full - retry later` (start, while 256 evaluations are in flight — retry after any resolves), `no oracle result - use failTimedOutSubmission` (finalize on a round that is settled with no result — force-fail instead; `Verdikta not ready` now means only "no answer yet"), `already started or resolved` (start on a submission that is not Prepared — replaces `not prepared`), `bounty not open` (now also from `closeExpiredBounty`, which used to say `not open`), `bad hunterCid`, `bad evaluationCid`, `bad oracle fee`, `oracle fee above ceiling`, `base cost must be below fee`, `bad fee scaling`, `bad alpha`. Gone: `submitted too late`, `timeout not reached`, `empty hunterCid`, `empty evaluationCid`.

#### The `SubmissionPrepared` field reorder (event-signature change)

The contract emits `SubmissionPrepared(bountyId, submissionId, hunter, evalWallet, ethMaxBudget, evaluationCid)` — static fields first, the dynamic string **last** — so even a naive `(address,uint256)` decode of the log data reads `ethMaxBudget` correctly instead of `96` (the string's offset word). Contracts deployed before September 2026 emitted the old order (`…, evalWallet, evaluationCid, ethMaxBudget`).

| | signature | topic0 |
|---|---|---|
| current | `SubmissionPrepared(uint256,uint256,address,address,uint256,string)` | `0x147341637c0b8d941e61a743cd410afff8526bec154904bb54f857b8f59cd6ca` |
| pre-Sept-2026 (old) | `SubmissionPrepared(uint256,uint256,address,address,string,uint256)` | `0xdf7bc54a6444d008cf527c6a4bcdfa31d05db5a08445b8dd2eb3a05f24b67437` |

Every off-chain decoder (`server/utils/submissionEvents.js` is the canonical descriptor; `server/utils/contractService.js`, `server/routes/jobRoutes.js`, `server/scripts/submitToBounties.js`, `client/src/services/contractService.js`, the Blockchain/Agents page samples) carries the current fragment. Anything that still reads an **old** contract's logs (e.g. closing out its remaining bounties) must use the old fragment for that address — the sync service is keyed per network, not per address, so finish the old contract's business before switching or special-case it.

> **Single source of truth:** the running website's `/analytics` page always shows the live BountyEscrow address from the backend's runtime config. If any doc disagrees with it, the doc is stale. Only `README.md`'s "Contract Addresses" section has a hardcoded snapshot — all other docs and examples point at `.env.example` files or `/analytics`, so they self-update.

### Backend (production)
The server is started by `startServer.sh` / `restartServer.sh` in the `server/` directory. It writes a PID file (`server-base.pid` or `server-base-sepolia.pid`) and logs to `server-base.log` / `server-base-sepolia.log`. Use `stopServer.sh` to shut down.

### Frontend (production)
```bash
cd client
npm run build              # produces dist/
# Serve dist/ via nginx or any static host
```

The production hosts behind nginx are `bounties.verdikta.org` (mainnet) and `bounties-testnet.verdikta.org` (testnet).

---

## Common Tasks

### Add a new API endpoint
1. Add the route handler in `server/routes/jobRoutes.js` (or wherever it logically belongs)
2. Document it in `server/routes/agentRoutes.js` — both the `/agents.txt` text and the `/api/docs` JSON `endpoints` array
3. If it returns or accepts new data fields, update `client/src/services/api.js`
4. Test with curl before wiring it up to the UI

### Add a new root-level discovery file (e.g. `llms.txt`, `ai.txt`, `humans.txt`)
Serving a file at the domain root crosses **three independent layers**, each of which rejects the request differently if missed. All three are required — fixing one at a time is misleading because the symptoms overlap (a missing route returns `401`, not `404`, because it falls through to the auth catch-all; only the missing nginx rule returns `404`).
1. **Route** — add the handler in `server/routes/agentRoutes.js` (alongside `/agents.txt`, `/feed.xml`), then restart the backend.
2. **Auth allowlist** — add the path to `PUBLIC_PATHS` in `server/middleware/clientIdentification.js`. The global `clientIdentification` middleware blocks anything not listed with a `401 AUTH_MISSING`, *before* the request reaches the route.
3. **nginx** — add an exact-match `location = /yourfile.ext { proxy_pass http://localhost:<5005|5006>/yourfile.ext; ... }` block to **both** active configs in `/etc/nginx/sites-available/` (`bounties.verdikta.org` → 5005, `bounties-testnet.verdikta.org` → 5006), then `nginx -t && systemctl reload nginx`. Without it, nginx's `location ~* \.[a-z0-9]+$` rule tries to serve the file from the static SPA build and 404s — the request never reaches the backend. Note: these nginx files live outside the repo (the `deploy/nginx/` copies are stale and not authoritative).

Verify against the **public** URL, not just `localhost:5005` — they exercise different layers (`curl localhost` skips nginx entirely).

### Add a new submission status
1. Update `client/src/utils/statusDisplay.js` (`SubmissionStatus` enum, `PENDING_STATUSES`, status config, helpers)
2. Update `client/src/services/contractService.js` `statusMap` array in `getSubmission()`
3. Update `server/utils/contractService.js` `statusMap` in `getSubmissions()`
4. Update `server/utils/syncService.js` — both `syncSubmissions()` status mapping and the `SubmissionFinalized` event handler's `onChainStatus` array
5. Update `server/routes/jobRoutes.js` `/diagnose` endpoint's `statusNames` array
6. Document in `server/routes/agentRoutes.js` (`agents.txt` status mapping table and `/api/docs` `statusMapping`)
7. Update the in-app `/blockchain` page status table in `client/src/pages/Blockchain.jsx`

### Add a new bounty field
1. Add to the contract struct and `getBounty()` ABI in both `client/src/services/contractService.js` and `server/utils/contractService.js`
2. Extract the field in server `getBounty()` and store it in the job object via `syncService.js` `addJobFromBlockchain()`
3. **Add the field to the `jobSummaries` mapper in `server/routes/jobRoutes.js` `GET /api/jobs` (around line 1826).** The list endpoint returns a *whitelist* of fields, not the full job object — any field not in this mapper will be invisible to the frontend's bounty list view, even if it's correctly stored in `jobs.json`. This is a common pitfall.
4. If the field is set at create time, also update the BountyCreated event handler in `server/utils/syncService.js` (line ~517, the "linking pending job" branch). When an API-created job is linked to its on-chain counterpart, the linker must pull chain-only fields from `getBounty()` — otherwise the field stays `undefined` until someone manually refreshes the bounty.
5. If needed in the create flow, accept it in `server/routes/jobRoutes.js` POST `/api/jobs/create` and pass through to `client/src/services/contractService.js` `createBounty()` and `server/scripts/createBounties.js`.

### Migrate local job data
**Always stop the server first** — the sync service will overwrite manual changes. Edit `server/data/{network}/jobs.json`, then restart.

---

## Common Tasks (cont.)

### Reclaiming funds from an expired bounty

After a bounty's deadline passes, escrowed ETH stays locked until someone calls `closeExpiredBounty(bountyId)`. **This does not happen automatically.** If any submission is still in `PendingVerdikta` status, the close call reverts and those submissions must be resolved first: `finalizeSubmission` if the oracle responded, `failTimedOutSubmission` if it never did. Submissions that were prepared but never started do not block closing — after the deadline they can no longer be started (see [Submission timing and priority rules](#submission-timing-and-priority-rules)).

The website does this for the creator via the **My Bounties** action-required banner and the bounty page's **Close Expired Bounty** button. The flow below is for scripts, agents, and integrators that drive it through the API.

#### 1. Discover which bounties need attention (creator-scoped)

```
GET /api/jobs/mine/action-required?creator=0x<creator>
```

Response shape:

```jsonc
{
  "success": true,
  "creator": "0x...",
  "count": 2,
  "readyToCloseCount": 1,
  "blockedCount": 1,
  "totalReclaimableWei": "150000000000000000",
  "totalReclaimableEth": "0.15",
  "bounties": [
    {
      "jobId": 41,
      "title": "...",
      "bountyAmount": "0.05",
      "deadline": 1717000000,
      "expiredMinutesAgo": 90,
      "canClose": true,
      "blockedBy": null,
      "pendingSubmissions": []
    },
    {
      "jobId": 47,
      "canClose": false,
      "blockedBy": "1 submission(s) still pending evaluation",
      "pendingSubmissions": [
        { "submissionId": 0, "hunter": "0x...", "submittedAt": 1716998800,
          "ageMinutes": 22, "timeoutEligible": true }
      ]
    }
  ]
}
```

`timeoutEligible` mirrors the contract's own gate: the server reads the aggregator and reports `true` only when the round has no result AND is settled (or its 300-second response timeout has elapsed since the start transaction). When the round has a result the entry carries `hasResult: true` instead — call `/finalize` for it. It's safe to poll this endpoint — it's read-only and small.

For a system-wide view (all creators) use `GET /api/jobs/admin/expired` instead.

#### 2. Clear blocking submissions

For each entry in `pendingSubmissions` where `timeoutEligible: true`:

```
POST /api/jobs/:jobId/submissions/:submissionId/timeout
```

Returns calldata for `failTimedOutSubmission(bountyId, submissionId)`. Sign and submit from any wallet (anyone may call). This is a last resort — whenever the oracle has actually responded, use `finalizeSubmission()` (the `/finalize` endpoint), which pays or fails the submission and returns the unspent ETH prepay to whoever funded the start (`funder`).

On-chain, `failTimedOutSubmission` has **no timer**. It first tries to settle the oracle round on the aggregator (`finalizeEvaluationTimeout`), then succeeds only if the round is settled **and** has no valid result. It also refunds the unspent prepay. Otherwise it reverts with one of:

- `result available - use finalizeSubmission` — the oracle did respond (possibly late). Call `/finalize` instead. A passing score can never be discarded by force-fail.
- `evaluation not settled` — the round is still open on the aggregator. Its response timeout is 300 seconds from `startPreparedSubmission`, so wait at least 5 minutes after the *start* transaction and retry.

The endpoint's own pre-check (`canTimeout`) applies the same aggregator-based rule before returning calldata: `canTimeout:false` with `error: "Evaluation not settled"` (the `hint` gives the unix time the aggregator's timeout elapses) while the round is open, or `canTimeout:false, canFinalize:true` with `error: "Oracle result available - use finalizeSubmission"` when the oracle responded. The `forceFail` object in the response carries the raw gate (`hasResult`, `eligible`, `reason`, `secondsUntilTimeout`). Either way nothing is lost — wait and retry, or finalize.

#### 3. Close the bounty

Once `canClose` is `true`:

```
POST /api/jobs/:jobId/close
```

Returns calldata for `closeExpiredBounty(bountyId)`. Sign and submit from any wallet (anyone may call). ETH is returned to the creator.

#### Common failure modes

- **`closeExpiredBounty` reverts with no clear message:** a submission re-entered `PendingVerdikta` between your check and the close call. Re-query the action-required endpoint and timeout anything new.
- **`failTimedOutSubmission` reverts with `evaluation not settled`:** the oracle round is still open on the aggregator (less than ~5 minutes since the start transaction). Wait and retry.
- **`failTimedOutSubmission` reverts with `result available - use finalizeSubmission`:** the oracle responded after all. Call `/finalize` — that resolves the submission (pay or fail) and unblocks the close.
- **`finalizeSubmission` reverts with `earlier submission pending - retry after it resolves`:** any bounty; another hunter's earlier submission is still `PendingVerdikta`. Its evaluation is often already over and nobody finalized it (its `nextAction` is `FINALIZE` / `FORCE_FAIL`). Anyone may resolve it, then retry. `POST /finalize` and `/diagnose` list these in `blockedBy[]` with the transaction for each; the website's Finalize button offers to send them first.
- **Bounty not in the list at all:** the job is not linked on-chain (`onChain === false` and not synced). There is no escrow to reclaim. Such an **un-funded orphan** (created by `POST /jobs/create` without a following `createBounty`) can be removed actively — it is not silently garbage-collected: hard-delete it with `DELETE /api/jobs/admin/:jobId`, or soft-hide it with `PATCH /api/jobs/admin/:jobId/status` `{ "status": "CANCELLED" }`. The delete is guarded (refuses on-chain jobs and jobs younger than 5 min) and does **not** roll back the auto-incremented `jobId` counter. Note this is distinct from the *old-contract* orphans handled by `GET/DELETE /api/jobs/admin/orphans`. See `CLAUDE.md` "Sync service orphan race" for the underlying issue.

### Submission timing and priority rules

These are enforced by `BountyEscrow.sol` and are the source of truth for every lifecycle description in the app.

**Deadline.** Everything a hunter must do happens before `submissionDeadline`:

- `prepareSubmission` requires `block.timestamp < submissionDeadline` (`deadline passed`).
- `startPreparedSubmission` requires the same (`deadline passed`). A submission that was prepared but not started by the deadline is dead; it does not block `closeExpiredBounty`.
- `finalizeSubmission` and `failTimedOutSubmission` may run after the deadline. An in-flight evaluation (`PendingVerdikta`) blocks closing until it is resolved (`activeEvaluations` counter).

**Creator window.** `creatorAssessmentWindowSize` is a *per-submission* timer that starts at prepare: `creatorWindowEnd = submittedAt + creatorAssessmentWindowSize`. During the window only the creator can act (`creatorApproveSubmission`); `startPreparedSubmission` reverts `creator window still open`. After it, anyone may fund and start arbitration. Because the start must also be before the deadline, windowed `prepareSubmission` requires `submittedAt + creatorAssessmentWindowSize + 1 < submissionDeadline` (`window would end after deadline`). The effective prepare cutoff on a windowed bounty is therefore `submissionDeadline − creatorAssessmentWindowSize − 2`; read it from `prepareCutoff(bountyId)` (also on `/onchain-status`) rather than computing it. Every window closes before the deadline, so closing at the deadline can never cut off a hunter who is still waiting on the creator.

**Payout priority (every bounty)** (`_hasEarlierPendingByOther`). Payout priority is by submission index among submissions in evaluation: a passing submission is paid only once every earlier-submitted (lower-index) submission by another hunter has left evaluation — until then `finalizeSubmission` reverts `earlier submission pending - retry after it resolves` (a retry, not a failure; the result is kept). If an earlier one passes, it takes the bounty. This protects an original against a copy of its public work CID submitted later, whatever order the oracle rounds complete in. Only submissions in evaluation hold priority (a prepared-but-unstarted one holds none — start promptly after preparing), and a hunter's own earlier submission never blocks them. The check walks the per-bounty pending list only (no aggregator call), so it is order-independent: whoever calls finalize, in whatever order, the same submission is paid. The wait is bounded by the aggregator's response timeout (anyone may force-fail a dead round), and no new earlier round can appear once a result is passing (`_requireNoPassingSubmission` refuses further starts). Residual: if the original's own round fails or times out, a later copy can still win.

**Creator-approval priority on windowed bounties** (`_hasEarlierUnresolvedSubmission`). A lower-index submission blocks creator approval (`earlier submission unresolved`) of a higher-index one only while it can still win:

- it is `PendingVerdikta` (evaluation in flight — temporary, always resolves), or
- it is `PendingCreatorApproval` and its window is still open.

It does **not** block when its window expired and nobody started arbitration (preparing costs only gas, so such a submission would otherwise lock out everyone behind it for free), or when it belongs to the same hunter and is sitting in its window (a resubmission supersedes that hunter's earlier versions; the usual windowed bounty is targeted, so the creator can approve the revision right away and nobody pays to arbitrate the stale one).

The same-hunter exemption is deliberately narrower for `PendingVerdikta`: a same-hunter sibling that is **in evaluation** blocks `creatorApproveSubmission` (`earlier submission unresolved`), whereas payout priority (above) exempts same-hunter siblings, so it does not block the hunter's own `finalizeSubmission`. Reason: an in-flight (possibly already passing) evaluation is the hunter's live claim to `arbiterDeterminationPayment`; if the creator could approve a newer version for `creatorDeterminationPayment` (which may be far smaller) the bounty would become Awarded and the earlier version would finalize to `PassedUnpaid`, voiding a payout the hunter already paid the oracle to earn. Finalize of the newer version by the hunter is harmless (same payee, same rate). The creator may approve the revision after the earlier evaluation has resolved as failed; nobody is forced to pay a prepay.

When a passing `finalizeSubmission` on any bounty is blocked by another hunter's earlier in-flight evaluation, it **reverts** with `earlier submission pending - retry after it resolves`. Nothing is written; the submission stays `PendingVerdikta` and finalize is retried once the earlier one finalizes or is force-failed. (It used to write terminal `PassedUnpaid`, which could leave a passing submission unpaid forever.) `PassedUnpaid` is now written only when the bounty is already awarded or closed.

**Submission bounds.** Two different bounds, chosen so that gas-only junk can never lock a bounty *and* cannot cheaply shut honest hunters out.

- *Non-windowed bounties: no cap on prepared submissions.* The contract keeps a per-bounty **pending list** of the submissions currently in evaluation (pushed at start, swap-removed at finalize / force-fail; read it with `pendingSubmissionIds(bountyId)`, its length is `activeEvaluations(bountyId)`). The start-time scan ("has another submission already passed?") and the payout tie-break scan walk that list only, so never-started submissions cost nothing on-chain, however many there are (measured: a passing finalize with 200 junk siblings costs the same as with none). What is capped is concurrency: `MAX_ACTIVE_EVALUATIONS = 256`. `startPreparedSubmission` reverts `evaluation slots full - retry later` while the list is full; a slot frees as soon as any in-flight round resolves (result, or timeout + `failTimedOutSubmission`, both callable by anyone). A slot is never free to hold: every start prepays an oracle round whose per-arbiter base fees are consumed at dispatch and not refunded, so keeping a bounty full costs real ETH every response-timeout period. Worst-case scan at the cap (255 in-flight siblings with results) is about 5.4M gas per start or finalize.
- *Windowed bounties: `MAX_SUBMISSIONS_PER_BOUNTY = 128` on prepares.* Their priority scan (`_hasEarlierUnresolvedSubmission`) must see in-window, never-started entries, so it walks the full array and prepares are capped instead; `prepareSubmission` reverts `submission limit reached` once a windowed bounty has 128 submissions in any state, counting every hunter. On a **targeted** windowed bounty only the target can prepare, so the cap can only be self-inflicted. On an **open** windowed bounty anyone can fill it for gas alone and shut other hunters out until the deadline — a known, accepted weakness of that unusual configuration; target the bounty or drop the window if it matters. A full bounty only rejects new prepares: existing submissions still resolve, and the creator can still close at the deadline.
- *Off-chain consequence:* a non-windowed bounty can hold thousands of submissions. Page with `getSubmissionsPage(bountyId, start, count)` (≤ 100 per call) rather than `getSubmissions(bountyId)`, and treat the on-chain `submissions` counter as "prepared, including junk".

**Why index priority and not "first to complete".** The work CID is public from the moment `prepareSubmission` lands, so on an open bounty anyone can prepare and start a copy of it at a higher index. Two oracle rounds over identical content complete in random order; a "first to complete wins" rule would hand the copier the bounty about half the time (more, with several copies). Index priority makes the earlier submitter win whenever their own round passes. The cost is that a later passing submission may have to retry finalize for up to one response timeout while an earlier in-flight round settles.

**Oracle settings belong to the creator** (`Bounty.oracle`, set in `createBounty`, validated by `MAX_ALPHA = 1000`, `MAX_FEE_SCALING_FACTOR = 1000`, fee ≤ `verdikta.maxOracleFee()`, base cost < fee, scaling ≥ 1). They are used verbatim for every evaluation of the bounty; `prepareSubmission` takes only the two CIDs and the addendum forwarded to the aggregator is the constant `ADDENDUM = ""`. Why the creator and not the hunter: the aggregator's keeper treats `maxOracleFee` as an eligibility filter (an arbiter is selectable only if its fee ≤ the request's ceiling), and `estimatedBaseCost` / `maxFeeBasedScaling` weight selection by price — whoever sets them can shrink or tilt the jury toward nodes they run. A hunter can see a bounty's settings before committing work and walk away (the website's validate check warns on a small eligible pool, a dominant operator, an enabled price boost or an extreme alpha); a creator cannot inspect a hunter. Why the addendum is empty for everyone: it is appended to the query the arbiters see, and the creator's evaluation package is the whole query. `ethMaxBudget = maxTotalFee(bounty.oracle.maxOracleFee)` is identical for every submission to a bounty. The residual lever is the class itself (a class served by one operator is that operator's private jury) — visible on the bounty.

**Prepay refreshed at start, settings clamped to the live ceiling** (`requiredPrepay`, `effectiveOracleParams`, `_effectiveOracle`). Upstream configuration policy: the aggregator's fee ceiling, arbiters polled, bonus multiplier, cluster size and response timeout are owner-settable and may change after a bounty is created; creation validates the creator's settings only against the ceiling of that moment. At start the escrow reads the live ceiling and clamps the bounty's settings to what the aggregator will accept: `maxOracleFee → min(fee, ceiling)` (mirroring the aggregator's own clamp), and `estimatedBaseCost → effectiveFee − 1` if it no longer sits strictly below the effective fee (the keeper requires `base < fee`; without this a lowered ceiling would make every start revert with "base cost must be less than max fee" and strand prepared submissions). `alpha` and `maxFeeBasedScaling` pass through unchanged. `requiredPrepay()` is quoted from the effective fee, `startPreparedSubmission` requires `msg.value` to match it and stores what was actually prepaid, and `effectiveOracleParams(bountyId)` shows what will be forwarded; the stored `Bounty.oracle` is never modified. `prepareSubmission`'s `ethMaxBudget` is therefore only an estimate. Net effect: no aggregator configuration change can strand a prepared submission — at worst the creator's price boost is softened when the ceiling makes their exact base cost impossible.

**Funder refund** (`Submission.funder`). `startPreparedSubmission` records `msg.sender` as the funder; `_refundLeftoverEth` (from finalize and force-fail) returns the unspent prepay to the funder, which is the hunter in the common case and the creator or a third party for an expired-window start.

**Refund recovery is separate from resolution** (`_refundLeftoverEth`, `recoverLeftoverEth`, event `RefundDeferred`). At the end of `finalizeSubmission` and `failTimedOutSubmission` the escrow tries to recover the unspent oracle prepay (wallet → aggregator `withdrawEth` → wallet → escrow → funder) — but inside a `try/catch` AND with at most `INLINE_REFUND_GAS_LIMIT = 200000` gas (measured cost of the path is ~30k against the mock, well under 100k live). The cap matters because the wallet forwards into the aggregator: without it an aggregator withdraw that burned gas would leave the transaction only 1/64 of its budget after the catch (EIP-150), possibly too little to emit `RefundDeferred` and return, so the resolution would revert anyway. `recoverLeftoverEth` (the retry) forwards full gas. If that chain reverts (an aggregator upgrade, a paused withdrawal, a changed accounting rule), the status change and the payout still stand and `RefundDeferred(bountyId, submissionId)` is emitted instead of `EthRefunded`. Anyone can then call `recoverLeftoverEth(bountyId, submissionId)` on a resolved submission (Failed / PassedPaid / PassedUnpaid): it re-runs the wallet's idempotent refund, pays the funder, and reverts with the underlying reason if it still cannot (or `nothing to recover` if there is nothing). Because the wallet's refund sweeps its whole balance, this also recovers ETH that reaches a wallet after resolution. In the normal case the funder is refunded inline, in the resolving transaction, exactly as before; a resolution can never be blocked by the refund path.

**Force-fail** (`failTimedOutSubmission`). No timer. Requires `PendingVerdikta`, then: try `finalizeEvaluationTimeout` on the aggregator (ignored if it reverts), require `getEvaluation(aggId).exists == false` (`result available - use finalizeSubmission`), require `getAggregationStatus(aggId).isComplete == true` (`evaluation not settled`). On success: `Failed`, the pending list shrinks (`activeEvaluations` decrements), unspent prepay refunded to the funder (the hunter in the common case). The aggregator's `responseTimeoutSeconds` is currently 300 on both networks, so the practical rule is "at least 5 minutes after the start tx and the oracle never responded".

**Score semantics** (`_scoreVector`, `SCORE_SCALE = 1_000_000`, `SCORE_DIVISOR = 10_000`). One interpreter serves `finalizeSubmission` and both sibling scans (`_requireNoPassingSubmission` at start, `_hasOtherPassingSubmission` at payout), so eligibility and payout can never disagree about what a result means. A vector is valid only if it has exactly two entries (`[DONT_FUND, FUND]`) and each is at most `SCORE_SCALE`; scores are normalized to 0–100 by `SCORE_DIVISOR` and compared to the bounty threshold (`>=` passes). The sum is deliberately not checked (aggregator rounding). An invalid vector never reverts: finalize records it as `Failed` with `acceptance = rejection = 0` and refunds the prepay (`SubmissionFinalized` carries `passed = false`), and the scans treat it as not passing so a corrupt sibling result never blocks a start or a payout. Out-of-range entries are rejected rather than clamped — clamping would have turned a corrupt `[0, 2_000_000]` into a 100% pass and a payout.

### Driving the contract without the API

Agents can run the whole lifecycle against `BountyEscrow` alone — the API is a convenience, not a dependency. One ABI caveat: the read-only views in the table below (`getSubmissions`, `getSubmissionsPage`, `getBounties`, `getOracleResult`, `nextAction`, `prepareCutoff`, `canBeClosed`, `isAcceptingSubmissions`, `getEffectiveBountyStatus`) are implemented in a companion contract, `BountyEscrowLens`, and answered **at the escrow address** by the escrow's fallback (a `STATICCALL`-guarded `delegatecall`; no state change is possible; the lens address is an immutable with no setter — not a proxy, no owner). Calls, return values and revert reasons are indistinguishable from views in the escrow itself. But an ABI built from the escrow's verified source or its compiled artifact will not list them — use the human-readable fragments in this guide / the `/agents` page, or the merged ABI exported by `onchain/deploy/helpers.js`. A mistyped function name now reverts `unknown function` instead of with empty data. What the contract gives you:

| Need | Call |
|---|---|
| List bounties | `bountyCount()`, `getBounties(start, count)` (≤ 100 per call; page with `start += result.length`) — each `Bounty` carries the creator's `oracle` settings |
| Read a bounty's submissions | `getSubmissionsPage(bountyId, start, count)` (≤ 100 per call; page with `start += result.length`) — `getSubmissions(bountyId)` returns all at once, fine for a handful, risky on a junk-flooded non-windowed bounty; `pendingSubmissionIds(bountyId)` lists the ids in evaluation |
| Can I still prepare? | `prepareCutoff(bountyId)` — last unix second `prepareSubmission` succeeds (windowed: `deadline − window − 2`); `isAcceptingSubmissions(bountyId)` |
| How much to attach at start | `requiredPrepay(bountyId)` — read right before sending; `effectiveOracleParams(bountyId)` shows the fee block actually forwarded (clamped to the aggregator's live ceiling) |
| Is the oracle done? | `getOracleResult(bountyId, submissionId)` → `started, hasResult, settled, failed, scores, justificationCids, startTimestamp` — no aggregator ABI needed |
| What should I do now? | `nextAction(bountyId, submissionId)` → `START` \| `AWAIT_SLOT` \| `AWAIT_CREATOR` \| `AWAIT_ORACLE` \| `AWAIT_EARLIER` \| `FINALIZE` \| `FORCE_FAIL` \| `RECOVER_REFUND` \| `DONE` \| `DEAD` (the on-chain equivalent of `/diagnose`). Every label names the call that will SUCCEED now: `AWAIT_SLOT` = start would hit the 256 concurrency cap; `AWAIT_EARLIER` = a passing result that must wait for an earlier in-flight submission (payout priority); `DEAD` also covers "an in-flight submission already passes" (start would revert); `FORCE_FAIL` vs `FINALIZE` past the timeout follows whether enough late reveals arrived |
| Bounty state | `getEffectiveBountyStatus(bountyId)` → `OPEN` \| `EXPIRED` \| `AWARDED` \| `CLOSED`; `canBeClosed(bountyId)`. `EXPIRED` (Open past the deadline) still **pays** a passing in-flight submission on finalize — only `AWARDED`/`CLOSED` are terminal |
| Money owed to me | `withdrawable(address)` → `withdraw()`; deferred prepay → `recoverLeftoverEth` |

What the contract cannot give you, and the API otherwise does:

- **IPFS pinning.** Evaluation packages and work archives must be pinned by you (Pinata, web3.storage, a local node).
- **The evaluation package format** (creator side): a ZIP with `manifest.json`, `primary_query.json` and the rubric, where the query template must match what the oracle nodes parse — deviations fail silently. `server/utils/archiveGenerator.js` is the reference builder; `POST /api/jobs/validate` checks a CID without side effects.
- **The work archive format** (hunter side): a ZIP with `manifest.json` (`additional[]` listing the files), `primary_query.json` (`{ query: <narrative>, references: [...] }`) and the files under `submission/`. `createHunterSubmissionCIDArchive` in the same file is the reference.
- **Human metadata** (title, description, USD estimates) — the API stores it off-chain; on-chain there is only the package CID.

Revert reasons are plain strings (listed above under the breaking-release notes); decode them from the receipt, not from ethers' formatted error.

## Debugging

### Sync service not picking up new bounties
- Check `server/server.log` for sync errors
- Confirm `USE_BLOCKCHAIN_SYNC=true` in `.env`
- Verify `BOUNTY_ESCROW_ADDRESS_*` matches the network you're querying
- Force a refresh: `POST /api/jobs/:jobId/refresh`

### Submission stuck in PENDING_EVALUATION
- Use `GET /api/jobs/:jobId/submissions/:subId/diagnose` for actionable analysis
- If the oracle never responded and the aggregator round has timed out (~5 min after the start tx), anyone can call `failTimedOutSubmission` (or use `/submissions/:subId/timeout`). If it reverts with `result available - use finalizeSubmission`, the oracle did respond — finalize instead.
- If the parent bounty is also expired and you need to reclaim creator funds, see [Reclaiming funds from an expired bounty](#reclaiming-funds-from-an-expired-bounty)

### Diagnosing ID drift between API and on-chain (BOUNTY_NOT_ONCHAIN)

The API jobId and the on-chain bountyId must match for any submission API call to route correctly. They normally do — `PATCH /api/jobs/:jobId/bountyId` reconciles the local jobId to match the on-chain bountyId. The drift cases are:

- `/api/jobs/create` was called but `PATCH /bountyId` was skipped (link step missing).
- Multiple `/api/jobs/create` calls advanced the API counter past the on-chain `bountyCount`.
- The on-chain `createBounty` was never made (job exists locally, no escrow).

The server now blocks calldata endpoints in any of these states with `400 BOUNTY_NOT_ONCHAIN`, and the error body's `extra.recoveryEndpoints` points at the two diagnostic endpoints below.

**1. Discover which API jobId corresponds to your on-chain bounty:**

```
GET /api/jobs/lookup?txHash=0x<your-createBounty-tx>
GET /api/jobs/lookup?bountyId=<n>
GET /api/jobs/lookup?evaluationCid=<cid>
```

Returns `{ success, lookedUpBy, job, linkage }`. The 404 response distinguishes "bounty does not exist on chain" (`onChainExists: false`) from "exists but local sync hasn't picked it up yet" (`onChainExists: true`) — the latter is just a timing issue; call `POST /api/jobs/sync/now` and retry.

**2. Diagnose linkage health (one-call agent-friendly check):**

```
GET /api/jobs/:bountyId/onchain-status
```

> **Path param gotcha:** the `:id` here is the **on-chain bountyId**, not the API jobId. They are equal for `linked` jobs, but during drift you may be holding an API jobId that points to a different (or no) on-chain bounty. Always run `/api/jobs/lookup` first if you're not sure. The endpoint's 404 response cross-checks for a local API job at the same id and includes a `fix` pointing at `/lookup` when it finds one.

The `linkage` field is a structured verdict — `state` is one of:

| state | meaning | what to do |
| --- | --- | --- |
| `linked` | jobId == on-chain bountyId, sync confirmed | nothing — safe to use |
| `patched-not-synced` | PATCH ran; sync will confirm shortly | nothing — calldata endpoints already work |
| `not-on-chain` | API-only, never linked | follow `linkage.fix` (createBounty + PATCH) |
| `mismatch` | local jobId disagrees with on-chain bountyId | route via `linkage.correctJobId` instead |
| `untracked` | bounty exists on-chain, no local job | `POST /api/jobs/sync/now`, then retry |

**3. Do NOT compensate by spending more on-chain.** Creating an additional bounty to "fix" the alignment makes it worse, not better. The fix is always either the lookup endpoint (find the right jobId) or the PATCH endpoint (link the existing one).

### ETH prepay errors at startPreparedSubmission
- `startPreparedSubmission(uint256 bountyId, uint256 submissionId)` is **payable** — the funder attaches `requiredPrepay(bountyId)` as `msg.value`, read live from the escrow. There is no LINK token, ERC-20 approval, or allowance step.
- Attach exactly the `ethMaxBudget` (raw wei) from the `SubmissionPrepared` event as `msg.value`. Too little ETH and the call reverts; any unspent prepay is automatically refunded when the submission finalizes (or on `failTimedOutSubmission`).
- **The event value is an estimate.** `ethMaxBudget` in `SubmissionPrepared` (second data word, before the dynamic `string evaluationCid`) is the aggregator's `maxTotalFee` for the bounty's fee *at prepare time*. `startPreparedSubmission` recomputes it live and requires `msg.value` to equal that (`wrong eth amount` otherwise), so a change in aggregator parameters between prepare and start never strands a prepared submission. Read `requiredPrepay(bountyId)` right before starting — the `/start` calldata endpoint's `transaction.value` and the website do exactly that. It is the same for every submission to a bounty at any given moment.
- The per-oracle fee is the bounty's `oracle.maxOracleFee` (API default 0.00002 ETH; on-chain ceiling 0.0004 ETH); the worst-case prepay (`ethMaxBudget` = maxTotalFee) is 12× that, ~0.00024 ETH at the default.

### Finding the SubmissionPrepared log (topic0)
To pull the event off a step-1 receipt you first have to match the log by `topic0`:

```
topic0 = 0x147341637c0b8d941e61a743cd410afff8526bec154904bb54f857b8f59cd6ca
       = keccak256("SubmissionPrepared(uint256,uint256,address,address,uint256,string)")
```

That **is** the plain keccak256 of the signature — there is no hidden discrepancy between the deployed contract and the naive computation. If your computed hash disagrees, your signature string is wrong; the usual cause is using the pre-September-2026 order (`…,string,uint256`) or dropping a field, which yields `0x87362e68…` and matches zero logs. (It's the same root cause as the decoding gotcha above: an ABI copy that predates the `ethMaxBudget` field.)

Rather than typing either the signature or the hash, take both from the API — `/submit/prepare` and `/submit/bundle` return an `event` object:

```json
{
  "event": {
    "name": "SubmissionPrepared",
    "signature": "SubmissionPrepared(uint256,uint256,address,address,uint256,string)",
    "topic0": "0x147341637c0b8d941e61a743cd410afff8526bec154904bb54f857b8f59cd6ca",
    "abi": "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)",
    "indexedFields": ["bountyId", "submissionId", "hunter"],
    "dataFields": ["evalWallet", "ethMaxBudget", "evaluationCid"]
  }
}
```

Filter the receipt logs on `event.topic0`, decode with `event.abi`. Both track the deployed contract, so they stay correct across the queued field reorder (see the comment above `event SubmissionPrepared` in `onchain/contracts/BountyEscrow.sol`).

### Response shape gotcha: `hunterCid` is nested
`POST /api/jobs/:id/submit` returns the CID under `submission`, not at the top level:

```json
{ "success": true, "hunterCid": "Qm…", "submission": { "hunter": "0x…", "hunterCid": "Qm…", "…": "…" } }
```

The top-level `hunterCid` is an alias added because callers kept reading it there and silently carrying `undefined` into `/submit/prepare`. Either key works; `submission.hunterCid` is the original.

### Hot tips
- The `/blockchain` and `/agents` in-app pages are the canonical reference for contract ABIs and endpoint shapes — they're tested every time the page renders
- Memory of project gotchas lives in `CLAUDE.md` and the agent memory system

---

## Project Conventions

- **Status display:** never hard-code status labels in components — always use helpers from `client/src/utils/statusDisplay.js`
- **IDs:** `jobId` is the on-chain bounty ID (0-indexed). Don't introduce a separate `onChainId` field.
- **Storage:** server/data/{network}/jobs.json is the single source for all locally-cached bounty data
- **Sync:** never modify `jobs.json` while the server is running — sync will overwrite
- **Commits:** small, descriptive, present tense ("Add windowed bounty form" not "Added"). Co-author tag for AI assistance is fine.
