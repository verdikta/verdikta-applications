# Example Arbiters

Peer project to `example-bounty-program`: the Verdikta Arbiters site. It shows
arbiter availability, reliability and contract configuration, and lets arbiter
owners register and manage their arbiters and claim ETH from their wallet.

It targets the **v2** ReputationAggregator / ReputationKeeper (see
`verdikta-dispatcher/reputationBasedAggregator/MIGRATION.md`). v2 is a
redeploy, not an upgrade: the v1 contracts are not read any more.

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

## Tests

```bash
cd server && npm test    # node --test: status derivation, registry rebuild, round outcome/blame
cd client && npm test    # vitest: registration parsing, descriptor, exit state, re-register tracker
```

## v2 contracts

### Configuration (placeholders)

The v2 aggregator address and the deploy blocks are **not known yet**.
`server/config.js` has `verdiktaAggregatorAddress: null`, `aggregatorFromBlock:
null` and `keeperFromBlock: null` for both networks, marked `PLACEHOLDER`. Until
they are filled in, every chain read answers "The v2 Verdikta aggregator is not
configured" (the home page shows "Not deployed yet"). They can also be set
without a code change:

```bash
AGGREGATOR_ADDRESS_BASE_SEPOLIA=0x…   AGGREGATOR_FROM_BLOCK_BASE_SEPOLIA=…   KEEPER_FROM_BLOCK_BASE_SEPOLIA=…
AGGREGATOR_ADDRESS_BASE=0x…           AGGREGATOR_FROM_BLOCK_BASE=…           KEEPER_FROM_BLOCK_BASE=…
```

One aggregator per network serves every jury size: each request carries its
own jury (K, M, N, P and the round timeout), so the site has no per-jury
aggregator list and no jury config. The Contracts and Analytics pages show the
owner's bounds instead (`maxJury()`, `maxTimeout()`, `tPlus()`), and each
round's jury is read with `getJury(aggId)`.

The keeper address is read from `aggregator.keeper()`. `KEEPER_FROM_BLOCK` must
be at or before the keeper's deployment: the keeper is deployed (and arbiters
may register) before the aggregator.

### How the server reads them

- **Registry.** The v2 keeper has no index getter. The server rebuilds the
  registered set from the keeper's `ArbiterRegistered` / `ArbiterRemoved` logs
  (scanned once from `keeperFromBlock`, then incrementally), and reads each key
  with `getArbiter`, `arbiterClasses` and `isFrozen`.
- **Status** (`server/utils/arbiterStatus.js`). v1's call counts, recent-score
  history and mild/severe thresholds are gone. Each arbiter gets one bucket,
  first match wins:
  - **blocked**: banned (flag 4), or `blockedUntil` in the future;
  - **inactive**: exiting (flag 8), paused (2), under-staked (32), or a fee above the aggregator's `maxOracleFee`;
  - **frozen**: re-syncing its hash chain (64), or a health call unanswered past `callDeadline`;
  - **at risk**: a quality or timeliness score at or below `points().major` (one more major miss reaches 0 and blocks it);
  - **new**: both scores still at `points().start` and no offenses;
  - **active**: otherwise.

  Every matching condition is also returned as `statusReasons` (shown as
  tooltips and notes).
- **Rounds** (`server/utils/roundModel.js`). Agg-history and the oracle-health
  scan use `getRoundInfo`, `getSlot` and the v2 events, judged against the
  round's own `M` and `N` (`getJury(aggId)`, cached: a round's jury is fixed at
  request). A failed round is charged to the drawn slots that
  never committed (commit-phase failure with fewer than M commits) or the
  promoted slots that never revealed (reveal-phase failure). No blame is charged
  for rounds no arbiter committed to (likely malformed), rounds that were never
  drawn, or rounds whose commit window was never closed or never promoted. The
  agg-history route still requires a `0x` + 64-hex aggId; v2 aggIds are
  sequential (`bytes32(roundId)`).

### Registering and exiting from My Arbiters

- **Register** sends `registerArbiter(oracle, jobId, fee, classes, 0x00…00)`
  after a wVDKA approval of `stakeRequirement`. A browser can't hold the
  arbiter's hash chain, so the site registers with head 0. The arbiter then
  **starts frozen and is not selectable** until its node's health job re-syncs
  onto a fresh chain and answers a health call, which it does on its own within
  a minute or so of the job running. The site says so before and after the
  transaction, and shows the arbiter as "Frozen (re-syncing)" until then.
  Operators can instead register from the node with `register-oracle.sh`
  (verdikta-arbiter installer), which creates the chain and the health job.
- **Exit** takes two steps: `requestExit` (the arbiter stops being selected at
  once), then `completeExit` once `exitAt` has passed (the unbonding period, 2
  days by default; not while blocked). Completing the exit refunds the stake.
- **Exit & register again** replaces v1's restart. Classes are fixed at
  registration, so changing them means exiting and registering again later.
  The planned fee and classes are kept in localStorage across the unbonding
  period. v2 keeps a key's scores and offenses, so nothing is reset.
- In place, with no exit: **Pause / Resume** (`setPaused`), **Change fee**
  (`setFee`), **Top up stake** (`topUpStake`, shown when under-staked), and
  **Send health call** (`requestHealthCall`, shown when frozen).
- **Claimable ETH** is the wallet's `ethOwed` on the aggregator: arbiter base
  fees and bonuses, a never-promoted round's committer shares (`CommitPayment`),
  arbiter pool payouts (`PoolPayment`), draw / promote rewards earned by calling
  `drawJury` or `promote`, and requester refunds. All are withdrawn with
  `withdrawEth()`.
- **The arbiter pool** is `ethOwed(address(0))`: the prepay of rounds that
  cannot be refunded (cancelled undrawn, beacon quorum missed, a seed-dependent
  draw failure after the beacon stage, and the indivisible rest of a
  never-promoted round). Nobody can withdraw it; each jury draw pays an eighth
  of it to one registered arbiter's owner, picked at random from the draw's
  seed. The Contracts page shows its balance, Analytics the rounds that fed it
  and the payouts per payee, and Agg History each round's share.
- The "Backup JSON" descriptor is version 2 (same fields as v1; v1 files still
  import, without their v1 keeper address).

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

Authentication is **signature-only, zero-config**: the watchdog signs each
event with the operator owner's key (EIP-191 personal message, computed
locally on the node — no transaction, no gas) and sends `signer` + `sig`. The
server recovers the signer, requires a fresh `ts` (10-minute replay bound),
and requires the signer to equal the operator contract's on-chain `owner()`.
Any freshly installed, registered arbiter can therefore report immediately —
there is deliberately **no shared secret** (a leaked fleet-wide token would
allow spoofing any operator's status, including fake "healthy" heartbeats
masking a real outage), and unsigned events are rejected with 401.

Server setup (nothing required; one optional knob):

```bash
ALERTS_STALE_AFTER_MINUTES=10             # optional; heartbeat staleness window
```

Node-operator setup (in the arbiter install's `installer/.env`; the install
script offers to configure this):

```bash
WATCHDOG_ALERT_WEBHOOK="https://arbiters.verdikta.org/api/alerts"
```

Events are validated (owner signature, plus operator address registered in
the keeper) and persisted per network to `server/data/{network}/alerts.json`
(same pattern as the gas-receipt store). The Operator Reliability tables show
a colored dot for operators that report. Read path: `GET /api/alerts?network=`.

### Reporting keys (nodes running under a different wallet)

Many operators run their nodes with an ops wallet that is *not* the operator
contract's `owner()`. Those nodes sign with a key the server doesn't recognize,
so every heartbeat is rejected with 403 and the arbiter shows as "not
reporting". Putting the owner key on the node is the wrong fix — it controls
the wVDKA stake, the keeper's exit and fee controls, and ETH earnings.

Instead the owner authorizes a **reporting key** from the **Reporting keys**
section on `/my-arbiters`: an EIP-191 message signed in the browser (no
transaction, no gas) naming an address allowed to report on its behalf until a
chosen expiry. Ingest then accepts owner *or* live delegate. The trust root is
unchanged — only `owner()` can authorize — and **nothing on the arbiter node
changes**; the watchdog keeps sending exactly the payload it sends today.

Delegations are scoped to (owner, network), so one signature covers every
operator that wallet owns, including ones registered later. They carry a hard
expiry (90 days by default, 1 year max) and can be revoked with a second
signature, which leaves a tombstone so a captured older authorization can't be
replayed. Stored per network in `server/data/{network}/reporters.json`.

Discovery: a validly-signed event from an unrecognized key is recorded as a
*pending reporter* before the 403 — so `/my-arbiters` shows "a node at
`<hostname>` is trying to report for operator `0x…` with key `0x…`" and a
one-click **Authorize**, rather than making the owner dig the address out of a
server log. A pending entry proves someone holds that key, not that it should
be trusted; authorizing still requires the owner's signature. The list is
bounded per operator and expires after a week of silence.

Delegation endpoints (all owner-signature gated, no shared secret):

```
GET  /api/alerts/delegations?network=&owner=        # authorized keys
POST /api/alerts/delegations                        # authorize (owner-signed)
POST /api/alerts/delegations/revoke                 # revoke (owner-signed)
GET  /api/alerts/pending-reporters?network=&owner=  # candidates to authorize
```

## Notes

- No IPFS code. Wallet writes live only on `/my-arbiters` (client-side, through the user's wallet); the server only reads.
- The `/analytics` page reads arbiter/oracle data from the Verdikta aggregator + ReputationKeeper contracts via ethers (no wallet, no writes, no IPFS). A network toggle (Base mainnet / Base Sepolia) is exposed in the UI; the server reads each network over a public RPC (PublicNode), so no API keys are required. Override with `RPC_URL` / `INFURA_API_KEY` for a private endpoint.
- The write surfaces are all under `/api/alerts`: `POST /api/alerts` (arbiter watchdog webhooks) and the reporting-key delegation endpoints (see above). Every one of them is gated on an EIP-191 signature checked against on-chain state — there is no shared secret and no server-side allow-list to maintain.
- Visual theme mirrors `example-bounty-program` (shared CSS variables and components). Keep in sync when the design system evolves.
