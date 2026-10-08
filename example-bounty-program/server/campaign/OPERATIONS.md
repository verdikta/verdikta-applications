# Zealy campaign verifier

This opt-in service implements the owner's revised “Bring a Task, Build a Habit” rules. It automatically verifies structural eligibility from the current Base escrow, records exceptions and successful claims, and never transfers funds or reserves Zealy rewards. All deployment, quest publication and funding remain separate owner actions.

## Installation and safe startup

Use Node >=20.18. Run `npm ci` in both `example-bounty-program/server` and `skills/verdikta-discover`. Deploy the shared skill scripts/schemas/templates and `example-bounty-program/onchain/abi/BountyEscrow.json` with the server. No new runtime dependency is required.

With `ZEALY_CAMPAIGN_CONFIG` unset the campaign is disabled. Otherwise point it to a private copy of `config.example.json`; set `ZEALY_API_KEY` to a random secret of at least 32 characters. Set the existing server RPC configuration to an archive-capable Base mainnet provider. Fill the approved UTC start, exact minimum original wei, actual Zealy IDs, reviewed team wallets, durable state path and exceptions path. The example is intentionally incomplete. Its one deployment is current escrow `0xa741eff41bcf14793e61cebb4179e05c9124d3f6`, creation block 51,224,966; independently check its runtime code hash before enabling.

Malformed/missing configuration, bad state or an active writer lock disables only campaign verification: HTTP 400 `VERIFICATION_UNAVAILABLE_RETRY` and health 503. Disabled-startup health includes only a sanitized `reason`: `CONFIG_INVALID`, `STATE_MISMATCH` (including unreadable state/storage), or `WRITER_ACTIVE`. Deployments must alert on health 503; log collection must also surface the sanitized per-cycle evidence-check warning. Ordinary bounty routes continue. Startup logs one sanitized warning, without secret/configuration contents. There is no automatic deployment or configuration of live services.

Run one campaign writer on local durable storage; no clustered/NFS writer support. The PID lock is exclusively acquired. A dead PID's lock is reclaimed under an exclusive reclamation guard; a live PID, invalid lock or uncertain process liveness disables the campaign in the second process. After an interrupted reclamation, an operator must inspect and remove the `.reclaim` directory when safe. Atomic writes and file/directory fsync protect the ledger and separate claim records. Disk failure refuses success until repaired/restarted.

State schema is now version 2. Previous draft state/policy is not silently reinterpreted. Before upgrading any pilot with existing verified claims, preserve both state files and explicitly migrate successful bindings and audit evidence; the installer otherwise disables verification. This PR has not deployed either version.

## Campaign policy

Activity runs in `[start, start + 21 days)`; the claim/correction grace period ends exclusively at `start + 24 days`. Grace verifies already-timely actions, never late creations/submissions/results/payments. Store event and claim timestamps as UTC Unix seconds; operator review timestamps are UTC ISO strings.

`minimumWindowHours` defaults to **4**, `maximumWindowHours` to **336**. The deadline minus creation time must fall within the inclusive bounds; otherwise the response uses `SUBMISSION_WINDOW_OUT_OF_RANGE`. Minimum original funding is a fixed launch-time wei threshold, never a floating USD check. Original funding comes from `BountyCreated`, not the remaining payout balance.

“New” means **new to the configured current deployment**. Q4/Q6 exclude wallets with a current-escrow `BountyCreated` before start; Q10 excludes wallets with a current-escrow `SubmissionPrepared` before start. Optional `priorWallets.creators` and `.hunters` arrays also exclude supplied wallets (empty by default). No retired contract indexing occurs. Publish this scoped definition; do not advertise first-ever product usage.

The identity policy hash covers id, communityId, subdomain, start, minimumWei, window bounds, teamWallets, quests, the single deployment and priorWallets, plus houseHunterWallets when nonempty. Approved snapshots are separate: `snapshotSetHash` is the digest of the sorted snapshot sha256 values and is recorded on every verified claim. Paths, polling/age/chunk/confirmation settings and free-text notes do not change identity policy. Secrets are excluded. Changes to those identity-policy fields require a deliberate policy/state migration, not deletion of earned claims. Adding an approved snapshot is additive and takes effect on restart without an identity-state migration; it changes `snapshotSetHash` and triggers evidence revalidation. Removing a previously recorded snapshot mid-campaign is unsupported and disables startup with `STATE_MISMATCH`. A state file written by the earlier draft whose identity hash included snapshots still needs a one-time explicit upgrade preserving successful claims; subsequent additions do not.

### Trusted house hunters

`houseHunterWallets` defaults to an empty array and must contain unique normalized addresses from `teamWallets`. Configure only explicitly approved fulfillment wallets. All team wallets, including house hunters, remain excluded from every API quest as claimants. Team creators cannot earn creator cash.

A non-team creator's actual payment to an approved house hunter can satisfy Q4 and the first-payment prerequisite of Q5/Q6/Q15. Q6 permits the same approved house hunter to win both bounties; ordinary hunters still require different winning wallets. Separate bounty IDs, distinct scopes, >=72h creation spacing, second creation after first payment, timely settlement, funding, evidence, template/cash-exception rules, newness and finality all remain required. Self-payment, held accounts, denied bounties, shared bound identity and unwithdrawn deferred credits never qualify.

This relaxation applies only to creator payment milestones. External hunters can still earn Q9 on team starter bounties; Q9 is not a first-ever-hunter test. Q10 still requires a later bounty from a different non-team creator and its existing newness/timing conditions.

Omitting the allowlist or leaving it empty preserves the existing identity policy hash and state compatibility. Enabling it or changing a nonempty list changes the policy hash: configure it before creating campaign state, or explicitly migrate existing ledger/claims together while preserving bindings, verified milestones and audit records. Do not delete earned claims to reset the policy. Snapshot additions remain independently additive as described above.

## Structural evidence and quest rules

A qualifying bounty must be on the configured Base escrow, timely, sufficiently funded, non-targeted, within window bounds, and have valid original evidence. No per-bounty approval entry is required. Denied scopes and held wallets never qualify. Shared scope digests among non-refunded, non-denied campaign bounties hold those copies. Denying or refunding one copy removes it from the count and releases the other; excluded copies have `duplicate: false`. A denied bounty remains ineligible. Q3/Q14 still preserve posting credit after a refund, as required by their quest rules. Distinct digests and different wallets are automatic campaign rules, not proof of useful work or independent people; inspect flagged cases and perform the owner's sample audit separately.

| Quest | Automatic requirements |
| --- | --- |
| Q3 | Funded qualifying bounty by claimant; custom rubrics count; later refund does not erase posting XP |
| Q4 | New current-deployment creator; approved work order or reviewed custom cash exception; actual timely payment to an eligible hunter |
| Q5 | Two qualifying distinct scope digests, including custom rubrics; second created after first payment and >=72h after first creation |
| Q6 | Q5 pair, both cash-eligible and paid, new current-deployment creator, two different hunter winners or the same approved house hunter |
| Q8 | Qualifying bounty, valid hunter package, started and completed passing result in campaign; custom rubrics and creator approval count; payment not required |
| Q9 | Q8 plus actual timely payment to claimant winner |
| Q10 | New current-deployment hunter; passing cash-eligible bounties from two different creators with distinct scopes, >=72h between submission times, at least one actual payment, second creator non-team |
| Q14 | Approved template work order funded by claimant; refund does not erase posting XP; this does not prove Hermes installation/use |
| Q15 | Q5 pair using two different approved work-order templates; custom cash exceptions cannot satisfy template quests |

Eligible paid hunter: not the creator and not held; when creator and hunter are both Zealy-bound, they must map to different user hashes. Team hunters are excluded except for the explicit house-hunter allowance for an external creator's Q4/Q5/Q6/Q15 payment prerequisites. A prepared/upload-only submission never passes. `CreatorApproved` marks the prepared submission as started/passed/finalized at approval, like the on-chain PassedPaid status. Smart-contract wallets use the exact escrow creator/hunter address: never substitute transaction sender, relayer, funder or owner EOA.

`PayoutSent` followed immediately by matching `PaymentDeferred` is an unpaid credit. Same-contract recipient `Withdrawn` pays all earlier credits because the current escrow withdraws the full balance. Withdrawal time is payment time. Residual `CreatorRefunded` after an award is not cancellation; `BountyClosed` marks refunded. Q3/Q14 ignore that refund, while other milestones retain their completion/payment requirements.

### Two archive kinds and approved versions

A `custom` evaluation needs a readable bounded ZIP, valid manifest/primary query and a `gradingRubric` CID whose JSON contains at least one criterion. Its scope digest is SHA-256 of the exact primary query text. Its hunter archive must pass the existing shape validator and have a nonempty primary work-product query. On-chain start/approval and passing-result checks remain mandatory; merely uploading an archive never qualifies.

After a description parses as a work order, the existing evaluation-query builder first reconstructs its canonical query against the fetched rubric. Changed instructions fail terminally with `EVALUATION_QUERY_CHANGED`, even when the template is unapproved. A `workOrder` then requires the shared request/result schemas, intact request hash, unambiguous prefixes and an approved rubric/threshold snapshot. Its scope digest is the request digest. Hunter delivery requires referenced `result.json` and nonempty `evidence.md`; real-world task attachments declared in results must also be delivered. Missing/unavailable/invalid evidence never passes. `NOT_A_WORK_ORDER` classifies a valid ordinary custom archive. An intact query with an unapproved rubric/threshold becomes `custom` with `RUBRIC_MISMATCH`; failed request/hash checks become `WORK_ORDER_HASH_OR_REQUEST_INVALID`; ambiguous prefixes become `AMBIGUOUS_WORK_ORDER`. These fallbacks can earn XP and require a reviewed cash exception for cash quests; none satisfies Q14/Q15. Malformed packages, missing rubric references and empty criteria remain terminal package failures.

Hand-built archives have a deliberate validation asymmetry: any query parsed as a work order must exactly rebuild with the server query builder, including queries that would otherwise fall back to custom. An ordinary custom archive receives the structural checks above, without canonical-query reconstruction. Custom eligibility therefore does not certify that its evaluation instructions match the server builder. Normal server creation flows use that builder; authors constructing work-order archives themselves must preserve its exact query format.

`approvedTemplates` contains `{id, version, sha256, rubric, threshold}` snapshots. Several versions per template ID are supported. Rubric comparison canonicalizes existing field aliases (`description`/`instructions`, forbidden-content casing) and compares title, criteria and forbidden content. `sha256` commits to id/version/canonical rubric/threshold. `npm run campaign:inspect -- --templates` prints installed snapshots for operator review/copy. The verifier compares on-chain evidence against configured snapshots; an installed rubric change does not invalidate an approved older rubric. Request/result schema compatibility still uses the shared validator. An operator may add an older snapshot after launch and restart to enable its template/cash eligibility. Existing identity bindings and successful claims remain intact; removing a snapshot mid-campaign is unsupported.

Only bare chain-derived CIDs reach the existing gateway fetcher; URLs in claims or task text are never fetched. Downloads are capped at 4 MiB, ZIPs at 100 entries / 8 MiB expanded, individual inspected entries at 1 MiB. Gateways remain trusted to return CID contents, consistent with the existing application.

Terminal malformed packages, tampered queries and invalid results are negatively cached and not refetched under the same validation context. Rubric mismatches now produce successful custom classification, rather than negative entries. Successful parsed custom/work-order evidence also persists. Gateway/timeouts are cached by CID with retries after 5, 10, 20, 40, then 60 minutes (one-hour maximum backoff); interim cycles make no request. Both cache contexts include `snapshotSetHash` and an `evidenceFingerprint` computed once at startup from the archive-generator source, the installed discover package version and each template version. Bounty contexts also include threshold; submission contexts include kind, template and scope. A new deployment fingerprint or snapshot set revalidates earlier terminal results. Only explicit package checks produce terminal errors. Import failures, programming errors and unexpected shared-module results return non-terminal `EVIDENCE_CHECK_FAILED_RETRY`, are retried next cycle and log one sanitized warning per cycle. Inspection exports fingerprints, snapshot sets and cached reasons; no secret URLs are retained.

### Redeployment and evidence warm-up

The evidence fingerprint hashes the entire `utils/archiveGenerator.js` file, including helpers, rather than only the query-builder function. Any change to that file, even an unrelated edit, changes the fingerprint and revalidates all cached evidence outcomes, including successes. This intentionally covers changes to code the builder can depend on, at the cost of additional RPC/IPFS work after deployment.

Plan for a verification pause after restart: startup holds claims until the first successful reconciliation. If the initial revalidation cycle takes longer than `maxAgeSeconds`, its published snapshot can already be stale because `checkedAt` records the cycle start; claims continue to receive a retry message until a later cycle publishes a fresh snapshot. That later cycle can reuse newly validated evidence. Retain durable state, allow the cache to warm, and confirm health 200 and a fresh `checkedAt` before announcing restored verification. The health-503 alert should remain enabled during rollout so an unexpectedly long pause is visible.

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

Reconciliation is outside HTTP claims. It scans current-escrow logs in chunks through `min(RPC finalized, latest - confirmations)`, checking Base chain ID, runtime hash, block/log hashes, `bountyCount` and per-bounty `submissionCount`. The creation boundary (`getCode(fromBlock-1)`) runs once, recorded only after successful reconciliation. Budget one `submissionCount` RPC call per bounty per cycle, including pre-campaign bounties: at the observed 141-bounty count, that is 141 calls per cycle before the other ledger/evidence reads. Additional calls grow with in-window bounties and submissions. Original numeric IDs remain namespaced by chain and contract.

A lower finalized checkpoint skips that cycle, preserves `chain.error`, `checkedAt` and all logs/evidence, and records `chain.lagNotice = {at, toBlock, coverageTo}`. Health reports `lagging: true` while the notice is newer than the last successful cycle. Fresh snapshots still verify; sustained lag eventually fails the normal `maxAgeSeconds` check. A successful cycle clears the notice. Only a hash mismatch at the prior checkpoint clears the projection and starts a rebuild next cycle. Missing checkpoints, RPC failures and stale snapshots cannot approve. RPC outages during chain reads hold the generation. CID failures hold affected evidence while valid independent bounties can still qualify. Previously successful requests always re-evaluate current eligibility.

Base finalized lag is typically 15–30 minutes (the owner observed about 19 minutes). Claims therefore verify roughly 30 minutes after settlement, subject to RPC and IPFS availability; publish this delay in the campaign rules so users know when to retry.

The RPC's finalized assertion is trusted; this is not independent consensus verification. A deep finalized reorg or later denial cannot revoke an already-accepted Zealy task automatically. Reconcile such cases using the audit and Zealy review tools. Sample settings (20 confirmations, one-hour maximum age, one-minute polling, 2,000-block chunks) require operator validation against the selected RPC and expected load.

`GET /api/campaign/health` returns readiness/category/current-history completeness and the lagging flag (200/503); disabled startup also returns its sanitized reason category. Claims use cached state and no RPC/IPFS call. Check response latency below ten seconds at expected data volume. Protect ingress with TLS and appropriate rate limiting; never log secret headers or claim bodies.

## Zealy tasks and responses

[API task documentation](https://zealy.io/docs/tasks/api) and [task schema](https://api-v2.zealy.io/swagger.json) define the endpoint contract. Set once-only API tasks for Q3/Q4/Q5/Q6/Q8/Q9/Q10/Q14/Q15, with actual IDs in configuration:

```json
{"endpoint":"https://YOUR_BOUNTY_API/api/campaign/verify","identifications":["wallet"],"network":"base-mainnet","apiKey":"PRIVATE_ENVIRONMENT_SECRET"}
```

Dependencies: Q3←Q1, Q4←Q3, Q5←Q3, Q6←Q5, Q8←Q1, Q9←Q8, Q10←Q9, Q14←Q3, Q15←Q5. Q12 stays XP-only native Invites with `mandatoryQuests:[ACTUAL_Q4_ID]`, `minInviteUserCount:1`. Keep Q4 claimable for XP after its cash slots fill, preserving referral qualification.

```json
{"userId":"zealy-user-id","communityId":"configured-community-id","subdomain":"configured-subdomain","questId":"configured-quest-uuid","requestId":"zealy-request-id","accounts":{"wallet":"0x1111111111111111111111111111111111111111"}}
```

Send the secret only in `X-Api-Key`. Normal claim bodies have an 8 KiB limit. Responses contain a plain sentence followed by `[CODE]`: HTTP 200 only for `Verified: you completed this campaign milestone. [VERIFIED]`; otherwise HTTP 400, for example `Not verified yet: your bounty has not paid an eligible hunter inside the campaign window. Retry after settlement. [PAYMENT_NOT_RECEIVED_IN_WINDOW]`. Authentication, JSON, operational and exception errors are sanitized, never raw exception messages. Retry pending/service failures after five minutes; gateway backoff may take longer.

There is no internal entitlement/reservation layer or wallet-progress endpoint. Verification writes only identity/audit state. Zealy owns once-only completion and FCFS cash inventory. A lost HTTP response is safe to retry; HTTP 200 is not evidence that Zealy accepted or paid a reward. Planned managed-USDC inventories are 20×$6 Q4, 12×$10 Q6, 16×$5 Q10 and 8×$5 Q9, plus four separately authorized $10-equivalent ETH starter bounties. Q9 retains its existing predicate for any eligible non-team hunter; Q12 is XP-only. These are operator-side Zealy settings, and nothing here creates or funds them.

## Export, retention and pilot

`npm run campaign:inspect -- /absolute/state/ledger.json` is a host-only read. It prints current coverage, exception/error evidence, user hashes and bindings for releases, successful cash-quest claims with evidence keys for the owner's 10% sample audit, all verified milestones, unsuccessful diagnostics and deduplicated transactions. It excludes raw Zealy IDs, social/email fields, submitted request bodies and secrets. Wallet/user hashes are pseudonymous, not anonymous.

Verified Q4/Q5/Q6/Q15 records now include `creatorCompletionKind` (`house-assisted` or `organic`) and `houseAssistedEvidence` containing the supporting bounty keys, house hunter, amount, receipt time and payment transaction. Only payments needed by that milestone are classified: Q5/Q15 use the first bounty's payment; Q6 uses both. These records persist with the successful claim rather than being inferred from a later ledger. Inspection also returns `verifiedHouseAssistedCreatorClaims` and the configured house allowlist, while retaining all existing cash claims, milestones and evidence keys. Historical records without this annotation are unclassified, not automatically organic. Here `organic` means no configured house hunter supplied the required payment evidence; it is not proof of independent humans.

`verifiedCashCandidateClaims` includes verified Q4/Q6/Q9/Q10 claims, each labeled `rewardStatus: "candidate-only"`. Q9 candidates can include valid custom-rubric results and returning hunters: this inventory grouping does not impose the Q4/Q6/Q10 newness/template gates. The existing `verifiedCashClaims` export retains that stricter Q4/Q6/Q10 policy grouping. Only Zealy's accepted reward export establishes allocation of a managed-USDC slot; verification alone never proves a reward was won or paid.

Retention decision: successful results are compacted by `(userHash, wallet, quest)` in `verifiedClaims`, separate from the evictable diagnostic tables. The latest successful evidence/request/snapshotSetHash and firstVerifiedAt remain durable, even after a later failed retry. `attempts` (10,000) and `audit` (20,000) hold only unsuccessful diagnostics and evict oldest entries; a sanitized warning logs at 80%. Attempt volume never gates eligibility. Successful milestone storage grows with participants, not retry volume. Request-ID reuse checks apply to retained records; evicted unsuccessful request IDs are not a durable replay blacklist. There is no payment side effect to replay. Back up successful claims before any policy migration or retention cleanup.

For aggregate reporting, deduplicate bounties by full key and transactions by hash; sum original funding once and actual timely payments once (never count payout plus withdrawal twice). Separate team activity, house-assisted versus organic creator completions, custom/work-order mix, cash exceptions, current-deployment newness and supplied prior-wallet exclusions. Join Zealy's accepted task/reward export to verified claims for actual rewards and referrals. New-wallet counts do not prove unique humans. Suggested retention extends through grace and the owner's 30-day returning-usage analysis, then keeps only agreed dispute/accounting records and aggregate metrics.

Before launch:

1. Complete policy, exact wei/UTC cutoffs/IDs/exclusions, current escrow creation/code checks and approved snapshots. Confirm successful full current-deployment backfill.
2. Pilot custom XP, automatic work-order cash, a denied/held claim and a reviewed custom cash exception. Verify actual Zealy smart-wallet authentication matches the chain wallet.
3. Test invalid configuration/live-lock startup isolation, RPC staleness/recovery, cached IPFS failures, exceptions reload and latency with realistic claim counts.
4. With separate authorization and funds, verify actual direct payment and deferred withdrawal. Deterministic tests are not a production payment rehearsal.
5. Configure unpublished tasks, native Q12 and managed USDC inventories; check Q4 XP after cash exhaustion and reconcile accepted Zealy outcomes. Begin the owner's 10% cash-claim sample audit.

Remaining developer/operator work is production configuration, current-escrow RPC/finality/load checks, Zealy wallet and inventory integration checks, and the separately authorized pilot. No retired-deployment audit or per-bounty manual gate is required.

Tests: `npm run test:campaign`, `npm test -- --runInBand --coverage=false`, `npm run lint`. Campaign tests use only deterministic data and vendored public archive bytes; no network, transactions or paid service calls. ESLint now checks server syntax and applies recommended, descriptive-identifier and one-statement-per-line rules to campaign code and its inspection command, without rewriting unrelated server code.
