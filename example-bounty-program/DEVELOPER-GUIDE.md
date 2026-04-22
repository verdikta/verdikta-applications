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
- `VITE_LINK_TOKEN_ADDRESS_*` and `VITE_VERDIKTA_AGGREGATOR_ADDRESS_*` — available from the Analytics page, from `onchain/deployments/*.json`, or from the [Contract Addresses](../README.md#contract-addresses) section of the README

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
4. Get test ETH and LINK from a faucet
5. Create a bounty, submit work, finalize, verify payout

---

## Deployment

### Smart contracts
```bash
cd onchain
npm run deploy:sepolia     # or deploy:base
# Deployer key from .env, RPC from hardhat.config.js
```

After deployment:
1. Note the new BountyEscrow address from console output. The deploy script also auto-writes it to `onchain/deployments/{chainId}-{network}.json`.
2. Update `BOUNTY_ESCROW_ADDRESS_*` in `server/.env` and `VITE_BOUNTY_ESCROW_ADDRESS_*` in `client/.env` to the new address for this network.
3. Restart the server (`cd server && ./restartServer.sh`) and rebuild the client (`cd client && ./rebuildClient.sh` or `npm run build`).
4. **Update `README.md`** — the "Contract Addresses" section has the two canonical addresses hardcoded as a snapshot. Edit the relevant network's `BountyEscrow` line. **Do not leave this stale** — the running website's `/analytics` page is the live source of truth, and the README should agree with it.
5. Verify the new address is live via Basescan, and cross-check against the `/analytics` page on the running website (System Health → Contract Addresses → Bounty Escrow).

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

## Debugging

### Sync service not picking up new bounties
- Check `server/server.log` for sync errors
- Confirm `USE_BLOCKCHAIN_SYNC=true` in `.env`
- Verify `BOUNTY_ESCROW_ADDRESS_*` matches the network you're querying
- Force a refresh: `POST /api/jobs/:jobId/refresh`

### Submission stuck in PENDING_EVALUATION
- Use `GET /api/jobs/:jobId/submissions/:subId/diagnose` for actionable analysis
- If oracle stuck >10 min, anyone can call `failTimedOutSubmission` (or use `/submissions/:subId/timeout`)

### LINK approval errors at startPreparedSubmission
- The contract pulls LINK via `transferFrom` using the allowance set in step 2 — never `transfer` LINK directly to the EvaluationWallet
- Confirm allowance with `link.allowance(hunter, evalWallet)` before calling start
- To generate the `LINK.approve` calldata use `POST /api/jobs/:id/submit/approve` with `{ evalWallet, linkAmount }` — note `linkAmount` is a **decimal LINK** string (e.g. `"0.6"`), not the raw wei `linkMaxBudget` from the `SubmissionPrepared` event. Convert first with `ethers.formatEther(linkMaxBudget)`.

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
