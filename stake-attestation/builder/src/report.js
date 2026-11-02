// The validation report the maker sees before funding (design §8.2: "The maker sees this
// validation report before funding"): validation-report.json, written beside code_review.json.
//
// It says whether the listing was accepted, refused (and why, step by step, with the build's log
// when the setup failed) or could not be validated (an error to retry), and what was measured:
// the project's proof (`control`), the image, its sizes, the verified-source comparison, the code-runner's listing check (timings,
// limits, suite, harness proof) and the baseline. `devOnly` lists what makes the result fit only
// for dev trust (another platform, no gVisor). It never holds a secret: the config it reads has
// none, and the runner's token and explorer keys are never passed to it.
import { BUILDER_VERSION } from './version.js';

export const REPORT_FILE = 'validation-report.json';

export function newReport({ draft }) {
  const ok = draft && typeof draft === 'object' && !Array.isArray(draft);
  return {
    version: 1,
    kind: 'verdikta-listing-validation',
    builder: { version: BUILDER_VERSION },
    createdAt: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
    status: 'pending',
    listing: {
      repo: ok ? draft.repo ?? null : null,
      baseCommit: ok ? draft.baseCommit ?? null : null,
      artifact: ok && draft.artifact && typeof draft.artifact === 'object' ? draft.artifact : { kind: 'repo' },
    },
    steps: [],
    control: null,
    image: null,
    verifiedSource: null,
    listingCheck: null,
    baseline: null,
    limits: null,
    files: null,
    attestation: null,
    devOnly: [],
    refusals: [],
    warnings: [],
    error: null,
  };
}

/** Starts a step; the returned handle records how it ended. */
export function startStep(report, name) {
  const t0 = Date.now();
  const entry = { name, status: 'running', durationMs: 0 };
  report.steps.push(entry);
  const end = (status, detail) => {
    entry.status = status;
    entry.durationMs = Date.now() - t0;
    if (detail !== undefined) entry.detail = detail;
  };
  return {
    entry,
    ok: (detail) => end('ok', detail),
    fail: (detail) => end('failed', detail),
    skip: (detail) => end('skipped', detail),
  };
}
