// The maker's draft code_review.json and the one the builder writes.
//
// The maker writes everything but what the build measures: env.image (the pushed digest),
// env.platform, env.unpackedBytes and, unless they set them, the limits (the code-runner's
// defaults). The draft is checked with @verdikta/common's validator before anything is fetched
// or built, with stand-ins for the fields the builder fills, and against what this builder (the
// Foundry MVP, design §20 decision 17) can host.
import { codeReview } from './common.js';
import { Refusal } from './errors.js';

const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const PLACEHOLDER_IMAGE = `registry.invalid/verdikta-builder-draft@sha256:${'0'.repeat(64)}`;
const FILE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const RESERVED = new Set(['code_review.json', 'validation-report.json', 'dev-trust.json', 'scan-findings.json']);

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** The draft with the builder's stand-ins, as the validator sees it. */
function withStandIns(draft) {
  const env = isObject(draft.env) ? draft.env : {};
  return {
    ...draft,
    env: { from: env.from, image: PLACEHOLDER_IMAGE, platform: CLASS_PLATFORM, unpackedBytes: 1 },
    attestation: draft.attestation ?? codeReview.ATTESTATION_FILE,
    baseline: draft.baseline ?? codeReview.BASELINE_FILE,
  };
}

/**
 * @param {unknown} draft
 * @returns {{ ok: boolean, issues: object[], warnings: object[] }}
 */
export function checkDraft(draft) {
  const issues = [];
  const warnings = [];
  if (!isObject(draft)) return { ok: false, issues: [{ code: 'SCHEMA', path: '/', detail: 'code_review.json must be a JSON object' }], warnings };
  const env = isObject(draft.env) ? draft.env : {};
  for (const k of Object.keys(env)) {
    if (k === 'from') continue;
    if (k === 'platform' && env.platform === CLASS_PLATFORM) continue;
    if (k === 'image' || k === 'unpackedBytes' || k === 'platform') {
      warnings.push({ code: 'DRAFT_ENV_REPLACED', path: `/env/${k}`, detail: `env.${k} is measured by the builder; the draft's value is replaced` });
    } else {
      issues.push({ code: 'SCHEMA', path: `/env/${k}`, detail: 'is not an env field' });
    }
  }
  const v = codeReview.validateCodeReviewSpec(withStandIns(draft));
  issues.push(...v.issues);
  warnings.push(...v.warnings);

  const c = isObject(draft.commands) ? draft.commands : {};
  if (c.framework !== undefined && c.framework !== 'forge') {
    issues.push({ code: 'FRAMEWORK_UNSUPPORTED', path: '/commands/framework', detail: 'this release hosts Foundry listings only (commands.framework "forge")' });
  }
  for (const [name, placeholder] of [['build', null], ['testFiles', '$FILES'], ['testIds', '$TEST_IDS']]) {
    if (typeof c[name] !== 'string' || !c[name]) issues.push({ code: 'COMMAND_MISSING', path: `/commands/${name}`, detail: `a listing must declare commands.${name}: claims run it` });
    else if (placeholder && !c[name].includes(placeholder)) issues.push({ code: 'COMMAND_PLACEHOLDER', path: `/commands/${name}`, detail: `commands.${name} must use ${placeholder}` });
  }
  if (typeof draft.repo === 'string') {
    try {
      const u = new URL(draft.repo);
      if (u.username || u.password) issues.push({ code: 'REPO_URL_CREDENTIALS', path: '/repo', detail: 'the repository URL must not carry credentials: it is public in the listing' });
    } catch {
      /* the schema has already said so */
    }
  }
  // The names the listing archive will use, the defaults included, all distinct and none the builder's own.
  const names = [
    ['attestation', draft.attestation ?? codeReview.ATTESTATION_FILE],
    ['baseline', draft.baseline ?? codeReview.BASELINE_FILE],
    ['stake/knownIssues', isObject(draft.stake) ? draft.stake.knownIssues : undefined],
  ];
  for (const [where, name] of names) {
    if (name === undefined) continue;
    if (typeof name !== 'string' || !FILE_NAME.test(name) || RESERVED.has(name)) {
      issues.push({ code: 'FILE_NAME_INVALID', path: `/${where}`, detail: 'must be a plain file name in the listing archive (letters, digits, . _ -), not one the builder writes itself' });
    }
  }
  const used = names.map(([, n]) => n).filter((n) => typeof n === 'string');
  if (new Set(used).size !== used.length) issues.push({ code: 'FILE_NAME_INVALID', path: '/', detail: 'attestation, baseline and known-issues files need distinct names' });
  return { ok: issues.length === 0, issues, warnings };
}

/**
 * known_issues.json, when the draft names one: present, JSON, valid. Its bytes are attested as
 * given, so they are never reformatted.
 * @throws {Refusal} KNOWN_ISSUES_MISSING, KNOWN_ISSUES_INVALID, KNOWN_ISSUES_NOT_NAMED
 */
export function checkKnownIssues(draft, bytes) {
  const name = draft.stake?.knownIssues ?? null;
  if (!name) {
    if (bytes) throw new Refusal('KNOWN_ISSUES_NOT_NAMED', 'a known-issues file was given but code_review.json names none (stake.knownIssues)', { step: 'spec' });
    return null;
  }
  if (!bytes) throw new Refusal('KNOWN_ISSUES_MISSING', `code_review.json names ${name}, but no known-issues file was given`, { step: 'spec' });
  let list;
  try {
    list = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Refusal('KNOWN_ISSUES_INVALID', `${name} is not JSON`, { step: 'spec' });
  }
  const v = codeReview.validateKnownIssues(list);
  if (!v.ok) throw new Refusal('KNOWN_ISSUES_INVALID', `${name} does not validate`, { step: 'spec', issues: v.issues });
  return { name, bytes: Buffer.from(bytes) };
}

/** The spec sent to the listing check: the draft's, with the image to check; no size (a draft's is not attested). */
export function runnerSpec(draft, image) {
  return { ...draft, env: { from: draft.env.from, image, platform: CLASS_PLATFORM } };
}

/**
 * The code_review.json the builder writes: the draft's fields in the draft's order, env as
 * measured, the file names, and the limits (the draft's where it set them, else the defaults).
 */
export function finalSpec(draft, { image, unpackedBytes, limits }) {
  const out = {};
  for (const [k, v] of Object.entries(draft)) out[k] = v;
  out.env = { image, from: draft.env.from, platform: CLASS_PLATFORM, unpackedBytes };
  out.attestation = draft.attestation ?? codeReview.ATTESTATION_FILE;
  out.baseline = draft.baseline ?? codeReview.BASELINE_FILE;
  out.limits = { ...limits, ...(isObject(draft.limits) ? draft.limits : {}) };
  return out;
}

/** JSON as the builder writes every file: two-space indent, a final newline. */
export function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
