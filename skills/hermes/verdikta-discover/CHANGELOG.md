# Changelog

## Unreleased

`real-world-task-v1` 1.1.0, after mainnet bounty 398 rejected three evidence-pack submissions for reasons the wording allowed. A draft made with the 1.0.0 rubric does not re-derive: regenerate it from the assessment input. Bounties already created keep the rubric they pinned.

- Rubric `real-world-task-v1` 1.1.0. The authenticity gate and the forbidden-content line fail fabricated or content-altered evidence (stock, reused, generated, composited or retouched), and say that disclosed format conversion, resizing or recompression, removal of location or other private metadata, privacy redaction, and reports or attestations written with tools or AI assistance do not fail it when they truthfully describe what was done. The evidence gate says a link is an archival deliverable the jury neither opens nor grades for opening. The token gate compares the photograph with the expected token and passes a handwritten character consistent with it. A bounty the task has the performer examine is not the bounty submitted to. Gates, weights and the recommended threshold are unchanged.
- The delivery note asks for exact file names, image attachments and disclosure of conversions.
- New challenge tokens use `ACDEFHJKMNPQRTUVWXY3479` and hyphens only (no 0/O, 1/I/L, 5/S, 2/Z, 6/G, 8/B). `scripts/challenge-token.mjs` prints one; a draft whose token has a look-alike character is `NEEDS_SCOPE` (`validateDraftRequest`). Existing bounties keep their tokens: the hunter-side check does not apply the rule.
- `scripts/check-result.bundle.mjs --files <names...>`: for a real-world task, every evidence filename in `result.json` must be one of the attached files, and one of them must be `result.json` (`evidenceFileErrors`).
- `references/fulfilment.md`: matching file names, images rather than PDFs and a size expectation, links as archival, what handling to disclose, writing the token, and naming the examined bounty apart from the submitted-to bounty. `references/drafting.md` and `references/service-templates.md` carry the token alphabet and the same points for the drafter.
- The example request's token is now `FAKE-7QKM-4W9P`.

## 1.1.0 (2026-10-06)

Two new service templates and a wider source rule. A draft made with 1.0.x does not re-derive under 1.1.0 (the rubrics changed): regenerate it from the assessment input.

- `review-v1`: a bounded review of a public artifact (a code change, rubric, specification, document, proposal or dataset) by public URL and/or inline text of up to 2,500 characters, with up to 15 review questions. Each answer is `ISSUE_FOUND`, `NO_ISSUE`, `ASSESSED` (0-100) or `UNRESOLVED`, with verbatim quotations and locators and, where wanted, a proposed change. A reasoned `NO_ISSUE` earns full credit; the number of findings is not rewarded. Threshold 80.
- `real-world-task-v1`: a task performed by a person at a place inside a time window, with up to 10 steps and an evidence specification (photographs, documents, receipts, screenshots, an attestation). The request carries a challenge token that must appear physically in the photographs. The result reports every step and every evidence file. Threshold 80.
- `source-check-v1` and `evidence-pack-v1` are now 1.1.0: in `INDEPENDENT_PUBLIC_RETRIEVAL` mode a result may cite public `https` sources beyond the approved list, each as an independent retrieval quoted verbatim with its locator, publisher and retrieval time; `PROVIDED_CORPUS` is unchanged. Their rubrics say so.
- The composed evaluation description ends with the template's delivery note. The market summary, the Create Bounty import and the Agents-page preview know the new ids. `local_summary` stays specific to source checks and evidence packs.
- SKILL.md triage: judgment and physical-world work are no longer unsuitable in themselves; items 6 and 7 route them to the new templates. Private, confidential or regulated inputs stay unsuitable.
- SKILL.md after round 11 (2026-10-07, before publication): item 7 covers tasks a person performs remotely as well as at a place (`location.remote_ok`) and sends an owner who wants evidence treated as conclusive to `NEEDS_SCOPE` rather than `UNSUITABLE`; item 1 distinguishes that from a guaranteed outcome; the decision line carries the template id on `NEEDS_SCOPE` (for example `Decision: NEEDS_SCOPE (review-v1)`) and the answer lists the missing inputs.
- SKILL.md and `references/drafting.md` after Hermes round 3c: never install packages into or write files into the skill directory (it may be read-only); the check runs with the self-contained bundle.
- For hunters: `references/fulfilment.md` explains how to deliver a work-order bounty; `scripts/check-result.bundle.mjs` (Node only) validates a `result.json` against the request a bounty description commits to; the composed description now carries a line pointing at both, and `work-order.mjs` exports `parseWorkOrderDescription`. The onboarding skill runs the check before uploading.

## 1.0.1 (2026-10-06)

Documentation only: `SKILL.md`, the scripts, templates and schemas are unchanged.

- `references/install.md` opens with a note for Hermes Agent users. This release is written for OpenClaw. On Hermes, install the Hermes copy with `hermes skills install verdikta/verdikta-applications/skills/hermes/verdikta-discover`; it names Hermes' fetch tool and is verified there.
- `references/install.md` gains a "Hermes Agent" section: host settings, the always-on pointer for Hermes, and the evaluation results (`tests/CONNECTED_DESIGN.md` in the repository, Hermes rounds 1 and 2).
- This changelog.

## 1.0.0 (2026-10-06)

First ClawHub release.
