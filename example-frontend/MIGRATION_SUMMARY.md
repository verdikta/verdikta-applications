# Migration Summary — v1 → v2 aggregator

This document summarizes the port of `example-frontend` from the v1 ETH-funded
`ReputationAggregator` to the **v2** `ReputationAggregator` (verdikta-dispatcher,
`reputationBasedAggregator/contracts/ReputationAggregator.sol`; its `MIGRATION.md` lists the
contract changes). v2 is a redeploy, not an upgrade: the client no longer works with the v1
aggregators.

## Aggregator addresses

The v2 aggregators are **not deployed yet**. The v1 addresses were removed from
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
| `requestAIEvaluationWithApproval(cids, addendum, alpha, maxFee, baseCost, scaling, class)` | 9 arguments: `minFee` (fee floor, 0 = none) after `maxFee`, and `withBeacons` at the end |
| `maxTotalFee(maxFee)` = `eff × (K + B×P)` | `maxTotalFee(maxFee, minFee, withBeacons)` = `max(eff, minFee) × (K + B×P [+ beacon quorum]) + eff × (2 + 1)`; 0.0018 ETH with the app's defaults (0.0001 ETH fee, K=6, B=3, P=3) |
| credit first, then `msg.value` | `msg.value` first, credit covers the shortfall, excess value goes to credit |
| `RequestAIEvaluation(requestId, cids)`, a hash | `RequestAIEvaluation(aggRequestId, cids)`, `aggId = bytes32(roundId)`, sequential from 1 |
| the request polls the arbiters | the request only escrows; the requester moves the round: `drawJury` from block B+2 (twice with beacons), `closeCommits` after T+ if needed, `promote` from the close block + 2 |
| `finalizeEvaluationTimeout(aggId)` after `responseTimeoutSeconds` from the request | `settle(aggId)` after the round's deadline (`responseTimeoutSeconds` from the draw); an undrawn round never times out, and `drawJury` reverts `DrawExpired` after a day |
| `getAggregationStatus`, `getContractConfig`, `EvaluationTimedOut`, `NotTimedOut`, `AggregationComplete`, `InactiveOracle` | `getRoundInfo` (phase 1 draw … 9 cancelled), `K()`/`M()`/`N()`/`P()`/`tPlus()`, `EvaluationFailed(aggId, uint8 phase)`, `WrongPhase`, `TooEarly`, `NotDue`, `SeedExpired`, `DrawExpired` |
| a failed round refunds the requester | refunded to the requester at settlement, except a missed beacon quorum, M commits never promoted, and cancelled rounds: those go to the treasury |
| | rewards: the draw (2 × fee, only the requester within 30 s) and promote (1 × fee) callers, credited to `ethOwed` |

## Files changed

### Code
- **`client/src/utils/contractUtils.js`** — v2 ABI: functions, events and errors.
- **`client/src/utils/timeoutUtils.js`** — the v1 wait-then-finalize flow is replaced by
  `driveRound()`: it reads `getRoundInfo` and, phase by phase, dry-runs (`estimateGas` from
  the user's address) and sends `drawJury`, `closeCommits`, `promote` and `settle` with the
  user's wallet, only when the dry run passes. Gas: the estimate plus half; v1's 3-million
  floor is gone because the v2 calls revert with `OutOfGas` rather than fail quietly
  (measured on the dispatcher's v2 test network: `drawJury` 2.3–2.9M, `promote` 0.74M,
  `settle` 0.25M).
- **`client/src/pages/RunQuery.js`** — 9-argument request; 3-argument quote in
  `computeEthFunding`, the credit banner and its default estimate; reads `aggRequestId`;
  drives the round with `driveRound()`; keeps the open round in `localStorage` and offers to
  resume it after a reload; explains which wallet transactions follow and who earns what.
- **`client/src/components/RoundTimeline.js`** (new) — phase timeline: phases, commits,
  deadline countdown, and the transactions the wallet sent with their rewards.
- **`client/src/components/TimeoutNotice.js`** — reports a failed round (and whether the
  refund came to the user or went to the treasury), a cancelled or expired round, or the
  call a round is waiting for, with a button that resumes it.
- **`client/src/App.js`** — `MIN_FEE = 0n` and `WITH_BEACONS = false`, passed to Run Query;
  the round state is `runRoundInfo`; the `.env` fallback ignores entries that are not
  addresses.
- **`client/src/utils/contractDebugger.js`**, **`client/debug-contract.js`** — v2 ABI and
  getters, 9-argument dry run, 3-argument quote; the script takes the address from the
  command line or `AGGREGATOR_ADDRESS`.
- **`server/utils/contractsManager.js`** — no built-in v1 address (see above).

### Tests
- `timeoutUtils.test.js`, `components/TimeoutNotice.test.js` (also covers `RoundTimeline`)
  and `pages/RunQuery.timeout.test.js` (fakes ethers with a v2 round) cover the draw at B+2,
  the beacon double draw, `closeCommits`, `promote` at C+2, `settle` after a missed deadline,
  declined prompts and resuming, rounds moved by another account, and the rounds whose
  prepay goes to the treasury.

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
