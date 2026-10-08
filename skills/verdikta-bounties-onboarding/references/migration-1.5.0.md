# Migrating to 1.5.0

Existing hunter automation must stop and review its configuration before upgrading:

- Set explicit `VERDIKTA_NETWORK` and the matching API URL; there is no default mainnet transaction network.
- Add an owner-approved `VERDIKTA_SPEND_POLICY` for every transaction. Limits are per process and exclude Base L1 data fees; they do not provide a daily spending ledger.
- Never use `--yes` / `--confirm-spend` without approval for that specific action.
- Current bounties use ETH evaluation prepay. The token-swap helper is retired.
- Creation requires explicit OPEN/TARGETED intent, whole-hour submission/assessment windows, and the current oracle parameters. Discovery handoff additionally requires the owner-reviewed file’s exact `workOrderDraftSha256`.
- Submission `--dry-run` requires an existing `--hunterCid`; it uploads nothing. `--bundle`, `--confirm-first`, `--skip-confirm` and legacy oracle flags are rejected. Confirmation now runs idempotently before start, including on resume.
- Use `--state` for submissions. Resume confirms API tracking if needed, then starts the same prepared submission; it never prepares another one.
- Claim is one state-dependent action per invocation. `--maxWait` is rejected; wait outside the script and invoke it again when appropriate.
- `create_bounty_min.js` is retired. `bounty_worker_min.js` remains a read-only listing check used by onboarding.

Before a funded pilot, review deployment snapshots, run the offline checks, verify authenticated class/model availability, and authorize a small targeted Base Sepolia lifecycle test. No funded pilot has been performed by this change.

The API derives the funded bounty amount from the larger split payment when a creator window is enabled. API clients should send exact `creatorAssessmentWindowSeconds` (preferred over fractional hours) with both split payments. Fractional API hours round to the nearest second; the same rounded duration is used for validation, storage and calldata. Supplying either split payment or a positive assessment window requires both payments; incomplete settings return 400. No-window payments must equal each other and bountyAmount. CLI submission and assessment windows still require whole hours. The legacy API `bountyAmount` remains a JSON number. The separate `bountyAmountWei` integer string preserves exact value for encoding/accounting, including after chain sync. Older numeric-only records acquire this field on chain sync. Decimal/scientific-notation API amounts (including `"5e-05"` and `"+1"`) are accepted without floating-point conversion to wei; use strings for exact 18-decimal inputs. Hex amounts and fractional wei remain rejected. Legacy no-mode amount/target error labels are retained; new window/payment constraints are documented in `/api/docs` and `/agents.txt`.

New creation state records local `apiCreatedAt` and the signed raw transaction before broadcast. A delayed resume checks server open time against the saved local timestamp, with at least five usable minutes remaining before the assessment window. Legacy state without that timestamp and raw `--prepared` responses retain the 15-minute freshness limit; use the saved state for delayed dry-runs. Never invent or edit recovery timestamps to bypass checks.
