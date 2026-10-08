# Zealy campaign verifier

Opt-in verification for issue #68. No transfers, cash reservations, frontend, Zealy mutations or production settings are performed by this service. Normal Bounties behavior is unchanged with `ZEALY_CAMPAIGN_CONFIG` unset. This implementation is ready for code review, **not a launch certification**. Local fixtures are not a production payment rehearsal.

## Installation and configuration

Use Node >=20.18 (the existing shared work-order module uses JSON import attributes). Install the locked dependencies in **both** `example-bounty-program/server` and `skills/verdikta-discover` with `npm ci`. Deployment must include the shared skill's scripts, schemas and templates, plus `example-bounty-program/onchain/abi/BountyEscrow.json`; copying only the server directory is insufficient. No new npm dependency was added.

Copy `campaign/config.example.json` and `reviews.example.json` outside the repository, restricted to the server/operator account. Set `ZEALY_CAMPAIGN_CONFIG` to the absolute JSON path and `ZEALY_API_KEY` to a random secret of at least 32 characters. Use the server's existing `RPC_URL`/network configuration for an archive-capable Base mainnet RPC. The secret is never written to policy, state, responses or task descriptions. The sample deliberately fails startup: fill approved UTC start, fixed original funding threshold in decimal wei, actual community/subdomain/quest IDs, reviewed team exclusions, verified deployment blocks/code hashes, state/review paths and inventory evidence. A reviewed empty team list must be an explicit decision, never an omitted setting. No launch date or minimum wei is supplied by this PR.

Duration is exactly 21 days from configured UTC `start`; activity intervals are `[start, start+21 days)`. Claims run until but exclude `start+24 days`. The extra 72 hours accept corrections and claims for timely activity, never late creation/submission/evaluation/payment. All stored event/claim timestamps are UTC Unix seconds; policy/review timestamps use UTC ISO strings. The sample's 20 confirmations, one-hour finalized-chain maximum age, one-minute polling and 2,000-block log chunks are proposed operator policy, not observed production guarantees.

`npm run campaign:inspect -- --templates` prints the current shared template+rubric fingerprints. Approve those exact versions before launch. Changed installed templates hold reconciliation; changing policy requires a reviewed state migration (do not delete identity mappings or audit history to bypass it). `policyHash` binds the full configuration except the secret; key rotation does not reset eligibility. Treat policy as frozen after launch.

Run one server process per campaign persistent directory on local durable disk. An exclusive `writer.lock` refuses a second process; do not run this opt-in service under clustered workers or on NFS. Atomic rename plus file/directory fsync persists each chain snapshot and the separate identity/claim file before responding. After a crash, confirm the old PID is dead before removing the stale lock. Startup rejects old policy state and withholds eligibility until reconciliation succeeds. Back up `ledger.json`, `claims.json`, policy and review file together. No automatic identity reset or unauthenticated approval endpoint exists.

## Evidence and finality

The reconciler scans allowlisted deployment logs outside requests, from creation through `min(RPC finalized block, latest block - confirmations)`. It verifies Base chain ID, runtime code hash, absence of code before the configured creation block, block/log hashes, and event counts against `bountyCount` and every `submissionCount`. Unknown/incompatible legacy signatures therefore cannot silently certify absence of history. An RPC without historical calls or a legacy contract with incompatible count methods holds indexing until an audited adapter is added. Chunk size bounds RPC log requests; first backfill can take time. Claims never run RPC/IPFS queries or full-history scans.

A changed checkpoint clears the chain projection and requires rebuilding from deployment origin on the next cycle. No previously successful result bypasses stale, error, reorg, exclusion or cutoff checks. Finality is the configured RPC's finalized assertion, not an independent consensus proof. An already-accepted Zealy task cannot be revoked automatically after a deep finalized reorg; stop affected rewards and reconcile the audit with Zealy explicitly. Operational failures return retryable non-success. Background hangs eventually make the prior snapshot stale. Monitor reconciliation time, disk capacity and chain freshness.

Bounty identity is `chainId:lowercaseContract:numericId`. Original funding is `BountyCreated.payoutWei`, never remaining `getBounty().payoutWei`. Prepared submissions alone do not pass. Passing requires `WorkSubmitted`, `SubmissionFinalized(passed=true)`, a valid original package and timely events. The exact escrow creator/hunter address binds Zealy's authenticated wallet; transaction sender, relayer, funder or EOA owner of a smart wallet is not substituted.

`PayoutSent` alone is insufficient. In the audited current escrow, an immediately following matching `PaymentDeferred` records an unpaid credit. Only the subsequent same-contract, same-recipient `Withdrawn` makes every earlier credited bounty paid, since `withdraw()` transfers the entire ledger balance. Payment time is the withdrawal time. A refund credit does not masquerade as a payout; `BountyClosed` excludes the bounty. `CreatorRefunded` after an award is a residual refund of the difference between the original funded maximum and the actual settlement payment, not cancellation. Legacy deployments are history-only; no campaign payment is approved using old payout semantics.

Evaluation packages and rubric CIDs come from confirmed chain records. Archives have download, entry and expansion bounds; only bare CIDs go through the existing fixed/configured gateway fetcher. Claim text URLs are never fetched. Shared `work-order.mjs`, `preview-core.mjs` and `validation.mjs` rederive request/template/rubric/threshold and validate result schemas. The canonical evaluation query is rebuilt using existing `archiveGenerator` and must match exactly. Hunter archives require referenced `result.json` and nonempty `evidence.md`; real-world task evidence files declared in the result must also be delivered and referenced. Presence and schema checks do not authenticate photographs. Other/older query formats remain held; they require a reviewed adapter rather than weakening comparison. Successful content-addressed evidence is cached; missing evidence retries on reconciliation. HTTP gateways remain trusted to return the CID's contents, as in the existing application; this is not a trustless IPFS block verifier.

## Historical inventory and launch gap

Repository evidence identifies **six** Base escrow candidates. The list is a lower bound, not a proof that no other production deployment exists.

| Escrow | Creation block evidence | Repository evidence |
| --- | --- | --- |
| `0x0a6290EfA369Bbd4a9886ab9f98d7fAd7b0dc746` | Unverified | Initial mainnet README/config history |
| `0x3970dC3750DdE4E73fdcd3a81b66F1472BbaAEee` | Unverified; old sync used approximate 26,800,000 | README before `fdad87a` |
| `0x1A4a0dedDAE20C24c3cD7735a2Ab1aFDAc491770` | 47,132,201 | `fdad87a` server config |
| `0x4390820F6F18EFeF51606434d5a9ed1841CEe916` | 47,135,949 | pre-`b4849f9` config/README |
| `0x2Ae271f5E86bee449a36B943414b7C1a7b39772D` | 47,136,166 | `b4849f9` config/README |
| `0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6` | 51,224,966 | `deploy/CUTOVER-2026-09-12.md`, current config and onboarding deployments manifest |

Verify all creation transactions, code hashes, ABI variants, event counts and any omitted deployments before setting `historyInventoryComplete:true`; record evidence in configuration. Complete inventory configuration must include all six known candidates. Missing/unknown history is never “new”. The conservative definition excludes any prior creator event or prepared hunter submission, including unsuccessful activity. The current and pre-September `SubmissionPrepared` signatures are supported. Earlier unknown signatures/count interfaces will fail closed. Do not relabel “new” to “new to this deployment” without a separate user decision. A current-only configuration with `historyInventoryComplete:false` can pilot non-newness milestones; Q4/Q6/Q10 remain held.

## Predicate coverage and explicit reviews

All nine API aliases are implemented. Every qualifying bounty requires production allowlist, timely confirmed creation, minimum original wei, OPEN/non-targeted procurement, a 48–96 hour deadline window, approved work-order version and qualitative scope review. Claiming team wallets are excluded. Team-created starter bounties can count for hunters; a Q10 second creator cannot be team.

| Alias | Additional conditions |
| --- | --- |
| Q3 | At least one qualifying funded campaign bounty owned by claimant |
| Q4 | Q3 plus complete new-creator history, actual timely payment to a reviewed independent non-team hunter |
| Q5 | Second reviewed distinct task/request, created strictly after first payment and >=72h after first creation |
| Q6 | Q5, new creator, both paid, two different eligible hunter wallets |
| Q8 | Valid required work package, started and completed passing evaluation, all within activity window; may be unpaid |
| Q9 | Q8 plus actual timely payment to the claimant winner |
| Q10 | New hunter, two passing qualifying bounties, different reviewed creators/scopes, submission timestamps >=72h apart, at least one actual payout, second creator non-team |
| Q14 | Q3's structured request hash and approved template/rubric compatibility; no assertion of Hermes installation/use |
| Q15 | Q5 pair uses two different supported templates |

Structural checks do not establish useful scope or independent people. This conservative first version holds every bounty until a host-authorized reviewer approves its public/non-sensitive/useful scope in `reviewFile`. Review each relevant hunter's independence and add its lowercase wallet to `independentHunters`; different addresses alone are insufficient. Add the earlier full bounty key to `distinctFrom` after checking real task distinctness for repeats, including cross-creator hunter repeats. A matching evaluation CID and request digest bind each review to immutable evidence. Record reviewer, UTC reviewedAt and concise reason. Change the file atomically; the next reconciliation applies it. Invalid/unavailable review files hold reconciliation. Never put social/email details or secrets in reviews.

Known duplicate campaign request hashes automatically hold all copies even when marked approved. Scope reviews must also check semantic duplicates, historical reuse, collusion and common ownership that hashes cannot detect. Deny/revoke by setting `approved:false`; this cannot undo a past Zealy completion automatically. Identity conflicts hold both old and new wallets persistently. There is intentionally no routine remapping bypass: a developer must stop the service, preserve the audit and perform a reviewed migration after verifying control and previous Zealy awards. Cash inventory exhaustion does not affect milestone eligibility.

## HTTP and Zealy setup

The [official API task documentation](https://zealy.io/docs/tasks/api) specifies X-Api-Key, authenticated `accounts.wallet`, ten-second responses and only 200/400; the [current swagger schema](https://api-v2.zealy.io/swagger.json) includes wallet identification, Base mainnet and native invite prerequisites. Inspected during implementation. No live Zealy invocation was performed, so authentication/error display behavior still needs the dashboard pilot.

Create once-only API tasks with actual quest IDs mapped to Q3/Q4/Q5/Q6/Q8/Q9/Q10/Q14/Q15:

```json
{
  "endpoint": "https://YOUR_BOUNTY_API/api/campaign/verify",
  "identifications": ["wallet"],
  "network": "base-mainnet",
  "apiKey": "SECRET_FROM_PRIVATE_ENVIRONMENT"
}
```

Dependencies: Q3←Q1; Q4←Q3; Q5←Q3; Q6←Q5; Q8←Q1; Q9←Q8; Q10←Q9; Q14←Q3; Q15←Q5. Native quizzes/social/polls remain outside this service. Native Q12 Invites uses `mandatoryQuests:[ACTUAL_Q4_ID]`, `minInviteUserCount:1`, once per referrer. Pilot native attribution and prerequisite enforcement. Keep Q4 available for XP after its cash inventory is exhausted so referrals still qualify; do not cap quest participation at the number of rewards.

The verifier does not expose a public wallet-progress endpoint. A private operator can inspect progress without claiming anything; a future signed-in progress route must be read-only and must not reserve rewards. Authenticated verification writes identity/audit only. Zealy's native managed USDC inventories are the only authoritative FCFS caps: proposed 20×$6 Q4, 12×$10 Q6, 16×$5 Q10, 8×$5 Q12. Four separately approved $10-equivalent ETH starter bounties complete the proposed $400 allocation. None of these are authorization to fund.

Example POST (all IDs illustrative; replace with configured values):

```json
{
  "userId":"zealy-user-id",
  "communityId":"configured-community-id",
  "subdomain":"configured-subdomain",
  "questId":"configured-quest-uuid",
  "requestId":"zealy-request-id",
  "accounts":{"wallet":"0x1111111111111111111111111111111111111111"}
}
```

Send the secret in `X-Api-Key`, never the body/query. Responses contain only `{ "message": "VERIFIED" }` with HTTP 200, or a compact reason with HTTP 400, e.g. `HISTORY_INCOMPLETE_REVIEW`, `IDENTITY_REVIEW_REQUIRED`, `QUALITATIVE_REVIEW_REQUIRED`, `EVIDENCE_UNAVAILABLE_OR_INVALID`, `MINIMUM_ORIGINAL_FUNDING_NOT_MET`, `PAYMENT_NOT_RECEIVED_IN_WINDOW`, `REPEAT_TIMING_SCOPE_OR_OUTCOME_NOT_MET`, `MILESTONE_NOT_MET_OR_PENDING`, `INDEX_NOT_READY_RETRY`, `CLAIM_WINDOW_CLOSED`. Auth failures use 400 `AUTHENTICATION_FAILED`; storage/operational failures use 400 `VERIFICATION_UNAVAILABLE_RETRY`. Retry pending/service failures after five minutes. Body parser failures are normalized by the campaign route; no exception internals or credentials are returned.

The same request ID with different user/wallet/quest is rejected. Repeated identical requests return current evidence eligibility without consuming a reward. Zealy controls once-only completion and cash inventory; HTTP 200 is not proof Zealy accepted a claim or paid a reward. Reconcile accepted Zealy task/reward exports separately with the verifier audit; do not infer rewards from request counts. A response lost in transit is safe to retry.

## Readiness, audit, retention and pilot

`GET /api/campaign/health` exposes only ready/error category and historical completeness (200 or 503). It does not expose wallet records. Host-only `npm run campaign:inspect -- /absolute/state/ledger.json` prints coverage, held identities, predicate attempts, bounty/submission/payment evidence, reviews and distinct transaction hashes. Restrict its output as wallet-linked data. Requests retain hashed campaign/user and request IDs, normalized wallets, quest, result, evidence keys and generation; no raw request bodies or social/email data. Identity hashes are pseudonymous, not anonymous. Claim storage is capped at 10,000 distinct request IDs, 20,000 audit changes and 16 MiB; capacity exhaustion holds new verification for operator intervention. This is a small-campaign single-process design. Load-test with expected inventory before launch and move to transactional database storage before materially scaling.

For reports: deduplicate bounties by full key, transactions by hash, and people only as wallets (never claim unique-human counts). Sum originalWei once for funding; sum actual payment.amount once where payment.at is timely for paid ETH. Separate reviewed team wallets and starters. Use creator/hunter prehistory plus passing/repeat pairs to calculate new/repeat cohorts; report complete-coverage status. Claims and Zealy rewards are separate funnels. Do not sum PayoutSent and Withdrawn as two payouts. Export before deleting data. Suggested operator retention: retain through the correction window and 30-day returning-usage analysis, then keep only required dispute/accounting records and aggregate metrics under the owner's agreed retention policy. No automatic deletion silently removes identity uniqueness during the campaign.

Pilot checklist (separate authorization required for spending/deployment):

1. Complete and independently review policy, historical inventory/code hashes, exclusions, approved template versions and exact wei threshold. Confirm full backfill and finalized freshness; verify log/storage counts.
2. Review three representative scopes/packages and identity relationships; include a contract wallet whose address matches the chain participant and a deliberately wrong owner/relayer address. Confirm Zealy actually authenticates that contract wallet; unsupported Zealy smart-wallet ownership remains held rather than substituting an EOA.
3. Exercise positive/negative claims, stale RPC, missing archive, duplicate request and identity conflicts; observe responses under ten seconds at expected snapshot/claim size. Verify the public endpoint/proxy does not log secret headers/bodies, rate-limit abuse at ingress, and enforce TLS.
4. With separately approved pilot funds, verify a real payout and a deferred-credit withdrawal, comparing block receipts and the local projection. Neither local fixture results nor current receipt images satisfy this step.
5. Configure unpublished tasks, actual IDs/dependencies and native Q12; test managed USDC inventory and Q4 XP claimability after inventory exhaustion. Reconcile reward acceptance with audit. Owner funds/publishes only after those checks and a support route are ready.

Developer work still required before production: verify historical deployment origins/code hashes and any missing legacy adapter, perform a deployment-specific load/finality/Zealy smart-wallet test, review security and host operations, and complete the separately funded pilot. Reviewer scope/independence decisions are deliberately manual; the draft's 90% automatic / two-hour review targets are **not demonstrated** by this implementation. A reliable lower-review-risk policy can be added only after pilot evidence, not by silently treating different hashes as proof.

Validation commands: `npm run test:campaign` and `npm test -- --runInBand --coverage=false` from the server directory. All campaign tests use deterministic fixtures/mocked chain calls, without real transactions or paid services.
