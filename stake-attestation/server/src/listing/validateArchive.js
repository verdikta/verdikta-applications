// A listing or dispute archive checked before it is pinned: first exactly as the arbiters'
// External Adapter reads cids[0] of a code-review request (external-adapter/src/codeReview/
// frontGates.js, readListing: extracted with common's ArchiveService, the manifest and the primary
// file through common's validator, the six outcomes, code_review.json, the code-standard envelope
// (build plan A8), the attestation over the files it binds, the known issues and the baseline),
// then against what this site builds: exactly these members, the manifest with common's panel for
// the archive's role, and common's claim query for the spec. Every rule is @verdikta/common's; the
// codes name the EA's requester-error codes where it has one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ArchiveService, codeReview, validator } from '../common.js';
import { MANIFEST_FILE, manifestFor, memberNames, PANELS, primaryFor } from './archives.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const noIpfs = { fetchFromIPFS: async () => { throw new Error('the archive check fetches nothing'); } };

const codes = (issues) => issues.map((i) => i.code).join(', ');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

class Rejection extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
const reject = (code, detail) => { throw new Rejection(code, detail); };

function readMember(root, name, what) {
  if (typeof name !== 'string' || !PLAIN_NAME.test(name)) reject('CODE_REVIEW_LISTING', `${what} is not named by a plain file name`);
  const file = path.join(root, name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) reject('CODE_REVIEW_LISTING', `${what} (${name}) is not a regular file`);
  return fs.readFileSync(file);
}

function parseJson(bytes, code, what) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    reject(code, `${what} is not UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return reject(code, `${what} is not JSON`);
  }
}

/** What the EA's readListing does with cids[0]; returns what it read. */
async function readAsArbiters(archiveService, root, trust) {
  try {
    await archiveService.validateManifest(root);
  } catch {
    reject('CODE_REVIEW_LISTING', 'manifest.json is missing or has no version');
  }
  const manifestBytes = readMember(root, MANIFEST_FILE, 'the manifest');
  const manifest = parseJson(manifestBytes, 'CODE_REVIEW_LISTING', MANIFEST_FILE);
  try {
    await validator.validateManifest(manifest, { extractedPath: root, archiveRole: 'primary', cid: null });
  } catch (err) {
    reject('CODE_REVIEW_LISTING', `the listing manifest is invalid: ${String(err.message).slice(0, 300)}`);
  }
  if (!Object.hasOwn(manifest, 'codeReview')) reject('CODE_REVIEW_LISTING', 'the manifest has no codeReview key: arbiters would not judge it as a listing');
  if (typeof manifest.primary?.filename !== 'string') reject('CODE_REVIEW_LISTING', 'a listing manifest names its primary file by filename');
  const primaryBytes = readMember(root, manifest.primary.filename, 'the primary file');
  if (!primaryBytes) reject('CODE_REVIEW_LISTING', 'the primary file is missing');
  let primary;
  try {
    primary = await validator.validateCompleteWorkflow(manifest, UTF8.decode(primaryBytes), { archiveRole: 'primary', cid: null });
  } catch (err) {
    reject('CODE_REVIEW_LISTING', `the listing's primary file is invalid: ${String(err.message).slice(0, 300)}`);
  }
  const outcomes = codeReview.validateBugOutcomes(primary.outcomes);
  if (!outcomes.ok) reject('CODE_REVIEW_LISTING', `a claim evaluation's outcomes are ${codeReview.BUG_OUTCOMES.join(', ')}, in that order`);

  const specBytes = readMember(root, manifest.codeReview, 'the codeReview spec');
  if (!specBytes) reject('CODE_REVIEW_LISTING', `the manifest names ${manifest.codeReview}, which the archive does not hold`);
  const spec = parseJson(specBytes, 'CODE_REVIEW_SPEC', 'code_review.json');
  const specResult = codeReview.validateCodeReviewSpec(spec);
  if (!specResult.ok) reject('CODE_REVIEW_SPEC', `code_review.json is invalid: ${codes(specResult.issues)}`);

  const envelope = codeReview.validateClassEnvelope(manifest.juryParameters, 'code-standard');
  if (!envelope.ok) reject('CODE_REVIEW_ENVELOPE', `the panel is outside the code-standard envelope: ${codes(envelope.issues)}`);

  const names = memberNames(spec);
  const attestationBytes = readMember(root, names.attestation, 'the attestation');
  const attestation = attestationBytes ? parseJson(attestationBytes, 'CODE_REVIEW_ATTESTATION', 'attestation.json') : undefined;
  const files = { codeReview: specBytes };
  const baselineBytes = readMember(root, names.baseline, 'the baseline');
  if (baselineBytes) files.baseline = baselineBytes;
  const knownIssuesBytes = names.knownIssues ? readMember(root, names.knownIssues, 'the known issues') : null;
  if (knownIssuesBytes) files.knownIssues = knownIssuesBytes;
  const verified = codeReview.validateAttestation(attestation, { files, trust });
  if (!verified.ok) reject('CODE_REVIEW_ATTESTATION', `attestation.json does not verify under ${trust ? 'dev' : 'production'} trust: ${codes(verified.issues)}`);

  if (names.knownIssues) {
    if (!knownIssuesBytes) reject('CODE_REVIEW_KNOWN_ISSUES', `${names.knownIssues} is missing`);
    const list = parseJson(knownIssuesBytes, 'CODE_REVIEW_KNOWN_ISSUES', names.knownIssues);
    const r = codeReview.validateKnownIssues(list);
    if (!r.ok) reject('CODE_REVIEW_KNOWN_ISSUES', `known_issues.json is invalid: ${codes(r.issues)}`);
  }
  const baseline = baselineBytes ? parseJson(baselineBytes, 'CODE_REVIEW_BASELINE', names.baseline) : null;
  const b = baseline ? codeReview.validateBaseline(baseline, spec) : null;
  if (!b?.ok) reject('CODE_REVIEW_BASELINE', `baseline.json ${baseline ? `is invalid: ${codes(b.issues)}` : 'is missing'}`);
  return { manifest, primary, spec, names };
}

/** What this site builds, beyond what arbiters require of any listing. */
function checkAsBuilt(root, role, { manifest, primary, spec, names }) {
  const expected = [MANIFEST_FILE, manifest.primary.filename, names.codeReview, names.attestation, names.baseline, ...(names.knownIssues ? [names.knownIssues] : [])];
  const found = fs.readdirSync(root);
  const extra = found.filter((n) => !expected.includes(n));
  const missing = expected.filter((n) => !found.includes(n));
  if (extra.length || missing.length) {
    reject('ARCHIVE_MEMBERS', `the archive holds ${extra.length ? `${extra.join(', ')} beyond its members` : ''}${extra.length && missing.length ? ' and ' : ''}${missing.length ? `no ${missing.join(', ')}` : ''}`);
  }
  const want = manifestFor(role);
  if (!isDeepStrictEqual(manifest.juryParameters, want.juryParameters)) {
    reject('PANEL_NOT_STANDARD', `the ${role} archive's panel is not common's ${role === 'listing' ? 'CODE_STANDARD_PANEL' : 'CODE_STANDARD_DISPUTE_PANEL'}`);
  }
  if (!isDeepStrictEqual(manifest, want)) reject('MANIFEST_NOT_STANDARD', 'the manifest is not the one this site writes');
  const query = primaryFor(spec);
  if (primary.query !== query.query) reject('QUERY_NOT_CLAIM_QUERY', 'the primary query is not common\'s buildClaimQuery output for code_review.json');
  if (!isDeepStrictEqual(primary, query)) reject('QUERY_NOT_CLAIM_QUERY', 'the primary file is not the one this site writes');
}

/**
 * @param {Buffer} bytes - the archive
 * @param {object} o
 * @param {'listing'|'dispute'} o.role
 * @param {{ dev: true, keys: object[] }} [o.trust] - dev trust; omit for production
 * @param {string} [o.workDir] - where it is extracted (a fresh folder, removed after)
 * @returns {Promise<{ ok: boolean, issues: { code: string, detail: string }[], spec: object|null }>}
 */
export async function validateListingArchive(bytes, { role, trust, workDir = os.tmpdir() }) {
  if (!Object.hasOwn(PANELS, role)) throw new TypeError(`role must be listing or dispute, not ${role}`);
  const archiveService = new ArchiveService(noIpfs, quiet);
  const dir = fs.mkdtempSync(path.join(workDir, 'sa-archive-'));
  try {
    let root;
    try {
      root = await archiveService.extractArchive(bytes, 'listing.zip', dir);
    } catch {
      return { ok: false, issues: [{ code: 'ARCHIVE_NOT_ZIP', detail: 'the archive does not extract as a ZIP' }], spec: null };
    }
    const read = await readAsArbiters(archiveService, root, trust);
    checkAsBuilt(root, role, read);
    return { ok: true, issues: [], spec: read.spec };
  } catch (err) {
    if (err instanceof Rejection) return { ok: false, issues: [{ code: err.code, detail: err.detail }], spec: null };
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
