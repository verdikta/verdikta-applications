# 2.0.0 migration: BountyEscrow v2

2.0.0 moves the skill to BountyEscrow v2, built on the v2 aggregator: a two-phase jury draw, a hunter bond, and the Q-of-N decision rule with re-runs (dispatcher TODO items 8, 9, 12 and 15). The skill and the bounty server changed together. Nothing here needs an action from an existing installation beyond installing 2.0.0, but the agent's lifecycle is different, and 2.0.0 does not work until the v2 escrow is deployed.

## Not deployed yet

`scripts/deployments.json` holds placeholders for both networks (`"status": "NOT_DEPLOYED"`, `address` and `codeHash` null). Every script that reads or signs for the escrow stops with:

> BountyEscrow v2 is not deployed on <network> yet: scripts/deployments.json holds a placeholder ... A maintainer must update deployments.json with the reviewed v2 deployment (address, runtime codeHash) first; this version never uses the v1 escrow

The 2.0.0 scripts never fall back to the v1 escrow: the v1 `createBounty` struct is different, and so are its states. Onboarding, the API identity, the read-only job listing and `withdraw_to_owner.js` keep working. To finish a bounty or submission that is already on the v1 escrow (a claim, a close, a pull-ledger withdrawal), keep a 1.9.x copy of the skill for it. A maintainer records the v2 deployment once it is reviewed; the live `/api/docs` must then document the v2 `createBounty` struct and `startValue`, or the selector check fails closed.

## Creating a bounty: size classes, Q, R and the bond

`createBounty` takes the v2 `CreateParams`: the oracle struct gains `minOracleFee` (a fee floor: every juror is paid at least this) and `withBeacons`, and the bounty gains `jury` (its own `{K, M, N, P, timeout}`: K drawn, M promoted, N counted, P clustered, the round timeout in seconds; one aggregator, `aggregator()`, serves every jury size and each request carries the jury), `quota` (Q), `forfeitLine` (R ≤ Q) and `bond` (wei each hunter posts at start).

A round has N juror scores. At least Q at or above the threshold is a **pass** (paid, bond back). Fewer than R is a **hard fail** (the submission fails and its bond goes to the creator). In between is a **soft fail**: the submission may re-run.

The settings start from a size-class preset, the site's and API's own (`scripts/_class-presets.cjs`): Bondless Small, Small, Medium, Large, Jumbo. In the creator config:

- `bountyClass`: the preset. Without one, the smallest class offered for `bountyAmount` at `ethUsd`, else Bondless Small.
- `ethUsd`: an owner-reviewed ETH price, needed only to convert a preset's USD bond or fee floor (Small and up have a bond; Medium and up a floor).
- `jury` (any of `K`, `M`, `N`, `P`, `timeout`, over the preset's), `quota`, `forfeitLine`, `bond` (wei), `oracle.minOracleFee` (wei), `oracle.withBeacons`: overrides.

`create_bounty.js` sends every setting to `/jobs/create` explicitly, so the server never picks a class or converts a price for the bounty. It checks the escrow's rule for the jury (K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, Q ≤ N), the aggregator's live fee ceiling and jury limits, and shows the class, Q, R, bond, floor and beacons in every review. See [commission configuration](commission.md). The 1.x config shape still works and means Bondless Small: no bond, no floor, Q 3 of 4, R 1.

Wagers use new templates for v2, `mutual-wager-v6` (games, replacing v3) and `mutual-wager-v7` (questions, replacing v5). Their terms add a Decision settings line (`jury 0, quota 3, forfeitLine 1, bondWei 0.` by default: Bondless Small) and the fee floor and beacon flag on the Oracle settings line (`..., minOracleFeeEth 0.0, withBeacons false.`), and the jury checks the counter's `decisionSettings` against them. `wager.js propose` takes other settings from `decision` and `oracle.minOracleFeeEth`/`oracle.withBeacons` in `wager-defaults.json` and refuses a bond; `answer` copies the offer's; `check` refuses a counter bounty whose site record or escrow read differs from the terms. v3, v4 and v5 bounties already posted are still checked and claimed, but never answered or funded (a v3/v5 pair on the v2 escrow is held to Bondless Small).

## Starting: startValue, then the draw

A start attaches `startValue(bountyId)` = `requiredPrepay(bountyId)` + the bond, not `requiredPrepay` alone; `submit_to_bounty.js` reads it live and shows the split. The server's `/start` returns it as `transaction.value`, with `prepayWei` and `bondWei`.

After the start the round must be **drawn**: `drawJury(bountyId, submissionId)` from two blocks after the start (twice on a beacon bounty), then `closeCommits(aggId)` and `promote(aggId)` on the escrow's aggregator (`aggregator()`). Anyone may send them, and the server's keeper usually does. An agent can push its own round with `claim_bounty.js`, one step per run.

## Resolving: nextAction

`claim_bounty.js` reads the escrow's `nextAction` and sends the one call it names:

| nextAction | What the agent does |
| --- | --- |
| START | `submit_to_bounty.js --resume <id>` (attaches startValue) |
| DRAW | `claim_bounty.js`: `drawJury` (escrow) |
| CLOSE_COMMITS, PROMOTE | `claim_bounty.js`: `closeCommits` / `promote` on the escrow's aggregator |
| FINALIZE | `claim_bounty.js`: `finalizeSubmission` (pass: paid; soft fail: awaits a re-run; hard fail: bond to the creator) |
| CLOSE_FAILED | `claim_bounty.js`: `closeFailedRound` (no result and none can come; replaces v1 `failTimedOutSubmission`/FORCE_FAIL) |
| RERUN | `claim_bounty.js --rerun`, only with the owner's approval: `rerunSubmission` with a fresh `requiredPrepay` |
| EXPIRE_RERUN | `claim_bounty.js`: `expireRerun` (the bond comes back) |
| RECOVER_REFUND | `claim_bounty.js`: `recoverLeftoverEth` |
| AWAIT_ORACLE, AWAIT_EARLIER, AWAIT_SLOT, AWAIT_EXPIRY, AWAIT_CREATOR | wait |
| DONE, DEAD | nothing left to do |

FORCE_FAIL is gone. In v1 "FINALIZE without a stored result" meant a timed-out round with enough answers; in v2 a round without a result is always CLOSE_FAILED, and FINALIZE always has a result.

`closeFailedRound` settles the round on the aggregator inside a try/catch and can need well over 1.5M gas on a large jury; the executor never gives it less than 2,500,000 (keep `maxGasLimit` at 6,000,000 or more).

## Re-runs

A soft fail, or a round with no result, puts the submission in **AwaitingRerun** (on-chain status 6) until `rerunDeadline`: 2 hours after the round resolved, and before the bounty's deadline. The hunter or the bond's funder may re-run it with `requiredPrepay` (a new jury, same wallet), keeping its place in the payout queue and its bond, up to 6 rounds in all. A re-run is a new spend: the agent asks the owner and passes `--rerun`. If nobody re-runs it, anyone may `expireRerun` it once the window closes; it fails with its bond returned.

## Closing an expired bounty

The close needs the pending list empty: rounds in flight and submissions awaiting a re-run. `recover_funds.js --close` (and `wager.js close`) clears this wallet's expired bounty first with `finalizeSubmission` (a result that does not pass), `closeFailedRound` (no result) or `expireRerun`; a passing claim or a round still moving stops it, and the retry time comes from the round's deadline (a day after the request while undrawn). The escrow's `canBeClosed` counts only rounds in flight, so the script also checks `pendingSubmissionIds`.

## Reading state

- `getOracleResult` returns a struct: `started`, `hasResult`, `phase`, `outcome` (0 not ready, 1 no result, 2 pass, 3 soft fail, 4 hard fail), `rounds`, `passCount`, `deadline`, `requestTime`, `scores`, `justificationCids`. `startTimestamp`, `settled` and `failed` are gone; the aggregator's `responseTimeoutSeconds` is gone: a round's timeout is its jury's (`getJury(aggId)`), run from the draw.
- `getSubmission` adds `bondFunder`, `bondHeld`, `rerunDeadline`, `rounds`, `passCount`; `getBounty` adds the jury flat (`juryK`, `juryM`, `juryN`, `juryP`, `juryTimeout`), `quota`, `forfeitLine`, `bond`. The escrow has one `aggregator()`; `aggregators(i)`, `aggregatorCount()` and `aggregatorOf(id)` are gone. With fewer than K eligible arbiters the keeper repeats arbiters to fill the jury; a draw fails only when none is eligible.
- Server: `/refresh` reports `SOFT_FAIL_PENDING_FINALIZATION`, `NO_RESULT_PENDING_CLOSE` and `AWAITING_RERUN`, and `failureReason` `NO_RESULT` or `RERUN_EXPIRED`; `/finalize` returns `oracleResult.outcome`, `passCount` and `effect`; `/diagnose` returns `checks.onChain.round`; `GET /:jobId/onchain-status` returns `requiredPrepay`, `startValue` and `decisionSettings`.
- New endpoints: `POST .../draw`, `.../round-step`, `.../rerun`, `.../expire-rerun`, `.../close-failed` (`.../timeout` is its v1 alias). See [API endpoints](api_endpoints.md#round-steps-v2).
