# Drafting a work order

Read this only when the decision is a draft: `PREVIEW`, `HANDOFF_REQUESTED`, or a `NEEDS_SCOPE` that lists what is missing. The approval gate in `SKILL.md` applies first.

**Bound the task.** Name the exact item list, version/date scope, output schema, search limits, acceptance rubric and exclusions. An unresolved result is valid only with documented, honest effort against the agreed search plan. Never promise a desired finding.

**Hybrid drafts.** The draft request holds only the residue (unresolved, conflicting, inaccessible or judgment items) under a new `task_id`, keeping the original approved sources. Record what you resolved in `local_summary` (see `preview-format.md`). Local findings are never independent verification and never part of the commissioned request. Never turn an unresolved, conflicting or inaccessible item into a verdict. If the owner asked for an independent review, the whole request goes out and any local pass is a labelled `NON_INDEPENDENT_PASS`.

**Separate a draft from an offer.** A service template is not an available supplier. A bounty listing is a request for work, not proof that a provider can be hired. Never invent a supplier, quote, fee estimate, turnaround or live contract address. Without a verified supplier offer, set availability to `UNKNOWN` or `NONE`, leave monetary amounts null and label the result `DRAFT_NOT_QUOTED`.

**Add market context.** Read `GET /api/market-summary` on the owner-selected origin with your fetch tool (`api-read-only.md`) and record it as `market_context`, always labelled `not_a_quote`; `api-read-only.md` maps each field. It never fills a price, a quote or availability. If the route fails, use `/api/jobs.txt` (labelled as a fallback) or omit the field and say so. Do not create an account to make a read work.

**Write the assessment input.** One JSON object: `examples/assessment.json` shows a plain draft and `examples/assessment-hybrid.json` a hybrid with market context. Fields:

- `request`: the bounded request in the template's schema (`schemas/source-check-v1.request.schema.json`, `schemas/evidence-pack-v1.request.schema.json`), usually the attached request with `fixture_only: false`. For a hybrid, only the open items, under a new `task_id`, keeping the approved sources.
- `sharing_authorized: true` only with explicit owner approval; `procurement_mode` (`OPEN` or `TARGETED`); `targetHunter` (TARGETED only).
- `local_summary` for a hybrid or an informational own pass (fields in `preview-format.md`), `market_context` (fields in `api-read-only.md`), `network` (`BASE` or `BASE_SEPOLIA` when the owner selected one) and `task_summary`.
- Optionally `handoff_requested`, `local_sufficient` and `unsuitable_reason`.

These are your judgments; the script checks that they are consistent, not that they are true. Never write a `draft`, `rubric` or `threshold` yourself: they come from the templates.

**Check the input with the script, if you can run commands.** From this skill's directory, pipe the input to `node scripts/preview.bundle.mjs --check -` with a quoted here-document (`<<'JSON'` ... `JSON`), so nothing is written to disk. It needs only Node 20.18+: no install, no network. It prints a short summary: `decision`, `inputs_needed`, `drafted_items`, the `local_summary` counts, whether the market context was kept, and `draft_sha256`. If the decision is not the one you meant or `inputs_needed` is not empty, fix the input or ask the owner. Do not return the summary or the full preview: neither can be imported, and a shortened preview is refused.

**Return the assessment input itself**, unchanged, in one fenced `json` block, whether or not you could run the script. In a chat channel that limits message length (Telegram: 4,096 characters), send it as compact JSON without indentation: formatting changes neither the draft nor its hash. If it is still too long, send it as consecutive messages of at most 3,500 characters, each labelled `part 1/N`, `part 2/N`, ... above its own fenced block. Split only right after a comma that is not inside a string, and tell the owner to join the parts in order before importing. Never send the input as a file attachment. If you have `draft_sha256`, mention it: the owner sees the same hash when importing the input. The owner pastes the input into the work-order import on the website's Create Bounty page, which derives the draft with the same code. Or the owner runs `node scripts/preview.bundle.mjs input.json` to print the preview file, the one the onboarding binder takes.

**Answer.** A short summary first: the decision line; fit; template; scope; needed owner inputs; acceptance criteria; supplier evidence or its absence; fee-estimate provenance or its absence; market context; privacy warning; next step. Then the fenced `json` block with the assessment input. A good answer may be that the owner should do the work locally.

Files, all local: templates `templates/source-check-v1.template.json`, `templates/source-check-v1.rubric.json`, `templates/evidence-pack-v1.template.json` and `templates/evidence-pack-v1.rubric.json`; the preview contract `references/preview-format.md`; installation and host posture `references/install.md`.

## Handoff, not purchase

Only a separate transactional component, under independently enforced owner authorization, may create and fund a bounty. The handoff keeps the approved task, rubric, deadline, target supplier and budget. Never turn a targeted work order into an open contest silently. Previewing, validating shape and passing a dry-run do not guarantee an award or correctness.
