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
├── shared/      # code used by server and client (classPresets.js: size classes)
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

Deployment scripts: `deploy/01_deploy_bounty.js` (needs `VERDIKTA_AGGREGATOR_<NETWORK>`, see [Smart contracts](#smart-contracts) under Deployment). Convenience wrappers: `deploy_testnet.sh`, `deploy_mainnet.sh`.

---

## Environment Configuration

### Server (`server/.env`)

Start from the `server/.env.example` template and fill in the values. Required keys include:

- `NETWORK` — `base-sepolia` or `base`
- `PORT` — default 5005
- `IPFS_PINNING_KEY` — Pinata JWT
- `RPC_PROVIDER_URL` — RPC endpoint for the active network
- `BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA` and `BOUNTY_ESCROW_ADDRESS_BASE` — BountyEscrow contract per network. **Get the current values from the running website's Analytics page** (`/analytics` → System Health → Contract Addresses) or from the [Contract Addresses](README.md#contract-addresses) section of the README.
- `FRONTEND_CLIENT_KEY` — must match `VITE_CLIENT_KEY` on the client
- `FRONTEND_ALLOWED_ORIGINS` — comma-separated allowed origins
- `RECEIPT_SALT` — random string for pseudonymous receipt IDs
- `USE_BLOCKCHAIN_SYNC=true` — enable the 2-minute polling sync service
- `SYNC_INTERVAL_MINUTES=2`

Optional, for v2:

- `KEEPER_PRIVATE_KEY` — a funded hot wallet for the [round keeper](#round-keeper). Keep only a little ETH on it. Empty: no keeper; every round step is then left to hunters and others (the calldata endpoints).
- `VERDIKTA_AGGREGATOR_BASE_SEPOLIA` / `VERDIKTA_AGGREGATOR_BASE` — the v2 aggregator (one serves every jury size). Normally read from the escrow (`aggregator()`) at startup; set these only to override. `VERDIKTA_AGGREGATOR_DEPLOY_BLOCK_*` gives the block event scans start at.

See `server/.env.example` for the complete set including archival, rate-limiting, and oracle config.

### Client (`client/.env`)

Start from `client/.env.example` and fill in the values. Required:

- `VITE_NETWORK` — `base-sepolia` or `base`
- `VITE_CLIENT_KEY` — must match `FRONTEND_CLIENT_KEY` on the server
- `VITE_BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA` and `VITE_BOUNTY_ESCROW_ADDRESS_BASE` — **current values from the Analytics page** (`/analytics` → System Health → Contract Addresses)
- `VITE_VERDIKTA_AGGREGATOR_ADDRESS_*` — optional and display-only: v2 bounties run on the escrow's one aggregator, read from the escrow (`aggregator()`). Leave empty, or set the v2 aggregator address (never a v1 one); the v2 aggregator is not deployed yet

### Contracts (`onchain/.env`)

```bash
PRIVATE_KEY=<deployer-private-key>      # NEVER commit
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_MAINNET_RPC_URL=https://mainnet.base.org
BASESCAN_API_KEY=<for-source-verification>
# The v2 aggregator the escrow is bound to (one serves every jury size: each bounty carries its
# own jury). Not deployed yet: fill in after the v2 aggregator deploy.
VERDIKTA_AGGREGATOR_BASE_SEPOLIA=<V2_AGGREGATOR>
VERDIKTA_AGGREGATOR_BASE=<same, for mainnet>
```

---

## Architecture Overview

```
Browser  ──HTTP──▶  server (Express)  ──RPC──▶  Base Sepolia / Base
   │                     │
   │                     ├──▶  IPFS (Pinata)
   │                     └──▶  jobs.json (per-network local storage)
   │
   └──MetaMask──▶  BountyEscrow contract  ──▶  v2 aggregator (one for every jury size)
                            ▲
   server round keeper ─────┘  (drawJury, closeCommits, promote, closeFailedRound, expireRerun)
```

- **`server/utils/syncService.js`** — polls the contract every 2 min, mirrors on-chain state into `server/data/{network}/jobs.json`
- **`server/utils/contractService.js`** — read-only contract calls used by sync and refresh endpoints
- **`server/routes/jobRoutes.js`** — main API: bounty CRUD, calldata endpoints, diagnose, refresh
- **`server/routes/agentRoutes.js`** — public agent discovery (`/agents.txt`, `/api/docs`, `/api/jobs.txt`, `/feed.xml`)
- **`server/utils/roundKeeper.js`** — the [round keeper](#round-keeper), run from the sync loop when `KEEPER_PRIVATE_KEY` is set
- **`server/utils/gasLimits.js`** — measured gas for the v2 calls and the per-transaction cap
- **`shared/classPresets.js`** — size-class presets (jury, Q, R, bond, fee floor, beacons), served at `GET /api/classes/presets`
- **`client/src/services/contractService.js`** — frontend ethers v6 wrapper for write operations
- **`client/src/utils/statusDisplay.js`** — single source of truth for status labels and badges
- **`onchain/contracts/BountyEscrow.sol`** — main contract; see [README.md#contract-addresses](README.md#contract-addresses)
- **`onchain/contracts/BountyRules.sol`** — the one interpreter of a round's result (Q-of-N), used by the escrow and the lens
- **`onchain/contracts/BountyEscrowLens.sol`** — read-only views (`nextAction`, `getOracleResult`, …) served at the escrow address

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
5. Create a bounty (pick a size class), submit work (the start attaches prepay + bond), let the round keeper (or `/round-step`) draw and promote the round, finalize, verify payout and bond return

The testnet needs the v2 aggregator deployed and an escrow deployed against it; until then, use the contract and server test suites.

---

## Deployment

### Smart contracts
```bash
cd onchain
npm run deploy:sepolia     # or deploy:base
# Deployer key from .env, RPC from hardhat.config.js
```

The escrow is bound at deployment to one v2 aggregator, and it can never change (there is no setter). One aggregator serves every jury size: each bounty carries its own jury (K, M, N, P, timeout; `shared/classPresets.js` holds the presets), sent with every request, and the aggregator's owner bounds it with `setLimits(maxJury, maxTimeout, tPlus)` (defaults 50 / 3600 / 155); the aggregator also refuses any timeout above one day (`AggregatorLib.MAX_TIMEOUT`), whatever `maxTimeout` says. Deploy the aggregator first (verdikta-dispatcher, `reputationBasedAggregator/deploy`), then set `VERDIKTA_AGGREGATOR_BASE_SEPOLIA` / `VERDIKTA_AGGREGATOR_BASE` in `onchain/.env` to its address. `deploy/01_deploy_bounty.js` refuses to run without it (and refuses an old `VERDIKTA_AGGREGATORS_*` list of more than one address).

For a **breaking** contract revision (any ABI change) do not deploy in isolation — follow a cutover runbook (the last one is `deploy/CUTOVER-2026-09-12.md`; a v2-specific runbook has not been written yet): close out the old contract's open bounties, deploy testnet then mainnet, stop services, flip the addresses and `deploymentBlocks`, archive and reset `jobs.json` (bounty IDs restart at 0 on a new contract and `jobId == bountyId`), restart, smoke-test. The September runbook has a rollback section.

After deployment:
1. Note the new BountyEscrow address from console output. The deploy script also auto-writes it to `onchain/deployments/{chainId}-{network}.json`.
2. Update `BOUNTY_ESCROW_ADDRESS_*` in `server/.env` and `VITE_BOUNTY_ESCROW_ADDRESS_*` in `client/.env` to the new address for this network. The server reads the aggregator from the escrow (`aggregator()`).
3. Set `KEEPER_PRIVATE_KEY` in `server/.env` to a funded hot wallet if this server should run the [round keeper](#round-keeper).
4. Restart the server (`cd server && ./restartServer.sh`) and rebuild the client (`cd client && ./rebuildClient.sh` or `npm run build`).
5. **Update `README.md`** — the "Contract Addresses" section holds the escrow and aggregator addresses (placeholders until the v2 deploy). **Do not leave this stale** — the running website's `/analytics` page is the live source of truth, and the README should agree with it.
6. Verify the new address is live via Basescan, and cross-check against the `/analytics` page on the running website (System Health → Contract Addresses → Bounty Escrow).

#### Is the contract source in this tree safe to deploy as-is?

**Not against the off-chain code now running in production.** The contracts on this branch are the v2 revision, which changes the ABI; the server, client and scripts on this branch already speak it, so deploy them together, as a cutover.

For a future revision, check whether it is drop-in by comparing the ABIs rather than trusting this paragraph:

```bash
cd onchain
git show <last-deployed-tag>:example-bounty-program/onchain/contracts/BountyEscrow.sol   # or check the tag out in a separate worktree
npx hardhat compile --force
node -e "console.log(JSON.stringify(require('./artifacts/contracts/BountyEscrow.sol/BountyEscrow.json').abi))" > /tmp/abi_new.json
# compile the deployed tag the same way into /tmp/abi_old.json, then:
cmp /tmp/abi_old.json /tmp/abi_new.json && echo "identical ABI — drop-in"
```

Identical ABI means internal-logic-only changes: safe to deploy against the existing off-chain code.

**The November 2026 (v2) revision is NOT drop-in.** What changed in the interface, compared with the September 2026 (v0.5.0) escrow:

| Piece | v0.5.0 | v2 |
|---|---|---|
| Constructor | one aggregator address | one v2 aggregator, fixed (`aggregator()`), serving every jury size |
| `createBounty` struct | `oracle: {maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling}` | `oracle` adds `minOracleFee`, `withBeacons`; the struct adds `jury` (a struct: K, M, N, P, timeout), `quota` (Q), `forfeitLine` (R), `bond` |
| `getBounty` tuple | 15 fields | the same with the longer `oracle`, plus the jury flat (`juryK, juryM, juryN, juryP, juryTimeout`) and `quota, forfeitLine, bond` |
| `getSubmission` tuple | 12 fields | + `bondFunder, bondHeld, rerunDeadline, rounds, passCount` |
| `SubmissionStatus` | 0–5 | + `AwaitingRerun` (6) |
| Starting | `msg.value == requiredPrepay` | `msg.value == startValue(bountyId)` = `requiredPrepay` + bond |
| Round steps | none (the request drew the jury) | `drawJury(bountyId, submissionId)`; `closeCommits` / `promote` on the aggregator |
| Dead rounds | v1's force-fail call | `closeFailedRound(bountyId, submissionId)`: the submission then awaits a re-run |
| Re-runs | — | `rerunSubmission` (payable `requiredPrepay`), `expireRerun`; constants `MAX_ROUNDS` (6), `RERUN_WINDOW` (2 h) |
| Events | — | `RerunAwaited`, `BondReturned`, `BondForfeited` |
| Concurrency | 256 evaluations per bounty | `MAX_ACTIVE_EVALUATIONS = 64` rounds in flight (submissions awaiting a re-run don't count) |
| Lens | `getOracleResult` → `started, hasResult, settled, failed, scores, justificationCids, startTimestamp` | `started, hasResult, phase, outcome, rounds, passCount, deadline, requestTime, scores, justificationCids`; `nextAction` values in [Driving the contract without the API](#driving-the-contract-without-the-api) |
| Aggregator interface | v1 | v2: 10-argument request (the last is the jury), `maxTotalFee(maxFee, minFee, withBeacons, K, P)`, `drawJury`, `closeCommits`, `promote`, `settle`, `cancelUnsealed`, `getRoundInfo`, `getJury`, `getOutcomeScores`; no `K()`/`M()`/`N()`/`P()`/`responseTimeoutSeconds()` |

Exact fragments (copy verbatim into ABI lists):

```
function createBounty((string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, uint256 minOracleFee, bool withBeacons) oracle, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury, uint8 quota, uint8 forfeitLine, uint256 bond) p) payable returns (uint256 bountyId)
function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)
function getBounty(uint256 bountyId) view returns ((address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint128 payoutWei, uint64 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint64 submissions, address targetHunter, uint128 creatorDeterminationPayment, uint128 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, uint256 minOracleFee, bool withBeacons) oracle, uint8 juryK, uint8 juryM, uint8 juryN, uint8 juryP, uint40 juryTimeout, uint8 quota, uint8 forfeitLine, uint128 bond))
function getSubmission(uint256 bountyId, uint256 submissionId) view returns ((address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint8 acceptance, uint8 rejection, uint64 submittedAt, uint64 finalizedAt, uint96 ethMaxBudget, uint64 creatorWindowEnd, address funder, address bondFunder, uint96 bondHeld, uint64 rerunDeadline, uint8 rounds, uint8 passCount))
function startValue(uint256 bountyId) view returns (uint256)
function drawJury(uint256 bountyId, uint256 submissionId)
function closeFailedRound(uint256 bountyId, uint256 submissionId)
function rerunSubmission(uint256 bountyId, uint256 submissionId) payable
function expireRerun(uint256 bountyId, uint256 submissionId)
function aggregator() view returns (address)
event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, bool passed, bool paid, uint256 acceptance, uint256 rejection, string justificationCids)
event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)
event RerunAwaited(uint256 indexed bountyId, uint256 indexed submissionId, uint8 round, uint256 passCount, bool noResult, uint64 rerunDeadline)
event BondReturned(uint256 indexed bountyId, uint256 indexed submissionId, address indexed to, uint256 amount)
event BondForfeited(uint256 indexed bountyId, uint256 indexed submissionId, address indexed creator, uint256 amount)
```

The integer fields of `Bounty` / `Submission` are typed as narrowly as their domain allows (storage packing). Every integer still ABI-encodes as one 32-byte word, so a fragment that declares them as `uint256` decodes identically; only the type names differ. The lens views (`nextAction`, `getOracleResult`, …) are not in the compiled `BountyEscrow` artifact — use the merged ABI (`onchain/deploy/helpers.js → mergedAbi()`).

New revert strings: `bad jury`, `bad quota`, `bad bond`, `bad fee floor`, `bad budget` (createBounty); `quota above jury size` (start or re-run, if the aggregator's N was lowered); `round still open`, `no oracle result - use closeFailedRound` (finalize on a round that ended without a result); `not awaiting rerun`, `only hunter or funder`, `rerun window closed`, `rerun limit reached`, `rerun window open` (re-runs); `active evaluation - finalize first` (close, also while a submission awaits a re-run). The aggregator's own custom errors (`TooEarly`, `WrongPhase`, `DrawExpired`, `NotDue`, `SeedExpired`) surface through `drawJury`, `closeCommits` and `promote`. The September 2026 revision's changes (struct `createBounty`, 3-argument prepare, lens, clones, payout priority) are described in `deploy/CUTOVER-2026-09-12.md` and the README changelog.

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

After a bounty's deadline passes, escrowed ETH stays locked until someone calls `closeExpiredBounty(bountyId)`. **This does not happen automatically.** If any submission is still in `PendingVerdikta` or `AwaitingRerun` status, the close call reverts (`active evaluation - finalize first`) and those submissions must be resolved first: `finalizeSubmission` if the round has a result, `closeFailedRound` if it ended without one, `expireRerun` for a submission awaiting a re-run (after the deadline nobody can re-run, so anyone may expire it). Submissions that were prepared but never started do not block closing — after the deadline they can no longer be started (see [Submission timing and priority rules](#submission-timing-and-priority-rules)).

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
          "ageMinutes": 22, "closeFailedEligible": true, "hasResult": false,
          "action": "close_failed", "nextAction": "CLOSE_FAILED", "secondsUntilDeadline": 0 },
        { "submissionId": 2, "hunter": "0x...", "submittedAt": 1716999100,
          "ageMinutes": 17, "awaitingRerun": true, "rerunDeadline": 1716999999,
          "hasResult": false, "closeFailedEligible": false, "action": "expire_rerun" }
      ]
    }
  ]
}
```

`action` says what each entry needs: `finalize` (the round has a result), `close_failed` (`closeFailedEligible`: the round ended, or must end, with no result — the same gate as the lens's `nextAction === "CLOSE_FAILED"`), `expire_rerun` (`awaitingRerun`), or `wait` (the round is still in progress; the round keeper draws and promotes it). It's safe to poll this endpoint — it's read-only and small.

For a system-wide view (all creators) use `GET /api/jobs/admin/expired` instead.

#### 2. Clear blocking submissions

For each entry in `pendingSubmissions`, call the endpoint for its `action`; each returns calldata to sign and submit from any wallet (anyone may call):

```
POST /api/jobs/:jobId/submissions/:submissionId/finalize       # action "finalize"
POST /api/jobs/:jobId/submissions/:submissionId/close-failed   # action "close_failed" (/timeout is an alias)
POST /api/jobs/:jobId/submissions/:submissionId/expire-rerun   # action "expire_rerun"
```

`closeFailedRound` has **no timer**. It first tries to settle the round on the aggregator (`settle`, due after the round's deadline, which is counted from the draw) or to cancel it (`cancelUnsealed`, for a round never drawn within a day), then succeeds only if the round has failed or been cancelled **and** has no result. It returns what is left of the prepay to the round's funder; the submission then awaits a re-run (`AwaitingRerun`), so on an expired bounty follow it with `expireRerun`. Otherwise it reverts with one of:

- `result available - use finalizeSubmission` — the round has a result. Call `/finalize` instead. A passing score can never be discarded by `closeFailedRound`.
- `round still open` — the round can still get a result. Wait (the keeper moves it on) and retry.

The endpoint's own pre-check applies the same rule before returning calldata: `canCloseFailed:false` (also `canTimeout:false`) with `error`, `nextAction`, `phase`, `deadline`, `remainingSeconds` and a `hint` while the round is open, or `canFinalize:true` when it has a result. Either way nothing is lost — wait and retry, or finalize.

#### 3. Close the bounty

Once `canClose` is `true`:

```
POST /api/jobs/:jobId/close
```

Returns calldata for `closeExpiredBounty(bountyId)`. Sign and submit from any wallet (anyone may call). ETH is returned to the creator.

#### Common failure modes

- **`closeExpiredBounty` reverts with no clear message:** a submission entered `PendingVerdikta` or `AwaitingRerun` between your check and the close call (the revert is `active evaluation - finalize first`). Re-query the action-required endpoint and resolve anything new.
- **`closeFailedRound` reverts with `round still open`:** the round can still get a result (it has not passed its deadline, or an undrawn round is less than a day old). Check its `nextAction`: if it is DRAW, CLOSE_COMMITS or PROMOTE, send that step (`/round-step`); otherwise wait and retry.
- **`closeFailedRound` reverts with `result available - use finalizeSubmission`:** the round has a result after all. Call `/finalize` — that resolves the round (pay, re-run or fail) and, for a pass or hard fail, unblocks the close.
- **`finalizeSubmission` reverts with `earlier submission pending - retry after it resolves`:** any bounty; another hunter's earlier submission is still `PendingVerdikta` or `AwaitingRerun`. Its round is often already over and nobody resolved it (its `nextAction` is `FINALIZE`, `CLOSE_FAILED` or `EXPIRE_RERUN`). Anyone may resolve it, then retry. `POST /finalize` and `/diagnose` list these in `blockedBy[]` with the transaction for each; the website's Finalize button offers to send them first.
- **Bounty not in the list at all:** the job is not linked on-chain (`onChain === false` and not synced). There is no escrow to reclaim. Such an **un-funded orphan** (created by `POST /jobs/create` without a following `createBounty`) can be removed actively — it is not silently garbage-collected: hard-delete it with `DELETE /api/jobs/admin/:jobId`, or soft-hide it with `PATCH /api/jobs/admin/:jobId/status` `{ "status": "CANCELLED" }`. The delete is guarded (refuses on-chain jobs and jobs younger than 5 min) and does **not** roll back the auto-incremented `jobId` counter. Note this is distinct from the *old-contract* orphans handled by `GET/DELETE /api/jobs/admin/orphans`. See `CLAUDE.md` "Sync service orphan race" for the underlying issue.

### Submission timing and priority rules

These are enforced by `BountyEscrow.sol` and are the source of truth for every lifecycle description in the app.

**Deadline.** Everything a hunter must do happens before `submissionDeadline`:

- `prepareSubmission` requires `block.timestamp < submissionDeadline` (`deadline passed`).
- `startPreparedSubmission` and `rerunSubmission` require the same (`deadline passed`). A submission that was prepared but not started by the deadline is dead; it does not block `closeExpiredBounty`.
- `drawJury`, `finalizeSubmission`, `closeFailedRound` and `expireRerun` may run after the deadline (and the aggregator's `closeCommits` / `promote`). A submission in evaluation (`PendingVerdikta`) or awaiting a re-run (`AwaitingRerun`) blocks closing until it is resolved (the pending list must be empty). After the deadline an `AwaitingRerun` submission can no longer re-run, so anyone may expire it at once.

**Creator window.** `creatorAssessmentWindowSize` is a *per-submission* timer that starts at prepare: `creatorWindowEnd = submittedAt + creatorAssessmentWindowSize`. During the window only the creator can act (`creatorApproveSubmission`); `startPreparedSubmission` reverts `creator window still open`. After it, anyone may fund and start arbitration (and posts the bond). Because the start must also be before the deadline, windowed `prepareSubmission` requires `submittedAt + creatorAssessmentWindowSize + 1 < submissionDeadline` (`window would end after deadline`). The effective prepare cutoff on a windowed bounty is therefore `submissionDeadline − creatorAssessmentWindowSize − 2`; read it from `prepareCutoff(bountyId)` (also on `/onchain-status`) rather than computing it. A re-run never reopens a creator window.

**The round (v2 aggregator).** `startPreparedSubmission` (and `rerunSubmission`) only requests the round: the aggregator escrows the prepay and nothing else happens until the jury is drawn.

- `drawJury(bountyId, submissionId)` — anyone, from two blocks after the start. It calls the aggregator through the submission's EvaluationWallet, so the wallet is the requester and the draw reward (2 × the fee ceiling, the requester's alone for the first 30 seconds, then whoever draws) goes back to the round's funder with the leftover. A beacon bounty (`withBeacons`, the Jumbo preset) draws twice: the first call starts the beacon stage, the second draws once 2 beacon values are in.
- Commits: the window closes by itself at enough commits, or `closeCommits(aggId)` on the escrow's aggregator (`aggregator()`) closes it once *T*+ (155 s by default) has passed with at least *M* commits. `promote(aggId)` is due from two blocks after the close; its caller earns 1 × the fee ceiling.
- The *N*-th reveal produces the result; `finalizeSubmission` can run from then on.
- There is no fixed timeout. A drawn round has a deadline counted from the draw (the bounty's jury timeout: 300 s at Small to Large and 600 s at Jumbo in the presets, any value up to the aggregator's `maxTimeout()`, 3,600 s by default, and never above one day; extended when the close or promotion came late). A round that ends without a result is closed with `closeFailedRound`. If nobody stores the seed (`drawJury` or the aggregator's `sealSeed`) within 8,191 blocks, about 27 minutes on Base, or nobody draws a sealed round within a day, the round can no longer be drawn and is cancelled with its whole prepay going to the aggregator's arbiter pool, and a round whose commit phase was never closed or promoted has its unspent prepay shared by its committers instead of refunded: the keeper, or anyone, should send these steps promptly. See the aggregator's [user guide](../docs/user-guide.md#failure-and-refund-paths).

**Gas.** Measured against the real v2 contracts on the in-process network (`server/utils/gasLimits.js`, 2026-11-23): `drawJury` 2.0M (K = 6), 3.7M (K = 12), 13.5M (K = 50 with beacons); `closeFailedRound` up to 2.38M (K = 50); `startPreparedSubmission` up to 3.35M when the request first settles two due 50-juror rounds. The per-transaction cap is 2^24 (16,777,216, EIP-7825), so the server clamps every limit to 16.5M and uses 6M for a start; the calldata endpoints return a live estimate + 25% as `transaction.gasLimit`. Use it rather than a hand-picked limit.

**Decision rule (Q-of-N)** (`BountyRules.judge`, `SCORE_SCALE = 1_000_000`, `SCORE_DIVISOR = 10_000`). One interpreter, compiled into the escrow and the lens, serves `finalizeSubmission`, both sibling scans (`_requireNoPassingSubmission` at start, `_hasEarlierPendingByOther` at payout) and `nextAction` / `getOracleResult`, so eligibility, payout and advice never disagree. The aggregated result must be `[DONT_FUND, FUND]`, each entry at most `SCORE_SCALE`; anything else counts as no result. A one-number result in particular: the aggregator gives the result the most common reveal length, so it appears only when most counted jurors reveal one number, and `getOutcomeScores(aggId, 0)` would then return every other juror's DONT_FUND score, letting a majority below Q pass work the rest reject. Each counted juror's FUND score (`getOutcomeScores`) passes when it is `>= threshold × SCORE_DIVISOR` (and at most `SCORE_SCALE`). With `passCount` such jurors: `>= quota` (Q) → pass (paid, bond returned); `>= forfeitLine` (R) → soft fail (`AwaitingRerun`); fewer → hard fail (`Failed`, bond to the creator). No result → `AwaitingRerun` after `closeFailedRound` (or straight from finalize for a malformed result). `acceptance` / `rejection` store the aggregated score divided by `SCORE_DIVISOR`, for display only. Out-of-range entries are rejected rather than clamped — clamping would have turned a corrupt `[0, 2_000_000]` into a pass.

**Re-runs** (`rerunSubmission`, `expireRerun`, `MAX_ROUNDS = 6`, `RERUN_WINDOW = 2 hours`). A soft fail or a round with no result puts the submission in `AwaitingRerun` with `rerunDeadline = min(now + 2 h, submissionDeadline − 1)`, if the bounty is still open and fewer than 6 rounds have run; otherwise it fails with its bond returned. The hunter or the bond funder may re-run, attaching `requiredPrepay(bountyId)` (no new bond); the sender becomes the round's funder. The re-run keeps the submission's index, so it keeps payout priority. After `rerunDeadline` (or once the bounty is no longer open, or the deadline has passed) anyone may call `expireRerun`: `Failed`, bond returned, `SubmissionFinalized` with justification `RERUN_EXPIRED`. A re-run reverts only while a LOWER-index round of the bounty already passes (`nextAction` AWAIT_EXPIRY): that one will be paid first. A later passing round does not stop it, since the re-run keeps its index and the later pass waits for it at finalize.

**Payout priority (every bounty)** (`_hasEarlierPendingByOther`). Payout priority is by submission index among submissions on the pending list (in evaluation or awaiting a re-run): a passing submission is paid only once every earlier-submitted (lower-index) submission by another hunter has resolved — until then `finalizeSubmission` reverts `earlier submission pending - retry after it resolves` (a retry, not a failure; the result is kept). If an earlier one passes, it takes the bounty. This protects an original against a copy of its public work CID submitted later, whatever order the oracle rounds complete in. Only started submissions hold priority (a prepared-but-unstarted one holds none — start promptly after preparing), and a hunter's own earlier submission never blocks them. The check walks the per-bounty pending list only (no aggregator call), so it is order-independent: whoever calls finalize, in whatever order, the same submission is paid. The wait is bounded: every earlier entry resolves through a result, `closeFailedRound` or `expireRerun`, all permissionless, and once a result is passing `_requireNoPassingSubmission` refuses every first start and every re-run at a higher index; only an earlier submission already awaiting a re-run (still on the pending list) may run again. Residual: if the original's own rounds fail, a later copy can still win.

**Creator-approval priority on windowed bounties** (`_hasEarlierUnresolvedSubmission`). A lower-index submission blocks creator approval (`earlier submission unresolved`) of a higher-index one only while it can still win:

- it is `PendingVerdikta` (evaluation in flight — temporary, always resolves), or
- it is `PendingCreatorApproval` and its window is still open.

It does **not** block when its window expired and nobody started arbitration (preparing costs only gas, so such a submission would otherwise lock out everyone behind it for free), or when it belongs to the same hunter and is sitting in its window (a resubmission supersedes that hunter's earlier versions; the usual windowed bounty is targeted, so the creator can approve the revision right away and nobody pays to arbitrate the stale one).

The same-hunter exemption is deliberately narrower for `PendingVerdikta`: a same-hunter sibling that is **in evaluation** blocks `creatorApproveSubmission` (`earlier submission unresolved`), whereas payout priority (above) exempts same-hunter siblings, so it does not block the hunter's own `finalizeSubmission`. Reason: an in-flight (possibly already passing) evaluation is the hunter's live claim to `arbiterDeterminationPayment`; if the creator could approve a newer version for `creatorDeterminationPayment` (which may be far smaller) the bounty would become Awarded and the earlier version would finalize to `PassedUnpaid`, voiding a payout the hunter already paid the oracle to earn. Finalize of the newer version by the hunter is harmless (same payee, same rate). The creator may approve the revision after the earlier evaluation has resolved as failed; nobody is forced to pay a prepay.

When a passing `finalizeSubmission` on any bounty is blocked by another hunter's earlier submission, it **reverts** with `earlier submission pending - retry after it resolves`. Nothing is written; the submission stays `PendingVerdikta` and finalize is retried once the earlier one resolves. `PassedUnpaid` is written only when the bounty is already awarded or closed.

**Submission bounds.** Two different bounds, chosen so that gas-only junk can never lock a bounty *and* cannot cheaply shut honest hunters out.

- *Non-windowed bounties: no cap on prepared submissions.* The contract keeps a per-bounty **pending list** of the submissions in evaluation or awaiting a re-run (pushed at the first start, swap-removed when the submission resolves for good; read it with `pendingSubmissionIds(bountyId)`). The start-time scan ("has another submission already passed?") and the payout tie-break scan walk that list only, so never-started submissions cost nothing on-chain, however many there are. What is capped is concurrency: `MAX_ACTIVE_EVALUATIONS = 64` rounds in flight (`activeEvaluations(bountyId)`; submissions awaiting a re-run are on the pending list but don't count). `startPreparedSubmission` and `rerunSubmission` revert `evaluation slots full - retry later` while the bounty is at the cap (`nextAction` AWAIT_SLOT); a slot frees as soon as any in-flight round resolves. A slot is never free to hold: every round prepays an oracle round whose per-juror base fees are consumed at the draw and not refunded. The cap is lower than v1's because judging a sibling's result now reads every counted juror's score: about 160k gas per sibling on a Jumbo jury (27 reveals, measured on the mock), so about 10M at the cap, under the per-transaction cap.
- *Windowed bounties: `MAX_SUBMISSIONS_PER_BOUNTY = 128` on prepares.* Their priority scan (`_hasEarlierUnresolvedSubmission`) must see in-window, never-started entries, so it walks the full array and prepares are capped instead; `prepareSubmission` reverts `submission limit reached` once a windowed bounty has 128 submissions in any state, counting every hunter. On a **targeted** windowed bounty only the target can prepare, so the cap can only be self-inflicted. On an **open** windowed bounty anyone can fill it for gas alone and shut other hunters out until the deadline — a known, accepted weakness of that unusual configuration; target the bounty or drop the window if it matters. A full bounty only rejects new prepares: existing submissions still resolve, and the creator can still close at the deadline.
- *Off-chain consequence:* a non-windowed bounty can hold thousands of submissions. Page with `getSubmissionsPage(bountyId, start, count)` (≤ 100 per call) rather than `getSubmissions(bountyId)`, and treat the on-chain `submissions` counter as "prepared, including junk".

**Why index priority and not "first to complete".** The work CID is public from the moment `prepareSubmission` lands, so on an open bounty anyone can prepare and start a copy of it at a higher index. Two oracle rounds over identical content complete in random order; a "first to complete wins" rule would hand the copier the bounty about half the time (more, with several copies). Index priority makes the earlier submitter win whenever their own round passes. The cost is that a later passing submission may have to retry finalize while an earlier round finishes or its re-run window runs out.

**Oracle and decision settings belong to the creator** (`Bounty.oracle`, `jury`, `quota`, `forfeitLine`, `bond`, set in `createBounty`; validated by `MAX_ALPHA = 1000`, `MAX_FEE_SCALING_FACTOR = 1000`, fee ≤ the aggregator's `maxOracleFee()`, base cost < fee, scaling ≥ 1, a jury with K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40 and P ≥ 2 unless N = 1, `1 ≤ quota ≤` the jury's N, `forfeitLine ≤ quota`; the aggregator's live limits — K ≤ `maxJury()` and the keeper's shortlist, T+ < timeout ≤ `maxTimeout()` and ≤ one day (86,400 s) — are checked by each request). Size-class presets (`shared/classPresets.js`) fill them in; the creator may override every value. They are used verbatim for every evaluation of the bounty; `prepareSubmission` takes only the two CIDs and the addendum forwarded to the aggregator is the constant `ADDENDUM = ""`. Why the creator and not the hunter: the aggregator's keeper treats `maxOracleFee` as an eligibility filter (an arbiter is selectable only if its fee ≤ the request's ceiling), and `estimatedBaseCost` / `maxFeeBasedScaling` weight selection by price — whoever sets them can shrink or tilt the jury toward nodes they run. The fee floor (`minOracleFee`) prices every juror at least at that amount; it may exceed the ceiling. A hunter can see a bounty's settings before committing work and walk away (the website's validate check warns on a small eligible pool, a dominant operator, an enabled price boost or an extreme alpha); a creator cannot inspect a hunter. `ethMaxBudget = maxTotalFee(maxOracleFee, minOracleFee, withBeacons, K, P)` on the aggregator, for the bounty's jury, is identical for every submission to a bounty. The residual lever is the class itself (a class served by one operator is that operator's private jury) — visible on the bounty.

**Prepay refreshed at start, settings clamped to the live ceiling** (`requiredPrepay`, `startValue`, `effectiveOracleParams`, `_effectiveOracle`). The aggregator's fee ceiling, jury limits (`maxJury`, `maxTimeout`, `tPlus`), bonus multiplier and rewards are owner-settable and may change after a bounty is created; creation validates the creator's settings only against the ceiling of that moment. At every start and re-run the escrow reads the live ceiling and clamps the bounty's settings to what the aggregator will accept: `maxOracleFee → min(fee, ceiling)` (mirroring the aggregator's own clamp), and `estimatedBaseCost → effectiveFee − 1` if it no longer sits strictly below the effective fee. `alpha`, `maxFeeBasedScaling`, the fee floor and the beacon flag pass through unchanged. `requiredPrepay()` is quoted from the effective fee, `startValue()` adds the bond, the start requires `msg.value` to match exactly (`wrong eth amount`) and stores what was actually prepaid, and `effectiveOracleParams(bountyId)` shows what will be forwarded; the stored `Bounty.oracle` is never modified. The jury itself is the bounty's and never changes; the quota was checked against its N at `createBounty`. If the owner later tightens the limits below a bounty's jury, its requests revert with the aggregator's `BadJury`. `prepareSubmission`'s `ethMaxBudget` is therefore only an estimate.

**Funder refund** (`Submission.funder`, `Submission.bondFunder`). Each start or re-run records `msg.sender` as the round's funder; `_refundLeftoverEth` (from finalize and `closeFailedRound`) returns that round's unspent prepay, and the draw reward if the wallet drew, to the funder. A previous round's deferred refund goes to its own funder before a re-run's funder is set. The bond goes back to `bondFunder`, who posted it at the first start.

**Refund recovery is separate from resolution** (`_refundLeftoverEth`, `recoverLeftoverEth`, event `RefundDeferred`). At the end of `finalizeSubmission` and `closeFailedRound` the escrow tries to recover the unspent oracle prepay (wallet → aggregator `withdrawEth` → wallet → escrow → funder) — but inside a `try/catch` AND with at most `INLINE_REFUND_GAS_LIMIT = 200000` gas. The cap matters because the wallet forwards into the aggregator: without it an aggregator withdraw that burned gas would leave the transaction only 1/64 of its budget after the catch (EIP-150), possibly too little to emit `RefundDeferred` and return, so the resolution would revert anyway. `recoverLeftoverEth` (the retry) forwards full gas. If that chain reverts, the status change and the payout still stand and `RefundDeferred(bountyId, submissionId)` is emitted instead of `EthRefunded`. Anyone can then call `recoverLeftoverEth(bountyId, submissionId)` on a resolved submission: it re-runs the wallet's idempotent refund, pays the funder, and reverts with the underlying reason if it still cannot (or `nothing to recover` if there is nothing). Some rounds that end without a result have nothing to recover: the aggregator sends their unspent prepay to its arbiter pool (paid out an eighth at a time to a random registered arbiter at each draw), or, for a round with M commits that was never promoted, shares it equally among the slots that committed.

**Closing a failed round** (`closeFailedRound`, replacing v1's force-fail call). No timer. Requires `PendingVerdikta`, then: try the aggregator's `settle(aggId)` and `cancelUnsealed(aggId)` (each ignored if it reverts), require `getEvaluation(aggId)` to have no result (`result available - use finalizeSubmission`), require the round's phase (`getRoundInfo`) to be 8 failed or 9 cancelled (`round still open`). On success: the round slot frees, the unspent prepay (whatever the aggregator returned) goes to the funder, and the submission awaits a re-run with its place and bond, or fails with its bond returned if no re-run is possible.

### Round keeper

`server/utils/roundKeeper.js` moves rounds along so a hunter only waits. It runs from the sync service when `KEEPER_PRIVATE_KEY` is set (a funded hot wallet; the server logs `[keeper] round keeper enabled` with its address). For every submission in evaluation it reads the lens's `nextAction` and, after simulating the call, sends DRAW (`escrow.drawJury`), CLOSE_COMMITS (`aggregator.closeCommits`), PROMOTE (`aggregator.promote`), CLOSE_FAILED (`escrow.closeFailedRound`) or EXPIRE_RERUN (`escrow.expireRerun`). It never finalizes: FINALIZE is left to hunters and clients. It does not resend a step while its transaction may still land (90 s), withdraws its promote rewards from the aggregator about hourly, and warns when its balance falls below 0.002 ETH. Without a key, the server runs without it and every step stays available to anyone through `/draw`, `/round-step`, `/close-failed` and `/expire-rerun`.

### Driving the contract without the API

Agents can run the whole lifecycle against `BountyEscrow` alone, plus the escrow's one aggregator (`aggregator()`) for `closeCommits` / `promote` — the API is a convenience, not a dependency. One ABI caveat: the read-only views in the table below (`getSubmissions`, `getSubmissionsPage`, `getBounties`, `getOracleResult`, `nextAction`, `prepareCutoff`, `canBeClosed`, `isAcceptingSubmissions`, `getEffectiveBountyStatus`) are implemented in a companion contract, `BountyEscrowLens`, and answered **at the escrow address** by the escrow's fallback (a `STATICCALL`-guarded `delegatecall`; no state change is possible; the lens address is an immutable with no setter — not a proxy, no owner). Calls, return values and revert reasons are indistinguishable from views in the escrow itself. But an ABI built from the escrow's verified source or its compiled artifact will not list them — use the human-readable fragments in this guide / the `/agents` page, or the merged ABI exported by `onchain/deploy/helpers.js`. A mistyped function name reverts `unknown function` instead of with empty data. What the contract gives you:

| Need | Call |
|---|---|
| List bounties | `bountyCount()`, `getBounties(start, count)` (≤ 100 per call; page with `start += result.length`) — each `Bounty` carries the creator's `oracle` settings, `jury`, `quota`, `forfeitLine` and `bond` |
| Read a bounty's submissions | `getSubmissionsPage(bountyId, start, count)` (≤ 100 per call; page with `start += result.length`) — `getSubmissions(bountyId)` returns all at once, fine for a handful, risky on a junk-flooded non-windowed bounty; `pendingSubmissionIds(bountyId)` lists the ids in evaluation or awaiting a re-run |
| Can I still prepare? | `prepareCutoff(bountyId)` — last unix second `prepareSubmission` succeeds (windowed: `deadline − window − 2`); `isAcceptingSubmissions(bountyId)` |
| How much to attach | `startValue(bountyId)` at start (prepay + bond), `requiredPrepay(bountyId)` for a re-run — read right before sending; `effectiveOracleParams(bountyId)` shows the fee block actually forwarded |
| Which aggregator | `aggregator()` (for `closeCommits` / `promote`; one for every bounty) |
| A bounty's jury | `getBounty(bountyId)`: `juryK`, `juryM`, `juryN`, `juryP`, `juryTimeout`; a round's: the aggregator's `getJury(aggId)` |
| Is the oracle done? | `getOracleResult(bountyId, submissionId)` → `started, hasResult, phase, outcome (0 not ready, 1 no result, 2 pass, 3 soft fail, 4 hard fail), rounds, passCount, deadline, requestTime, scores, justificationCids` — no aggregator ABI needed |
| What should I do now? | `nextAction(bountyId, submissionId)` → `START` \| `AWAIT_SLOT` \| `AWAIT_CREATOR` \| `DRAW` \| `CLOSE_COMMITS` \| `PROMOTE` \| `AWAIT_ORACLE` \| `AWAIT_EARLIER` \| `FINALIZE` \| `CLOSE_FAILED` \| `RERUN` \| `AWAIT_EXPIRY` \| `EXPIRE_RERUN` \| `RECOVER_REFUND` \| `DONE` \| `DEAD` (the on-chain equivalent of `/diagnose`). Every label names the call that will SUCCEED now: `DRAW` = `escrow.drawJury`; `CLOSE_COMMITS` / `PROMOTE` = the aggregator's `closeCommits(aggId)` / `promote(aggId)`; `AWAIT_SLOT` = a start or re-run would hit the 64-round cap; `AWAIT_EARLIER` = a passing result that must wait for an earlier submission (payout priority); `AWAIT_EXPIRY` = a re-run would revert because a lower-index round already passes; `DEAD` also covers "an in-flight submission already passes" (start would revert) |
| Bounty state | `getEffectiveBountyStatus(bountyId)` → `OPEN` \| `EXPIRED` \| `AWARDED` \| `CLOSED`; `canBeClosed(bountyId)`. `EXPIRED` (Open past the deadline) still **pays** a passing in-flight submission on finalize — only `AWARDED`/`CLOSED` are terminal |
| Money owed to me | `withdrawable(address)` → `withdraw()`; deferred prepay → `recoverLeftoverEth`; promote rewards → the aggregator's `ethOwed(address)` → `withdrawEth()` |

What the contract cannot give you, and the API otherwise does:

- **IPFS pinning.** Evaluation packages and work archives must be pinned by you (Pinata, web3.storage, a local node).
- **The evaluation package format** (creator side): a ZIP with `manifest.json`, `primary_query.json` and the rubric, where the query template must match what the oracle nodes parse — deviations fail silently. `server/utils/archiveGenerator.js` is the reference builder; `POST /api/jobs/validate` checks a CID without side effects.
- **The work archive format** (hunter side): a ZIP with `manifest.json` (`additional[]` listing the files), `primary_query.json` (`{ query: <narrative>, references: [...] }`) and the files under `submission/`. `createHunterSubmissionCIDArchive` in the same file is the reference.
- **Human metadata** (title, description, USD estimates) — the API stores it off-chain; on-chain there is only the package CID.
- **Size-class presets** — `GET /api/classes/presets` (or `shared/classPresets.js`) converts their USD amounts to wei.

Revert reasons are plain strings (listed above under the breaking-release notes); decode them from the receipt, not from ethers' formatted error.

## Debugging

### Sync service not picking up new bounties
- Check `server/server.log` for sync errors
- Confirm `USE_BLOCKCHAIN_SYNC=true` in `.env`
- Verify `BOUNTY_ESCROW_ADDRESS_*` matches the network you're querying
- Force a refresh: `POST /api/jobs/:jobId/refresh`

### Submission stuck in PENDING_EVALUATION or AWAITING_RERUN
- Use `GET /api/jobs/:jobId/submissions/:subId/diagnose` for actionable analysis
- Read `nextAction` (on `/diagnose`, or from the lens). `DRAW`, `CLOSE_COMMITS` or `PROMOTE` means the round is waiting for a step nobody has sent: is the [round keeper](#round-keeper) running and funded? Anyone may send the step (`POST .../round-step`). `AWAIT_ORACLE` means the arbiters are working: wait.
- `CLOSE_FAILED` means the round ended, or must end, without a result: anyone can call `closeFailedRound` (`/submissions/:subId/close-failed`); the submission then awaits a re-run. If it reverts with `result available - use finalizeSubmission`, the round did get a result — finalize instead.
- An API status of `AWAITING_RERUN` is not stuck: the hunter may re-run within 2 hours (`/rerun`), after which anyone may expire it (`/expire-rerun`).
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
- `startPreparedSubmission(uint256 bountyId, uint256 submissionId)` is **payable** — the funder attaches `startValue(bountyId)` (the round's prepay, `requiredPrepay(bountyId)`, plus the bounty's bond) as `msg.value`, read live from the escrow. A re-run (`rerunSubmission`) attaches `requiredPrepay` only. There is no LINK token, ERC-20 approval, or allowance step.
- The value must match exactly: anything else reverts `wrong eth amount`. Any unspent prepay is automatically refunded when the round resolves (finalize or `closeFailedRound`); the bond when the submission resolves, unless a hard fail forfeits it.
- **The event value is an estimate, and excludes the bond.** `ethMaxBudget` in `SubmissionPrepared` (second data word, before the dynamic `string evaluationCid`) is the aggregator's `maxTotalFee` for the bounty's settings *at prepare time*. `startPreparedSubmission` recomputes it live, so a change in aggregator parameters between prepare and start never strands a prepared submission. Read `startValue(bountyId)` right before starting — the `/start` calldata endpoint's `transaction.value` and the website do exactly that. It is the same for every submission to a bounty at any given moment.
- The prepay is `maxTotalFee(maxOracleFee, minOracleFee, withBeacons, K, P)` on the aggregator, for the bounty's jury: `max(ceiling, floor) × (K + 3 × P [+ 2 beacons]) + ceiling × 3` with the default bonus and rewards. At the API's default ceiling of 0.00002 ETH, no floor and a Small jury (K = 6, P = 3) that is 18 × 0.00002 = 0.00036 ETH; larger juries and a fee floor cost more.

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
