// The claim archive (design §8.5): the submitted-work contract (manifest.json with a primary JSON whose
// query is the report text) with finding.json, report.md, poc.patch and an optional fix.patch at its root.
// Built with the listing flow's writer (shared/src/zip.js): a function of its input only, so the same claim is
// the same bytes. The members are the hunter's bytes as they are on disk, never serialized again.
//
// What the arbiters' External Adapter settles INVALID from the archive alone is refused here first
// (external-adapter/src/codeReview/frontGates.js, readClaimMembers and the size rule of step 8).
import fs from 'node:fs';
import path from 'node:path';
import { zipStored } from '@verdikta/stake-attestation-shared/zip';

import { BCID_QUERY_MAX_CHARS, QUERY_MIN_CHARS, codeReview } from './common.js';
import { fail } from './errors.js';

const MANIFEST_FILE = 'manifest.json';
const PRIMARY_FILE = 'primary_query.json';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** The most this tool will put in one archive: far above any claim, and short of what a gateway would hold. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** The text cut to at most `max` UTF-16 units, never through a character. */
export function cutText(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function readFileCapped(file, max) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) return { tooLarge: true };
  try {
    return fs.readFileSync(file);
  } catch {
    throw fail('FILE_ERROR', path.basename(file));
  }
}

/** The hunter's files, as bytes. @returns {{ finding: Buffer|null, report: Buffer|null, pocPatch: Buffer|null, fixPatch: Buffer|null }} */
export function readClaimInputs(claimDir) {
  const read = (name) => {
    const got = readFileCapped(path.join(claimDir, name), MAX_ARCHIVE_BYTES);
    if (got?.tooLarge) throw fail('ARCHIVE_TOO_LARGE', name);
    return got;
  };
  return {
    finding: read(codeReview.FINDING_FILE),
    report: read(codeReview.REPORT_FILE),
    pocPatch: read(codeReview.POC_PATCH_FILE),
    fixPatch: read(codeReview.FIX_PATCH_FILE),
  };
}

/** The same structural test as the EA's looksLikePatch. */
export function looksLikePatch(bytes) {
  if (!bytes || bytes.length === 0 || bytes.includes(0)) return false;
  const lines = bytes.toString('latin1').split('\n').map((line) => line.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i += 1) {
    if (/^diff --git \S+ \S+/.test(lines[i])) return true;
    if (lines[i].startsWith('--- ') && i + 2 < lines.length && lines[i + 1].startsWith('+++ ') && lines[i + 2].startsWith('@@ ')) return true;
  }
  return false;
}

/** As the runner and the EA read it: the spec's limit, or the class maximum. */
export function maxPatchBytes(spec) {
  const named = spec?.limits?.maxPatchBytes;
  return named === undefined ? codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes : named;
}

function issueCodes(issues) {
  return issues.map((i) => `${i.code}${i.detail ? ` (${i.detail})` : ''}`).join('; ');
}

/** finding.json's text as an object, or the reason it is not. */
export function parseFinding(bytes) {
  if (!bytes) return { problem: `${codeReview.FINDING_FILE} is not in this folder` };
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { problem: `${codeReview.FINDING_FILE} is not valid UTF-8` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: `${codeReview.FINDING_FILE} is not valid JSON` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: `${codeReview.FINDING_FILE} is not a JSON object` };
  return { value };
}

/** Why report.md would settle INVALID, or null: the EA's rule, and the query's length, since its text is the query. */
export function reportProblem(bytes) {
  if (!bytes) return `${codeReview.REPORT_FILE} is not in this folder`;
  let report;
  try {
    report = utf8.decode(bytes);
  } catch {
    return `${codeReview.REPORT_FILE} is not valid UTF-8`;
  }
  if (report.trim() === '') return `${codeReview.REPORT_FILE} is empty`;
  if (report.length < QUERY_MIN_CHARS) return `${codeReview.REPORT_FILE} is under ${QUERY_MIN_CHARS} characters, and its text is the archive's query`;
  return null;
}

/** Why poc.patch would settle INVALID without a run, or null. */
export function pocProblem(bytes, spec) {
  if (!bytes) return `${codeReview.POC_PATCH_FILE} is not in this folder`;
  if (!looksLikePatch(bytes)) return `${codeReview.POC_PATCH_FILE} is not a patch (no "diff --git" header and no unified-diff hunk)`;
  const limit = maxPatchBytes(spec);
  if (bytes.length > limit) return `${codeReview.POC_PATCH_FILE} is ${bytes.length} bytes; the listing allows ${limit} (maxPatchBytes)`;
  return null;
}

/**
 * The hunter's files against everything that settles INVALID without a run.
 * @returns {{ finding: object, warnings: {code: string, detail: string}[] }}
 * @throws {ToolError} FINDING_INVALID, REPORT_INVALID, POC_INVALID
 */
export function checkClaimInputs(inputs, spec) {
  const parsed = parseFinding(inputs.finding);
  if (parsed.problem) throw fail('FINDING_INVALID', parsed.problem);
  const verdict = codeReview.validateFinding(parsed.value, spec);
  if (!verdict.ok) throw fail('FINDING_INVALID', issueCodes(verdict.issues));
  const warnings = verdict.warnings.map((w) => ({ code: w.code, detail: w.detail }));

  const badReport = reportProblem(inputs.report);
  if (badReport) throw fail('REPORT_INVALID', badReport);
  const badPoc = pocProblem(inputs.pocPatch, spec);
  if (badPoc) throw fail('POC_INVALID', badPoc);

  const limit = maxPatchBytes(spec);
  if (inputs.fixPatch && inputs.fixPatch.length > limit) warnings.push({ code: 'FIX_PATCH_IGNORED', detail: `${codeReview.FIX_PATCH_FILE} is over maxPatchBytes (${limit}): arbiters ignore it` });
  if (parsed.value.fixIncluded === true && !(inputs.fixPatch?.length > 0)) warnings.push({ code: 'FIX_PATCH_MISSING', detail: 'finding.json says fixIncluded, and this folder has no fix.patch' });
  return { finding: parsed.value, warnings };
}

/**
 * The archive's bytes: a pure function of the members.
 * @param {{ finding: Buffer, report: Buffer, pocPatch: Buffer, fixPatch?: Buffer|null }} inputs
 * @returns {Buffer}
 */
export function buildClaimArchive({ finding, report, pocPatch, fixPatch = null }) {
  const query = cutText(Buffer.from(report).toString('utf8'), BCID_QUERY_MAX_CHARS);
  const archive = zipStored([
    { name: MANIFEST_FILE, bytes: pretty({ version: '1.0', primary: { filename: PRIMARY_FILE } }) },
    { name: PRIMARY_FILE, bytes: pretty({ query }) },
    { name: codeReview.FINDING_FILE, bytes: Buffer.from(finding) },
    { name: codeReview.REPORT_FILE, bytes: Buffer.from(report) },
    { name: codeReview.POC_PATCH_FILE, bytes: Buffer.from(pocPatch) },
    ...(fixPatch && fixPatch.length > 0 ? [{ name: codeReview.FIX_PATCH_FILE, bytes: Buffer.from(fixPatch) }] : []),
  ]);
  if (archive.length > MAX_ARCHIVE_BYTES) throw fail('ARCHIVE_TOO_LARGE', `${archive.length} bytes; this tool stops at ${MAX_ARCHIVE_BYTES}`);
  return archive;
}
