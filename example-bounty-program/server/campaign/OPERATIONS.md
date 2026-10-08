# Zealy campaign verifier

This opt-in service implements the owner's revised “Bring a Task, Build a Habit” rules. It automatically verifies structural eligibility from the current Base escrow, records exceptions and successful claims, and never transfers funds or reserves Zealy rewards. All deployment, quest publication and funding remain separate owner actions.

## Installation and safe startup

Use Node >=20.18. Run `npm ci` in both `example-bounty-program/server` and `skills/verdikta-discover`. Deploy the shared skill scripts/schemas/templates and `example-bounty-program/onchain/abi/BountyEscrow.json` with the server. No new runtime dependency is required.

With `ZEALY_CAMPAIGN_CONFIG` unset the campaign is disabled. Otherwise point it to a private copy of `config.example.json`; set `ZEALY_API_KEY` to a random secret of at least 32 characters. Set the existing server RPC configuration to an archive-capable Base mainnet provider. Fill the approved UTC start, exact minimum original wei, actual Zealy IDs, reviewed team wallets, durable state path and exceptions path. The example is intentionally incomplete. Its one deployment is current escrow `0xa741eff41bcf14793e61cebb4179e05c9124d3f6`, creation block 51,224,966; independently check its runtime code hash before enabling.

Malformed/missing configuration, bad state or an active writer lock disables only campaign verification: HTTP 400 `VERIFICATION_UNAVAILABLE_RETRY` and health 503. Ordinary bounty routes continue. Startup logs one sanitized warning, without secret/configuration contents. There is no automatic deployment or configuration of live services.

Run one campaign writer on local durable storage; no clustered/NFS writer support. The PID lock is exclusively acquired. A dead PID's lock is reclaimed under an exclusive reclamation guard; a live PID, invalid lock or uncertain process liveness disables the campaign in the second process. After an interrupted reclamation, an operator must inspect and remove the `.reclaim` directory when safe. Atomic writes and file/directory fsync protect the ledger and separate claim records. Disk failure refuses success until repaired/restarted.

State schema is now version 2. Previous draft state/policy is not silently reinterpreted. Before upgrading any pilot with existing verified claims, preserve both state files and explicitly migrate successful bindings and audit evidence; the installer otherwise disables verification. This PR has not deployed either version.

## Campaign policy

Activity runs in `[start, start + 21 days)`; the claim/correction grace period ends exclusively at `start + 24 days`. Grace verifies already-timely actions, never late creations/submissions/results/payments. Store event and claim timestamps as UTC Unix seconds; operator review timestamps are UTC ISO strings.

`minimumWindowHours` defaults to **4**, `maximumWindowHours` to **336**. The deadline minus creation time must fall within the inclusive bounds; otherwise the response uses `SUBMISSION_WINDOW_OUT_OF_RANGE`. Minimum original funding is a fixed launch-time wei threshold, never a floating USD check. Original funding comes from `BountyCreated`, not the remaining payout balance.

“New” means **new to the configured current deployment**. Q4/Q6 exclude wallets with a current-escrow `BountyCreated` before start; Q10 excludes wallets with a current-escrow `SubmissionPrepared` before start. Optional `priorWallets.creators` and `.hunters` arrays also exclude supplied wallets (empty by default). No retired contract indexing occurs. Publish this scoped definition; do not advertise first-ever product usage.

The policy hash covers only id, communityId, subdomain, start, minimumWei, window bounds, teamWallets, quests, approved snapshots, the single deployment and priorWallets. Paths, polling/age/chunk/confirmation settings and free-text notes do not change identity policy. Secrets are excluded. Eligibility changes require a deliberate policy/state migration, not deletion of earned claims.

## Structural evidence and quest rules

A qualifying bounty must be on the configured Base escrow, timely, sufficiently funded, non-targeted, within window bounds, and have valid original evidence. No per-bounty approval entry is required. Denied scopes and held wallets never qualify. Shared scope digests among campaign bounties hold all copies. Distinct digests and different wallets are automatic campaign rules, not proof of useful work or independent people; inspect flagged cases and perform the owner's sample audit separately.

| Quest | Automatic requirements |
| --- | --- |
| Q3 | Funded qualifying bounty by claimant; custom rubrics count; later refund does not erase posting XP |
| Q4 | New current-deployment creator; approved work order or reviewed custom cash exception; actual timely payment to an eligible hunter |
| Q5 | Two qualifying distinct scope digests, including custom rubrics; second created after first payment and >=72h after first creation |
| Q6 | Q5 pair, both cash-eligible and paid, new current-deployment creator, two different hunter winners |
| Q8 | Qualifying bounty, valid hunter package, started and completed passing result in campaign; custom rubrics and creator approval count; payment not required |
| Q9 | Q8 plus actual timely payment to claimant winner |
| Q10 | New current-deployment hunter; passing cash-eligible bounties from two different creators with distinct scopes, >=72h between submission times, at least one actual payment, second creator non-team |
| Q14 | Approved template work order funded by claimant; refund does not erase posting XP; this does not prove Hermes installation/use |
| Q15 | Q5 pair using two different approved work-order templates; custom cash exceptions cannot satisfy template quests |

Eligible paid hunter: not the creator, not team, not held; when creator and hunter are both Zealy-bound, they must map to different user hashes. A prepared/upload-only submission never passes. `CreatorApproved` marks the prepared submission as started/passed/finalized at approval, like the on-chain PassedPaid status. Smart-contract wallets use the exact escrow creator/hunter address: never substitute transaction sender, relayer, funder or owner EOA.

`PayoutSent` followed immediately by matching `PaymentDeferred` is an unpaid credit. Same-contract recipient `Withdrawn` pays all earlier credits because the current escrow withdraws the full balance. Withdrawal time is payment time. Residual `CreatorRefunded` after an award is not cancellation; `BountyClosed` marks refunded. Q3/Q14 ignore that refund, while other milestones retain their completion/payment requirements.

### Two archive kinds and approved versions

A `custom` evaluation needs a readable bounded ZIP, valid manifest/primary query and a `gradingRubric` CID whose JSON contains at least one criterion. Its scope digest is SHA-256 of the exact primary query text. Its hunter archive must pass the existing shape validator and have a nonempty primary work-product query. On-chain start/approval and passing-result checks remain mandatory; merely uploading an archive never qualifies.

A `workOrder` uses the shared description parser, request/result schemas, intact request hash, and an approved rubric/threshold snapshot. The existing evaluation-query builder reconstructs the canonical query to detect added or weakened instructions. Its scope digest is the request digest. Hunter delivery requires referenced `result.json` and nonempty `evidence.md`; real-world task attachments declared in results must also be delivered. Missing/unavailable/invalid evidence never passes. `NOT_A_WORK_ORDER` classifies a valid ordinary custom archive; a corrupt or ambiguous work-order commitment stays invalid instead of silently earning template/cash eligibility.

`approvedTemplates` contains `{id, version, sha256, rubric, threshold}` snapshots. Several versions per template ID are supported. Rubric comparison canonicalizes existing field aliases (`description`/`instructions`, forbidden-content casing) and compares title, criteria and forbidden content. `sha256` commits to id/version/canonical rubric/threshold. `npm run campaign:inspect -- --templates` prints installed snapshots for operator review/copy. The verifier compares on-chain evidence against configured snapshots; an installed rubric change does not invalidate an approved older rubric. Request/result schema compatibility still uses the shared validator. Add any desired older snapshot deliberately before freezing campaign policy.

Only bare chain-derived CIDs reach the existing gateway fetcher; URLs in claims or task text are never fetched. Downloads are capped at 4 MiB, ZIPs at 100 entries / 8 MiB expanded, individual inspected entries at 1 MiB. Gateways remain trusted to return CID contents, consistent with the existing application.

Terminal malformed packages, invalid results and rubric mismatches are negatively cached and not refetched under the same validation context. Successful parsed custom/work-order evidence also persists. Gateway/timeouts are cached by CID with retries after 5, 10, 20, 40, then 60 minutes (one-hour maximum backoff); interim cycles make no request. Validation outcomes additionally include policy/threshold or scope context so reuse of a hunter CID against a different request cannot inherit an earlier success/failure incorrectly. An approved policy migration can revalidate against new snapshots. Health/export displays cached reasons; no secret URLs are retained.

## Exceptions and identity releases

Start with `exceptions.example.json` (all empty). The file is reread every reconcile. Missing/invalid JSON, wrong keys, malformed addresses or review records hold all verification with `EXCEPTIONS_FILE_INVALID`. Every entry needs nonempty `reviewer`, `reason` and valid UTC `reviewedAt`. Use full `8453:lowercaseEscrow:bountyId` keys and lowercase wallets. Update the file atomically.

```json
{
  "denyBounties": {
    "8453:0xa741eff41bcf14793e61cebb4179e05c9124d3f6:123": {
      "reviewer": "operator-id", "reviewedAt": "2026-10-08T12:00:00Z", "reason": "Reviewed duplicate or abusive activity"
    }
  },
  "allowCashBounties": {},
  "holdWallets": {},
  "identityReleases": []
}
```

The date/key above illustrate syntax, not a live exception. `allowCashBounties` uses the same review shape to grant a structurally valid custom bounty cash eligibility. It bypasses only the template requirement for Q4/Q6/Q10, never funding, timing, identity, payment, deny or hold checks. `holdWallets` maps a wallet to the review shape. File access is the administrative authorization boundary; no HTTP approval endpoint exists.

Users and wallets bind bidirectionally **only after VERIFIED**, persisted before HTTP success. Failed claims do not bind. A mismatched claim returns `IDENTITY_REVIEW_REQUIRED` without poisoning the established pair. To release a reviewed pair, use an export's userHash:

```json
{"userHash":"64-character-lowercase-hash-from-export","wallet":"0x1111111111111111111111111111111111111111","reviewer":"operator-id","reviewedAt":"2026-10-08T12:00:00Z","reason":"Verified ownership correction"}
```

Each full release record is applied once and retained. Leaving it in the file never repeatedly clears a subsequent binding. Change reviewedAt/reason to record a separately reviewed release. The exact current pair must match. Previous verified milestone records remain available for Zealy reconciliation; a release neither revokes nor recreates a Zealy reward.

## Finality and readiness

Reconciliation is outside HTTP claims. It scans current-escrow logs in chunks through `min(RPC finalized, latest - confirmations)`, checking Base chain ID, runtime hash, block/log hashes, `bountyCount` and per-bounty `submissionCount`. The creation boundary (`getCode(fromBlock-1)`) runs once, recorded only after successful reconciliation. Original numeric IDs remain namespaced by chain and contract.

A lower finalized checkpoint is a lagging RPC: mark stale with `RPC_LAGGING_RETRY`, preserve all logs/evidence and retry. Only a hash mismatch at the prior checkpoint clears the projection and starts a rebuild next cycle. Missing checkpoints, RPC failures and stale snapshots cannot approve. RPC outages during chain reads hold the generation. CID failures hold affected evidence while valid independent bounties can still qualify. Previously successful requests always re-evaluate current eligibility.

The RPC's finalized assertion is trusted; this is not independent consensus verification. A deep finalized reorg or later denial cannot revoke an already-accepted Zealy task automatically. Reconcile such cases using the audit and Zealy review tools. Sample settings (20 confirmations, one-hour maximum age, one-minute polling, 2,000-block chunks) require operator validation against the selected RPC and expected load.

`GET /api/campaign/health` returns only readiness/category/current-history completeness (200/503). Claims use cached state and no RPC/IPFS call. Check response latency below ten seconds at expected data volume. Protect ingress with TLS and appropriate rate limiting; never log secret headers or claim bodies.

## Zealy tasks and responses

[API task documentation](https://zealy.io/docs/tasks/api) and [task schema](https://api-v2.zealy.io/swagger.json) define the endpoint contract. Set once-only API tasks for Q3/Q4/Q5/Q6/Q8/Q9/Q10/Q14/Q15, with actual IDs in configuration:

```json
{"endpoint":"https://YOUR_BOUNTY_API/api/campaign/verify","identifications":["wallet"],"network":"base-mainnet","apiKey":"PRIVATE_ENVIRONMENT_SECRET"}
```

Dependencies: Q3←Q1, Q4←Q3, Q5←Q3, Q6←Q5, Q8←Q1, Q9←Q8, Q10←Q9, Q14←Q3, Q15←Q5. Q12 stays native Invites with `mandatoryQuests:[ACTUAL_Q4_ID]`, `minInviteUserCount:1`. Keep Q4 claimable for XP after its cash slots fill, preserving referral qualification.

```json
{"userId":"zealy-user-id","communityId":"configured-community-id","subdomain":"configured-subdomain","questId":"configured-quest-uuid","requestId":"zealy-request-id","accounts":{"wallet":"0x1111111111111111111111111111111111111111"}}
```

Send the secret only in `X-Api-Key`. Normal claim bodies have an 8 KiB limit. Responses contain a plain sentence followed by `[CODE]`: HTTP 200 only for `Verified: you completed this campaign milestone. [VERIFIED]`; otherwise HTTP 400, for example `Not verified yet: your bounty has not paid an eligible hunter inside the campaign window. Retry after settlement. [PAYMENT_NOT_RECEIVED_IN_WINDOW]`. Authentication, JSON, operational and exception errors are sanitized, never raw exception messages. Retry pending/service failures after five minutes; gateway backoff may take longer.

There is no internal entitlement/reservation layer or wallet-progress endpoint. Verification writes only identity/audit state. Zealy owns once-only completion and FCFS cash inventory. A lost HTTP response is safe to retry; HTTP 200 is not evidence that Zealy accepted or paid a reward. Proposed inventories remain 20×$6 Q4, 12×$10 Q6, 16×$5 Q10, 8×$5 Q12, plus four separately authorized $10-equivalent ETH starter bounties; nothing here funds them.

## Export, retention and pilot

`npm run campaign:inspect -- /absolute/state/ledger.json` is a host-only read. It prints current coverage, exception/error evidence, user hashes and bindings for releases, successful cash-quest claims with evidence keys for the owner's 10% sample audit, all verified milestones, unsuccessful diagnostics and deduplicated transactions. It excludes raw Zealy IDs, social/email fields, submitted request bodies and secrets. Wallet/user hashes are pseudonymous, not anonymous.

Retention decision: successful results are compacted by `(userHash, wallet, quest)` in `verifiedClaims`, separate from the evictable diagnostic tables. The latest successful evidence/request and firstVerifiedAt remain durable, even after a later failed retry. `attempts` (10,000) and `audit` (20,000) hold only unsuccessful diagnostics and evict oldest entries; a sanitized warning logs at 80%. Attempt volume never gates eligibility. Successful milestone storage grows with participants, not retry volume. Request-ID reuse checks apply to retained records; evicted unsuccessful request IDs are not a durable replay blacklist. There is no payment side effect to replay. Back up successful claims before any policy migration or retention cleanup.

For aggregate reporting, deduplicate bounties by full key and transactions by hash; sum original funding once and actual timely payments once (never count payout plus withdrawal twice). Separate team activity, custom/work-order mix, cash exceptions, current-deployment newness and supplied prior-wallet exclusions. Join Zealy's accepted task/reward export to verified claims for actual rewards and referrals. New-wallet counts do not prove unique humans. Suggested retention extends through grace and the owner's 30-day returning-usage analysis, then keeps only agreed dispute/accounting records and aggregate metrics.

Before launch:

1. Complete policy, exact wei/UTC cutoffs/IDs/exclusions, current escrow creation/code checks and approved snapshots. Confirm successful full current-deployment backfill.
2. Pilot custom XP, automatic work-order cash, a denied/held claim and a reviewed custom cash exception. Verify actual Zealy smart-wallet authentication matches the chain wallet.
3. Test invalid configuration/live-lock startup isolation, RPC staleness/recovery, cached IPFS failures, exceptions reload and latency with realistic claim counts.
4. With separate authorization and funds, verify actual direct payment and deferred withdrawal. Deterministic tests are not a production payment rehearsal.
5. Configure unpublished tasks, native Q12 and managed USDC inventories; check Q4 XP after cash exhaustion and reconcile accepted Zealy outcomes. Begin the owner's 10% cash-claim sample audit.

Remaining developer/operator work is production configuration, current-escrow RPC/finality/load checks, Zealy wallet and inventory integration checks, and the separately authorized pilot. No retired-deployment audit or per-bounty manual gate is required.

Tests: `npm run test:campaign`, `npm test -- --runInBand --coverage=false`, `npm run lint`. Campaign tests use only deterministic data and vendored public archive bytes; no network, transactions or paid service calls. ESLint now checks server syntax and applies recommended, descriptive-identifier and one-statement-per-line rules to campaign code and its inspection command, without rewriting unrelated server code.
