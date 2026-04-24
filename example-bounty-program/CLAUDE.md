# Claude Code Instructions

## Security

- Never read secrets files (e.g., `.env.secrets`, credentials files, or anything in a `secrets/` directory)

## Scripting patterns for agents

- **Capture IDs at the source.** `POST /jobs/create` returns the new bounty in `cr.job.jobId` — read it from the response. Never re-search `/jobs` for something you just created; that endpoint has async indexing lag (jobs are synced from on-chain events, so they can be missing for seconds after creation).
- **Split long flows into phase scripts.** For flows with a known wait (oracle evaluation is ~5–10 min), write separate short-lived scripts: (1) create+submit → exits printing IDs, (2) wait out-of-band, (3) check status + finalize → exits. Do not structure as one backgrounded script with a poll loop — background sessions have finite lifetime and will race the harness's session tracking, producing synthetic errors even when the underlying work succeeded.
