// The build's output folder: code_review.json, the baseline and known-issues files under the
// names code_review.json gives them, validation-report.json, and after signing the attestation
// (and, for a dev key, dev-trust.json: the public key a verifier passes as dev trust). Never the
// baseline scan's findings (src/scan.js): they are the maker's, and a folder that holds them is
// refused here so they cannot be signed or shipped with the listing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BuilderError } from './errors.js';
import { REPORT_FILE } from './report.js';
import { serializeJson } from './spec.js';

export const DEV_TRUST_FILE = 'dev-trust.json';
/** The baseline scan's findings file: the maker's alone, never in a listing folder. */
export const SCAN_FILE = 'scan-findings.json';

function plainName(name) {
  if (typeof name !== 'string' || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/.test(name)) throw new BuilderError('OUTPUT_INVALID', `${JSON.stringify(name)} is not a plain file name`);
  return name;
}

/** Writes a build's files (a Map name -> bytes) and its report into `dir`. */
export function writeOutputs(dir, { files, report }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) fs.writeFileSync(path.join(dir, plainName(name)), bytes, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, REPORT_FILE), serializeJson(report), { mode: 0o644 });
}

/** Reads an output folder back: the exact bytes of the listing files, the report and the names. */
export function readOutputs(dir) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, plainName(name)));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  if (fs.existsSync(path.join(dir, SCAN_FILE))) {
    throw new BuilderError('SCAN_RESULTS_IN_LISTING_DIR', `${dir} holds the baseline scan's findings (${SCAN_FILE}), which are the maker's alone: move them out of the listing folder`);
  }
  const reportBytes = read(REPORT_FILE);
  const codeReview = read('code_review.json');
  if (!reportBytes || !codeReview) throw new BuilderError('OUTPUT_INVALID', `${dir} holds no ${reportBytes ? 'code_review.json' : REPORT_FILE}: run build first`);
  let report;
  let spec;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
    spec = JSON.parse(codeReview.toString('utf8'));
  } catch {
    throw new BuilderError('OUTPUT_INVALID', `${dir}: the report or code_review.json is not JSON`);
  }
  const names = { baseline: spec.baseline, knownIssues: spec.stake?.knownIssues ?? null, attestation: spec.attestation };
  const baseline = read(names.baseline);
  if (!baseline) throw new BuilderError('OUTPUT_INVALID', `${dir} holds no ${names.baseline}`);
  const knownIssues = names.knownIssues ? read(names.knownIssues) : null;
  return { files: { codeReview, baseline, knownIssues }, report, names };
}

/**
 * The digest of a build's output folder as it left the build: the SHA-256 of the lines
 * "<sha256 hex>  <name>\n" of every file, sorted by name. The reusable workflow's build job
 * publishes it as a job output and the sign job compares the folder it downloaded.
 * @throws {BuilderError} OUTPUT_INVALID (anything but plain files)
 */
export function outputsDigest(dir) {
  const lines = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isFile()) throw new BuilderError('OUTPUT_INVALID', `${path.join(dir, e.name)} is not a plain file`);
    lines.push(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex')}  ${e.name}\n`);
  }
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}
