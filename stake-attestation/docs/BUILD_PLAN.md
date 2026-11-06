# Stake attestation MVP — build plan

The graph the stake-attestation build runs on, in prose. The machine-readable form is `graph.json` in the orchestrator's task folder; this file is generated from it and committed by P1 as `stake-attestation/docs/BUILD_PLAN.md` so it is reviewed with the code. Design: verdikta-arbiter `docs/development/stake-attestation-design.md` on `main` (section numbers below are that document's). Scope: Phase 1, the Foundry-only MVP (§17, §20 decision 17), on a new site (§20 decision 18).

## How the build runs

- One node is one pull request, built by its own worker session on branch `claude/sa-<id>` into the repository's integration branch `claude/stake-attestation`. Tests come first, then the code, then Codex reviews the PR until a fresh Codex session approves (`codex_loop.py gate`). The orchestrator merges node PRs into the integration branch; the owner merges the milestone PRs (integration branch → `main`).
- At most two workers run at once (`max_parallel`).
- A node is ready when every dependency is merged and it has no owner gate. `merge_after` names nodes that must land before a node's PR may merge, though it may be built and reviewed earlier (the common nodes wait for verdikta-common PR #8).
- `@verdikta/common` changes reach the arbiter and the app as prereleases `1.9.0-attest.N` under the npm dist-tag `attest`, never `latest`.
- The applications nodes that need the code-runner (P3a, P5, P7) run it from verdikta-arbiter's integration branch at `CODE_RUNNER_URL`.

## Milestones

| Milestone | Nodes | Delivers |
|---|---|---|
| M0 | C0, C1a, C1b, C2, C4, C3, A0, P1, S1 | Foundations: common schemas and helpers, CI, the app scaffold, the dispatcher selection test |
| M1 | P2a, P2b, P2c, P2d, P2e | The `StakeAttestation` contract with every in-scope contract fixture |
| M2 | A1, A1b, A2a, A2b, A3a, A3b, A3c, A4a, A4b, A5, A6a, A6b, A6c, A7a, A7b, A7c, C5, A8 | The Foundry pipeline: code-runner, EA and AI Node code mode, calibration, installer |
| M3 | P3a, P3b, P4a, P4b1, P4b2, P5, P6a, P6b, P7 | Builder, site, hunter tool and the local end-to-end round |
| M4 | A7d, C6, A9, G2, G1 | Owner-gated: the production builder key, canaries, testnet, the real-jury calibration run |

## Nodes

Size: S ≈ up to 400 changed lines, M ≈ 900, L ≈ 1,500; `-` = an owner or orchestrator action with no PR.

| Id | Title | Repo | Depends on | Merges after | Size | Gate |
|---|---|---|---|---|---|---|
| C0 | Owner reviews and merges verdikta-common PR #8 (Phase 0 schemas) | common | — | — | - | owner |
| C1a | Attestation and baseline schemas, trust sets, pinned constants, protected-path gate | common | — | C0 | L |  |
| C1b | Verification Report and EA→AI Node request schemas, code classes and panels, claim query | common | — | C0, C1a | L |  |
| C2 | CI workflow for verdikta-common | common | — | C0 | S |  |
| C4 | Disclosure crypto: deterministic age encryption, decryption, verification, the disclosure line | common | — | C0, C1a | M |  |
| C3 | Publish @verdikta/common@1.9.0-attest.1 (dist-tag attest) | common | C1a, C1b, C4 | — | S | orchestrator |
| A0 | Run arbiter CI on PRs into the integration branch | arbiter | — | — | S |  |
| P1 | Scaffold the stake-attestation app with its own CI | applications | — | — | M |  |
| S1 | Class-isolation selection test in verdikta-dispatcher | dispatcher | — | — | S | owner |
| P2a | StakeAttestation: listing lifecycle (list, fund, renew, close, fees, views) | applications | P1 | — | L |  |
| P2b | StakeAttestation: claim lifecycle (commit, flag, release, roll forward, reveal, expire) | applications | P2a | — | L |  |
| P2c | StakeAttestation: finalize by polling, six-outcome settlement, depletion, payouts | applications | P2b, C3 | — | L |  |
| P2d | StakeAttestation: dispute, failed rounds, re-trigger, leftover recovery | applications | P2c | — | L |  |
| P2e | StakeAttestation: late claims, recordByHash, deploy scripts, final sweep | applications | P2d | — | L |  |
| A1 | code-runner service in local mode: API, isolation, deadline, result taxonomy | arbiter | A0 | — | L |  |
| A1b | code-runner: image pull, registry allowlist, LRU cache, slots and memory admission | arbiter | A1 | — | M |  |
| A2a | forge adapter: patch gates, build, PoC x3 and the reproduces gate | arbiter | A1 | — | L |  |
| A2b | code-runner listing-check mode: build, suite x3, baseline, harness proof | arbiter | A2a | — | M |  |
| A3a | Integrity checks, evidence tiers, claimedObservable and the fix check | arbiter | A2a | A2b | L |  |
| A3b | Verification Report, report hash and the final context pack; runner on common | arbiter | A3a, C3 | A2b | L |  |
| A3c | Honesty flags: Semgrep step and fix-mode lint | arbiter | A3b | — | M |  |
| A4a | EA code-review front gates; arbiter packages pinned to the prerelease | arbiter | A0, C3 | — | L |  |
| A4b | EA code-review run: deadline, shared runs, gate verdicts, AI Node handoff, retry | arbiter | A4a, A3b, A1b | — | L |  |
| A5 | AI Node code mode: claim pre-prompt, four questions, all jurors required, deadline and cancellation | arbiter | A0, C3 | A4a | L |  |
| A6a | 840 s job timeouts and the local claim pipeline (e2e L2, local IPFS, real AI Node with mock provider) | arbiter | A4b, A5 | — | L |  |
| A6b | testing-tool claim scenario type and e2e L4 claim scenarios | arbiter | A6a | — | M |  |
| A6c | Canary claim scenarios: cross-host hash agreement, fault injection, latency and dispute | arbiter | A6b, A1b | — | M |  |
| A7a | Calibration harness, adversarial corpus and the conformance canary | arbiter | A3c | — | L |  |
| A7b | Calibration batch 1: clear valid (Code4rena / Sherlock Foundry PoCs) | arbiter | A7a | — | L |  |
| A7c | Calibration batch 2: clear invalid, duplicates and known issues, severity boundaries | arbiter | A7a | A7b | L |  |
| A7d | Calibration measurement with the real jury (Phase 1 accuracy bar) | arbiter | A7b, A7c, A6b | — | M | owner |
| C5 | Pin the conformance canary's report hash and runner versions in common | common | A7a | — | S |  |
| A8 | Installer code-review sandbox phase, doctor, registration gate, conformance self-test | arbiter | A6a, C5 | — | L |  |
| C6 | Production trusted-builder key in common | common | C5 | — | S | owner |
| A9 | Arbiter consumes the production trust set | arbiter | A8, C6, A6c | — | S |  |
| P3a | Environment-image builder, verified-source check, validation and attestation signing | applications | P1, C3, A2b, A1b | — | L |  |
| P3b | Baseline scan and the reusable builder Action | applications | P3a | — | M |  |
| P4a | Server: listing flow, listing and dispute archives, pinning | applications | P3a, P2a | — | L |  |
| P4b1 | Server: indexer, keeper, feed API, record mirror, badge | applications | P4a, P2e | — | L |  |
| P4b2 | Server: baseline scan in the listing flow, maker-only results | applications | P4a, P3b | P4b1 | M |  |
| P5 | Hunter tool: check, commit, reveal, status, claim | applications | P2c, A3b, A1b, C3 | — | L |  |
| P6a | Client: maker listing flow, browser disclosure keys, decrypt-and-check | applications | P4a, P2b | — | L |  |
| P6b | Client: record page, badge, feed and claim actions | applications | P6a, P4b1 | — | L |  |
| P7 | Scripted local end-to-end round | applications | P4b1, P4b2, P5, P6b, A6a | — | L |  |
| G2 | Class-5555 canaries: branch on canary hosts, timeout 900 s, L4 claim scenarios | arbiter | A6c, A9 | — | - | owner |
| G1 | Testnet deploy of StakeAttestation and the site | applications | P7, C6, G2 | — | - | owner |

Acceptance conditions, verify commands and review focus per node are in `graph.json` and in each node's issue and PR.

## Critical path

- To **P7**: P1 → P2a → P2b → P2c → P2d → P2e → P4b1 → P6b → P7 (26 size units, S=1, M=2, L=3).
- To **G1**: P1 → P2a → P2b → P2c → P2d → P2e → P4b1 → P6b → P7 → G1 (26 size units, S=1, M=2, L=3).
- To **G2**: A0 → A1 → A2a → A2b → A3a → A3b → A4b → A6a → A6b → A6c → A9 → G2 (26 size units, S=1, M=2, L=3).
- All work: 105 units over 42 worker nodes. With two workers the build is bound by throughput (about 52 units of wall time) rather than by the critical path; the runner lane (A0 → A1 → A2a) and the contract lane (P1 → P2a → …) start first.
- Owner gates on the way: C0 (common PR #8) before any common node merges, hence before C3 and everything that consumes common (A3b, A4a, A5, P2c, P3a, P5); the production builder key (C6) before A9, G2 and G1; provider keys and spend approval before A7d; canary and testnet operations in G2 and G1.

## Catalogue coverage

Every case in verdikta-common `data/code-review-fixtures.v1.json` (the §18 catalogue, 61 cases) maps to exactly one node that makes it pass at its deciding layer, or is listed as out of scope below. Where a case also has a `@verdikta/common` helper, the helper column names the node that promotes it from `test.failing`. A node's tests carry the case id in their names.

The node is where the deciding logic is built, which is not always the catalogue's layer: `poc-fails-by-import-error` and `poc-patch-edits-source` are listed as `ea` (the EA settles them) but are decided by the runner's `reproduces` and `testPathsOnly` gates (A2a); the jury cases are measured by the real-jury calibration run (A7d), since a mock jury cannot decide them.

| Case | Layer | Settles | Node | Helper |
|---|---|---|---|---|
| `junit-forged-early-exit` | runner | INVALID | A3a | C1b |
| `protected-file-modified-at-runtime` | runner | INVALID | A3a | C1b |
| `reporter-monkeypatched` | runner | INVALID | A3a | C1b |
| `dependencies-edited-during-run` | runner | INVALID | A3a | C1b |
| `test-report-missing-identity` | runner | INVALID | A3a | C1b |
| `test-report-duplicate-identity` | runner | INVALID | A3a | C1b |
| `flaky-poc-two-schedules` | runner | identical | A3b |  |
| `concurrent-listings-different-baseline-bytes` | ea | distinct | A4b |  |
| `direct-request-no-attestation` | ea | rejected | A4a | C1a |
| `direct-request-spec-over-class-maxima` | ea | rejected | A4a |  |
| `premium-request-standard-jobs-none-selected` | dispatcher | none-selected | S1 |  |
| `jev-clear-valid` | ai-node | n/a | out of scope |  |
| `jev-clear-invalid` | ai-node | n/a | out of scope |  |
| `jev-known-issue` | ai-node | n/a | out of scope |  |
| `jev-duplicate-of-prior` | ai-node | n/a | out of scope |  |
| `jev-boundary-probabilities` | ai-node | identical | out of scope |  |
| `juror-just-under-limit-then-justification` | ai-node | n/a | A5 |  |
| `provider-timeout-with-retry` | ai-node | n/a | A4b |  |
| `slow-justifier` | ai-node | n/a | A5 |  |
| `registry-failure` | ea | abstain | A4b |  |
| `cancellation-at-deadline` | ea | abstain | A4b |  |
| `payment-gate-failure` | contract | INVALID | P2c |  |
| `payment-gate-pass-jury-rejection` | contract | INVALID | P2c |  |
| `payment-round-timeout-retrigger` | contract | n/a | P2d |  |
| `payment-leftover-recovery` | contract | n/a | P2d |  |
| `preflight-credited-same-archive-hash` | contract | paid | out of scope |  |
| `preflight-not-credited-different-archive-hash` | contract | rejected | out of scope |  |
| `preflight-forfeited-without-commit` | contract | paid | out of scope |  |
| `zero-preflight-fee` | contract | n/a | out of scope |  |
| `time-dependent-poc-two-hosts` | runner | identical | A3b |  |
| `randomness-dependent-poc-two-hosts` | runner | identical | A3b |  |
| `settlement-median-class-split` | contract | paid | P2c |  |
| `settlement-below-threshold-split` | contract | INVALID | P2c |  |
| `inscope-gate-path-outside-scope` | ea | INVALID | A4a |  |
| `claimed-observable-mismatch` | runner | INVALID | A3a |  |
| `poc-also-fails-at-makers-fixed-hash` | contract | VALID | P2c |  |
| `fix-patch-does-not-verify` | ea | VALID | A4b |  |
| `poc-fails-by-import-error` | ea | INVALID | A2a |  |
| `poc-patch-edits-source` | ea | INVALID | A2a |  |
| `duplicate-root-cause-rephrased` | jury | DUPLICATE | A7d |  |
| `known-issue-listed-at-listing` | jury | DUPLICATE | A7d |  |
| `bug-learned-after-open` | contract | VALID | P2c |  |
| `bond-returned-on-valid` | contract | VALID | P2c |  |
| `bond-returned-on-duplicate` | contract | DUPLICATE | P2c |  |
| `bond-forfeited-on-invalid` | contract | INVALID | P2c |  |
| `valid-below-counted-class` | contract | VALID | P2c |  |
| `dispute-flips` | contract | n/a | P2d |  |
| `dispute-holds` | contract | VALID | P2d |  |
| `reveal-before-fix-window-ends` | contract | rejected | P2b |  |
| `release-then-immediate-reveal` | contract | n/a | P2b |  |
| `roll-forward-makes-pending-revealable` | contract | n/a | P2b |  |
| `later-finding-against-closed-hash` | contract | VALID | P2e |  |
| `two-hunters-same-root-cause-minutes-apart` | contract | paid | P2c |  |
| `commit-never-revealed-expires` | contract | n/a | P2b |  |
| `payout-depletes-escrow` | contract | paid | P2c |  |
| `reveal-plaintext-hash-mismatch` | ea | INVALID | A4a | C4 |
| `reveal-reencryption-mismatch` | ea | INVALID | A4a | C4 |
| `bad-disclosure-flag-then-verified-reveal` | contract | n/a | P2e |  |
| `maker-disclosure-key-unusable` | contract | VALID | P2c |  |
| `poc-env-manipulation` | jury | INVALID | A7d |  |
| `poc-asserts-intended-behaviour` | jury | INVALID | A7d |  |

Out of scope for this build:

- `jev-clear-valid` — Phase 2: Jev (`systemone`) joins the jury in Phase 2 (§17).
- `jev-clear-invalid` — Phase 2: Jev.
- `jev-known-issue` — Phase 2: Jev.
- `jev-duplicate-of-prior` — Phase 2: Jev.
- `jev-boundary-probabilities` — Phase 2: Jev.
- `preflight-credited-same-archive-hash` — decision D2: the paid pre-flight is out of the MVP unless the owner brings it in.
- `preflight-not-credited-different-archive-hash` — decision D2.
- `preflight-forfeited-without-commit` — decision D2.
- `zero-preflight-fee` — decision D2 (moot without a pre-flight; belongs to the node that builds one).

## Design rows covered

| Design row (§7.2 / §17 Phase 1 / §16) | Node(s) |
|---|---|
| common: `attestation.json`, baseline, trusted-builder key set, pinned `foundry` image, gVisor and Semgrep versions, OCI platform | C1a; production key C6 |
| common: Verification Report schema, code ClassIDs with envelopes, hard limits and panels, severity rubric text | C1b |
| common: conformance canary's expected report hash | C5 |
| common: outcome set and settlement rule; `code_review.json`, `finding.json`, `known_issues.json` | already in verdikta-common PR #8 (C0) |
| verifiable disclosure (§14), shared by the hunter tool, the EA and the browser | C4 |
| code-runner API, isolation, deadline, abstain rules | A1 |
| code-runner image pull, registry allowlist, cache, admission (§9.2 steps 1–2) | A1b |
| `foundry` image and `forge` adapter; §9.3 determinism; `applies`, `testPathsOnly`, `build`, `reproduces` | A2a |
| listing check on the arbiters' runner (§8.2 steps 2–3) | A2b |
| §9.5 integrity checks and tiers; `claimedObservable`; fix check | A3a |
| Verification Report, report hash, context pack | A3b |
| honesty flags (Semgrep) and fix-mode lint | A3c |
| EA: attestation, envelope, disclosure gate, `inScope`, addendum stripping, trust mode | A4a |
| EA: single deadline, shared runs, gate verdicts, AI Node handoff, retry, execution-evidence block | A4b |
| AI Node code mode (§10.3, §10.5, §11) | A5 |
| Chainlink job spec 840 s; local pipeline test | A6a |
| `testing-tool` claim type; e2e L4 claim scenarios | A6b |
| §11 canary conditions; cross-host report hash; p95; dispute-flip rate | A6c, measured in G2 |
| Solidity calibration set (§18) | A7a, A7b, A7c; real-jury measurement A7d |
| installer phase, doctor checks, conformance self-test, registration gate (§16) | A8 |
| mixed-fee selection test (§10.4, Phase 0 exit) | S1 (decision D3) |
| `StakeAttestation` (§13) | P2a–P2e |
| builder, verified-source check, validation, attestation signing (§8.2) | P3a |
| baseline scan (§8.3); builder Action | P3b |
| site: listing flow, archives, pinning | P4a |
| site: indexer, keeper, feed API, record mirror, badge | P4b1 |
| site: maker-only scan results | P4b2 |
| hunter tool `check`, `commit`, `reveal`, `status`, `claim` | P5 |
| client: listing with browser disclosure key, decrypt-and-check | P6a |
| client: record page, badge, feed, claim actions, dispute | P6b |
| local end-to-end round | P7 |
| `setResponseTimeout(900)`; `code-standard` on class 5555 canaries | G2 |
| `StakeAttestation` on testnet behind the new site; seeding | G1 |

Not in this build (Phase 2 and later, §17): `node22` / `python312` images and adapters; the `systemone` client and Jev; the paid pre-flight unless decision D2 adds it; `code-premium`; remote runner mode; the `skill` harness; `@verdikta/attest-check`; the yield vault; mainnet; the site's domain and hosting. Milestone PRs are an orchestrator step, not nodes.

## Design errata this build applies

The design assumes things the deployed aggregator does not do. These corrections go into the design doc as a dated note (A4a) and are what the workers build to.

- **E1. The disclosure line carries the commitments.** §13.3's line names only the two keys, but the disclosure gate needs `sha256(archive)` and the ciphertext CID, which no request field carries. Grammar, the addendum's first line, single spaces, ASCII: `verdikta-disclosure: 0x<archiveSha256, 64 lowercase hex> <ciphertextCid as stored at commit> 0x<contentKey = age file key, 32 hex> 0x<ephemeralKey = X25519 secret, 64 hex>` (about 190 bytes). The EA fetches the ciphertext by CID and compares bytes, never a recomputed CID. The disclosure key comes from the listing archive at `cids[0]`.
- **E2. The aggregator takes at most 10 CIDs and a 1,000-byte addendum** (`MAX_CID_COUNT`, `MAX_ADDENDUM_LENGTH` in verdikta-dispatcher). `cids` = [listing (or dispute) archive, claim, up to 8 prior valid findings] (not 20). The maker's dispute statement (up to 4 KB) is pinned; its CID goes in a second machine line, `verdikta-dispute: <statementCid>`, which the EA strips like the first, fetches and fences as the maker's argument.
- **E3. Prepay is checked at reveal.** The aggregator's `maxTotalFee` can change between commit and reveal, so `reveal` (and `retrigger`, `dispute`) is payable: it tops up to the live figure, and the excess returns through `ethOwed`.
- **E4. There is no aggregator callback.** The aggregator never calls the requester; `BountyEscrow` polls. §13.2's `fulfill` is a permissionless `finalize(claimId)` that reads `getEvaluation`, uses `finalizeEvaluationTimeout` / `getAggregationStatus` for failed rounds, and treats a malformed vector as a failed round (a sum of 999,995–1,000,000 is valid: the aggregator floors each averaged component). The site's keeper calls it. Each request goes through its own `EvaluationWallet` clone so `ethOwed` leftovers reach the right payer.

## Assumptions the build makes

Implementation choices the design leaves open. Each is the default unless the owner overrides it.

- **A1. Disclosure encryption is the age v1 format.** Content key = age's file key, ephemeral key = the X25519 ephemeral secret, payload nonce derived from the content key: byte-for-byte reproducible, and makers decrypt with stock `age`. One implementation in common (C4).
- **A2. Shared logic lives in common**: the disclosure crypto and line (C4), the report and request schemas, panels and claim query (C1b), so the contract, EA, AI Node, tool and client agree byte for byte.
- **A3. The MVP panel has no Jev.** Standard: `claude-sonnet-5-5` and `deepseek-v4-pro` at equal weight; dispute: `claude-sonnet-5-5` and `gpt-6-sol`. Code mode requires every juror.
- **A4. Listing validation uses the arbiters' runner** through a listing-check endpoint (A2b), as §8.2 requires ("the same runner").
- **A5. Program values are immutable per deployment** (constructor arguments), except the listing fee and fee recipient, which the contract owner may change for future funds and renewals only. Launch values (listing fee, `badgeFloorWei`, under-staked ratio) are an owner decision before mainnet; labels are computed off-chain.
- **A6. Dev trust is explicit.** Until the production builder key exists (C6), attestations are signed with per-run dev keys that verification accepts only under an explicit dev flag, refused on mainnet and reported by the doctor.
- **A7. Shared-run caching lives in the EA**, keyed by listing CID + bCID + runner and rule versions + a hash of the prior findings; the runner request carries `finding`, `report`, `knownIssues`, `priorFindings` and the EA's gate results, extending §7.2's abridged list.
- **A8. The EA judges every code-review request under the `code-standard` envelope** and only when the operator enabled code review: the bridge does not tell the EA the request's class, and `code-premium` is not enabled. Class-aware jobs come with `code-premium`.

## Decisions for the owner

Recommended answers in brackets; "go" accepts them unless the owner says otherwise.

- **D1.** Code ClassIDs [133 `code-standard`, 134 `code-premium` reserved].
- **D2.** The paid pre-flight (§8.6, credited at commit; §13.2 has no function that records it) [out of the MVP: commit takes bond + prepay; its four catalogue cases deferred, none of which is in §18's contract-fixture list].
- **D3.** The mixed-fee selection test is a Phase 0 exit criterion in verdikta-dispatcher [add node S1, test only, via `vtask add`].
- **D4.** Custody of the production builder key (§20 decision 5) [owner's call; blocks C6, then A9, G1, G2].
- **D5.** Reveal clock vs commit order: decision 15 lets a claim expire while it is forced to wait behind an earlier claim [a claim's reveal clock starts when it is revealable and every earlier claim has resolved; `expire` reverts while an earlier claim is unresolved; INVALID and DUPLICATE settle at once, only valid outcomes wait out the dispute window].
- **D6.** Late claims (§13.2 `lateClaim`) have no disclosure path [commit-shaped: commitment, the listing's fix window, reveal with the E1 line, no award].
- **D7.** The errata E1–E4 above [accept].
- **D8.** Listing bounds and powers [`revealWindow` ≥ 72 h, `disputeWindow` ≥ 24 h, `disclosureGrace` ≤ `fixWindow`, `fixWindow` ≤ 90 d (0 allowed); one active listing per (hash, maker); `close` refused while anything is owed; owner powers limited to the listing fee and fee recipient].
- **D9.** A canary-only fault-injection switch in the AI Node and EA (env flag, off by default, refused unless the node serves 5555), needed for §11's canary conditions [yes].

