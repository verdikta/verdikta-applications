# Example Arbiters

Peer project to `example-bounty-program` — a scaffold for the Verdikta Arbiters application. Currently a "coming soon" placeholder; ready to grow.

## Layout

```
client/   # Vite + React 19 frontend
server/   # Express API
```

Client and server are fully independent packages. Install and run each in its own terminal.

## Run locally

```bash
# Terminal 1 — server (port 5008)
cd server
npm install
npm run dev

# Terminal 2 — client (port 5175, proxies /api/* to the server)
cd client
npm install
npm run dev
```

Open http://localhost:5175.

## Ports

- Client dev: `5175`
- Server: `5008`

Chosen to avoid collisions with `example-frontend` (5000/3001), `example-bounty-program` (5005–5006/5173), and `example-agents` (5007/5174).

## Arbiter watchdog alerts

The `/analytics` page has an **Arbiter Alerts** card fed by arbiter nodes
themselves: each node's `chainlink-health-watchdog.sh` (verdikta-arbiter repo)
runs from cron every ~2 minutes and can POST one JSON event per run —
`OK` heartbeat, `ALERT`, or `RECOVERED` — to this server's `POST /api/alerts`,
keyed by the node's on-chain operator address. Because healthy nodes heartbeat
continuously, the server also flags operators whose reports **stop** ("Not
reporting") — the only way to notice an arbiter whose whole machine went dark.

Authentication is **signature-first, zero-config**: the watchdog signs each
event with the operator owner's key (EIP-191 personal message, computed
locally on the node — no transaction, no gas) and sends `signer` + `sig`. The
server recovers the signer, requires a fresh `ts` (10-minute replay bound),
and requires the signer to equal the operator contract's on-chain `owner()`.
Any freshly installed, registered arbiter can therefore report immediately —
no secret to distribute, and no cross-operator spoofing.

Server setup (nothing required for signed events; optional knobs):

```bash
# OPTIONAL fallback: enables unsigned events carrying this X-Watchdog-Token
# header, for nodes that cannot sign. Unsigned ingestion is 503 without it.
ALERTS_INGEST_TOKEN="<shared token>"
ALERTS_STALE_AFTER_MINUTES=10             # optional; heartbeat staleness window
```

Node-operator setup (in the arbiter install's `installer/.env`; the install
script offers to configure this):

```bash
WATCHDOG_ALERT_WEBHOOK="https://arbiters.verdikta.org/api/alerts"
# WATCHDOG_ALERT_TOKEN only needed if the node cannot sign
```

Events are validated (signature or token, plus operator address registered in
the keeper) and persisted per network to `server/data/{network}/alerts.json`
(same pattern as the gas-receipt store). The Operator Reliability tables show
a colored dot for operators that report. Read path: `GET /api/alerts?network=`.

## Notes

- No wallet / IPFS code yet. Keep it that way until the feature set demands it.
- Read-only blockchain access is intentional: the `/analytics` page reads arbiter/oracle data from the Verdikta aggregator + ReputationKeeper contracts via ethers (no wallet, no writes, no IPFS). A network toggle (Base mainnet / Base Sepolia) is exposed in the UI; the server reads each network over a public RPC (PublicNode), so no API keys are required. Override with `RPC_URL` / `INFURA_API_KEY` for a private endpoint.
- The one write-ish surface is `POST /api/alerts` (arbiter watchdog webhooks, see above) — token-gated, off by default.
- Visual theme mirrors `example-bounty-program` (shared CSS variables and components). Keep in sync when the design system evolves.
