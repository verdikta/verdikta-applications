# Migration Summary — v1 → v2 aggregator

This document summarizes the port of `example-frontend` from the v1 ETH-funded
`ReputationAggregator` to the **v2** `ReputationAggregator` (verdikta-dispatcher,
`reputationBasedAggregator/contracts/ReputationAggregator.sol`; its `MIGRATION.md` lists the
contract changes). v2 is a redeploy, not an upgrade: the client no longer works with the v1
aggregators.

## Aggregator addresses

The v2 aggregator (one per network, serving every jury size) is **not deployed yet**. The v1 addresses were removed from
`client/.env.example`, the tracked `client/.env.backup`, `client/debug-contract.js` and the
fallbacks in `server/utils/contractsManager.js`.

| Network | Address |
|---|---|
| Base Mainnet | TODO after the v2 deploy (`V2_AGGREGATOR_ADDRESS_BASE` placeholder in `client/.env.example`) |
| Base Sepolia | TODO after the v2 deploy (`V2_AGGREGATOR_ADDRESS_BASE_SEPOLIA` placeholder) |

The server skips `.env` entries that are not addresses, so the placeholders offer no
aggregator. Its only built-in fallback is the optional `DEFAULT_AGGREGATOR_ADDRESS` in the
server's environment (`server/.env.example`).

## What changed in the protocol, as the client sees it

| v1 | v2 |
|---|---|
| `requestAIEvaluationWithApproval(cids, addendum, alpha, maxFee, baseCost, scaling, class)` | 10 arguments: `minFee` (fee floor, 0 = none) after `maxFee`, then `withBeacons` and the jury `(K, M, N, P, timeout)` at the end |
| one aggregator per jury size, with `K()`, `M()`, `N()`, `P()` and `responseTimeoutSeconds()` | one aggregator for every jury size: the jury is the request's. `getJury(aggId)` returns a round's `(K, M, N, P, timeout)`; the owner bounds requests with `maxJury()` (default 50), `maxTimeout()` (3600 s) and `tPlus()` (155 s). A request reverts `BadJury` unless K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, P ≥ 2 (unless N = 1), K ≤ `maxJury()` and the keeper's shortlist (60), and `tPlus()` < timeout ≤ `maxTimeout()`. With fewer than K eligible arbiters the draw repeats arbiters; it fails (refunded) only when none is eligible |
| `maxTotalFee(maxFee)` = `eff × (K + B×P)` | `maxTotalFee(maxFee, minFee, withBeacons, K, P)` = `max(eff, minFee) × (K + B×P [+ beacon quorum]) + eff × (2 + 1)`, for the jury the request will carry; 0.0018 ETH with the app's defaults (0.0001 ETH fee, Small jury K=6, P=3, B=3) |
| credit first, then `msg.value` | `msg.value` first, credit covers the shortfall, excess value goes to credit |
| `RequestAIEvaluation(requestId, cids)`, a hash | `RequestAIEvaluation(aggRequestId, cids)`, `aggId = bytes32(roundId)`, sequential from 1 |
| the request polls the arbiters | the request only escrows; the requester moves the round: `drawJury` from block B+2 (twice with beacons), `closeCommits` after T+ if needed, `promote` from the close block + 2 |
| `finalizeEvaluationTimeout(aggId)` after `responseTimeoutSeconds` from the request | `settle(aggId)` after the round's deadline (the jury's `timeout` from the draw); an undrawn round never times out, and `drawJury` reverts `DrawExpired` after a day |
| `getAggregationStatus`, `getContractConfig`, `EvaluationTimedOut`, `NotTimedOut`, `AggregationComplete`, `InactiveOracle` | `getRoundInfo` (phase 1 draw … 9 cancelled), `getJury(aggId)`, `maxJury()`/`maxTimeout()`/`tPlus()`, `EvaluationFailed(aggId, uint8 phase)`, `BadJury`, `WrongPhase`, `TooEarly`, `NotDue`, `SeedExpired`, `DrawExpired` |
| a failed round refunds the requester | refunded to the requester at settlement, except a missed beacon quorum, M commits never promoted, cancelled rounds, and a beacon round whose jury cannot be drawn after the stage while the keeper's walk does not cover the whole class list (`scansAll` false): those go to the treasury |
| | rewards: the draw (2 × fee, only the requester within 30 s) and promote (1 × fee) callers, credited to `ethOwed` |

## Files changed

### Code
- **`client/src/utils/contractUtils.js`** — v2 ABI: functions, events and errors; the request
  takes the jury tuple, `maxTotalFee` takes K and P, and `getJury`, `maxJury`, `maxTimeout`
  replace `K()`…`P()` and `responseTimeoutSeconds()`.
- **`client/src/utils/juryPresets.js`** (new) — the jury presets, a copy of the jury and beacon
  flag of `example-bounty-program/shared/classPresets.js` (CRA cannot import outside `src/`;
  `juryPresets.test.js` keeps them equal): Small 6/5/4/3, 300 s (the default); Medium
  8/5/4/3, 300 s; Large 21/16/13/10, 300 s; Jumbo 50/38/27/17, 600 s, with beacons.
- **`client/src/utils/timeoutUtils.js`** — the v1 wait-then-finalize flow is replaced by
  `driveRound()`: it reads `getRoundInfo` and, phase by phase, dry-runs (`estimateGas` from
  the user's address) and sends `drawJury`, `closeCommits`, `promote` and `settle` with the
  user's wallet, only when the dry run passes. The round's own jury comes from
  `getJury(aggId)`: its M decides whether the commit window could have been closed, and it
  reaches the timeline as `round.jury`. Gas: the estimate plus half; v1's 3-million
  floor is gone because the v2 calls revert with `OutOfGas` rather than fail quietly
  (measured on the dispatcher's v2 test network: `drawJury` 2.3–2.9M, `promote` 0.74M,
  `settle` 0.25M).
- **`client/src/pages/RunQuery.js`** — 10-argument request carrying the `jury` prop;
  5-argument quote (`maxFee, minFee, withBeacons, K, P`) in `computeEthFunding`, the credit
  banner and its default estimate; a `BadJury` message; reads `aggRequestId`;
  drives the round with `driveRound()`; keeps the open round in `localStorage` and offers to
  resume it after a reload; explains which wallet transactions follow and who earns what.
- **`client/src/components/RoundTimeline.js`** (new) — phase timeline: the round's jury (from
  `getJury`), phases, commits against M, deadline countdown, and the transactions the wallet sent with their rewards.
- **`client/src/components/TimeoutNotice.js`** — reports a failed round (and whether the
  refund came to the user or went to the treasury), a cancelled or expired round, or the
  call a round is waiting for, with a button that resumes it.
- **`client/src/App.js`** — the jury setting (`juryPreset` in `localStorage`, default Small),
  chosen with the "Arbiter jury size" selector on the Jury Selection page, gives Run Query
  `jury` and `withBeacons` (on for Jumbo); `MIN_FEE = 0n`;
  the round state is `runRoundInfo`; the `.env` fallback ignores entries that are not
  addresses.
- **`client/src/utils/contractDebugger.js`**, **`client/debug-contract.js`** — v2 ABI; they read
  `maxJury()`, `maxTimeout()`, `tPlus()` and check the request's jury against them; 10-argument
  dry run, 5-argument quote. The script takes the address from the command line or
  `AGGREGATOR_ADDRESS`, and the jury as `K/M/N/P/timeout` (default `6/5/4/3/300`).
- **`server/utils/contractsManager.js`** — no built-in v1 address (see above).

### Tests
- `timeoutUtils.test.js`, `components/TimeoutNotice.test.js` (also covers `RoundTimeline`)
  and `pages/RunQuery.timeout.test.js` (fakes ethers with a v2 round) cover the draw at B+2,
  the request's jury and 5-argument quote (Small by default, Jumbo with beacons), the round's
  jury from `getJury`, the beacon double draw, `closeCommits` (against the round's own M),
  `promote` at C+2, `settle` after a missed deadline,
  declined prompts and resuming, rounds moved by another account, and the rounds whose
  prepay goes to the treasury. `utils/juryPresets.test.js` checks the presets against
  `classPresets.js` and the jury rules.

## Earlier: LINK → ETH

Before v2, the client moved from the LINK-funded aggregator to the ETH-funded v1
aggregator: no token approval, the request became `payable`, unspent prepay became an
`ethOwed` credit withdrawn with `withdrawEth()`, and the LINK allowance code
(`topUpLinkAllowance`, `LINKTokenABI.json`) was removed. That part still holds in v2.

### Ops
- `rebuildAndRestart.sh` (project root) rebuilds the static client bundle, then restarts the
  services. The site is served from `client/build` and CRA bakes code and `REACT_APP_*` in
  at build time, so client changes (including the v2 addresses, once deployed) require a
  rebuild **and** restart.
