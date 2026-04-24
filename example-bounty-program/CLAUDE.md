# Claude Code Instructions

## Security

- Never read secrets files (e.g., `.env.secrets`, credentials files, or anything in a `secrets/` directory)

## Scripting patterns for agents

- **Capture IDs at the source.** `POST /jobs/create` returns the new bounty in `cr.job.jobId` — read it from the response. Never re-search `/jobs` for something you just created; that endpoint has async indexing lag (jobs are synced from on-chain events, so they can be missing for seconds after creation).
- **Split long flows into phase scripts.** For flows with a known wait (oracle evaluation is ~5–10 min), write separate short-lived scripts: (1) create+submit → exits printing IDs, (2) wait out-of-band, (3) check status + finalize → exits. Do not structure as one backgrounded script with a poll loop — background sessions have finite lifetime and will race the harness's session tracking, producing synthetic errors even when the underlying work succeeded.
- **Never create an API job without deploying its on-chain bounty.** Each `POST /jobs/create` auto-increments the API's `jobId` counter, which must stay aligned with on-chain `bountyCount`. Calling `/jobs/create` without immediately following it with `createBounty` on-chain + `PATCH /jobs/:jobId/bountyId` drifts the counters. Use `/submit/dry-run` or read-only endpoints to test response shapes — never `/jobs/create`. Since v1 of this guard, the server rejects calldata endpoints (`/submit`, `/submit/bundle`, `/submit/bundle/complete`, `/submit/prepare`, `/submissions/:subId/start`, `/finalize`, `/approve-as-creator`, `/timeout`, `/close`) for un-linked jobs with `400 BOUNTY_NOT_ONCHAIN` — a "linked" job has `onChain === true` (set by PATCH) or `syncedFromBlockchain === true` (set by the sync service via BountyCreated event match).
- **Read revert reasons, not the ethers formatted error.** When a submission transaction reverts, ethers' stringified error often shows `data: ""` even when the real revert reason is on the receipt. During submission, the most common real cause is LINK balance below `linkMaxBudget` — `startPreparedSubmission` pulls LINK via `transferFrom`, so an under-funded wallet fails with "ERC20: transfer amount exceeds balance". Check wallet balance before debugging calldata.
