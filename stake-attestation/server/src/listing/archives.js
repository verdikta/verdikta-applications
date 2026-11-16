// The two archives a listing pins (design §8.1, §10.4; build plan A3): the evaluation archive,
// cids[0] of every claim's request, and the dispute archive, cids[0] of a dispute request. Both
// hold the same members; the only difference is the panel:
//
//   manifest.json       { version, primary, juryParameters, codeReview }: the panel is
//                       common's CODE_STANDARD_PANEL (listing) or CODE_STANDARD_DISPUTE_PANEL
//   primary_query.json  { query: common's buildClaimQuery(spec), outcomes: BUG_OUTCOMES, references: [] }
//   code_review.json    the builder's bytes, as attested
//   attestation.json    the builder's signed statement, under the name code_review.json gives it
//   baseline.json       the builder's baseline, under the name code_review.json gives it
//   known_issues.json   the maker's known issues, when the spec names them
//
// Nothing here is written by hand: the query, the outcomes and the panels are common's, and the
// three attested files are the builder's exact bytes, so the archive is exactly what the
// arbiters' External Adapter reads (external-adapter/src/codeReview/frontGates.js, readListing).
import { codeReview } from '../common.js';
import { zipStored } from '../zip.js';

export const MANIFEST_FILE = 'manifest.json';
export const PRIMARY_FILE = 'primary_query.json';
/** Names a listing's own files may not take: the manifest, the primary query and the spec. */
export const RESERVED_NAMES = Object.freeze([MANIFEST_FILE, PRIMARY_FILE, codeReview.CODE_REVIEW_FILE]);

export const PANELS = Object.freeze({
  listing: codeReview.CODE_STANDARD_PANEL,
  dispute: codeReview.CODE_STANDARD_DISPUTE_PANEL,
});

const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The names code_review.json gives the attested files (common's defaults where it names none). */
export function memberNames(spec) {
  return {
    codeReview: codeReview.CODE_REVIEW_FILE,
    attestation: spec.attestation ?? codeReview.ATTESTATION_FILE,
    baseline: spec.baseline ?? codeReview.BASELINE_FILE,
    knownIssues: spec.stake?.knownIssues ?? null,
  };
}

export function manifestFor(role) {
  if (!Object.hasOwn(PANELS, role)) throw new TypeError(`no panel for the ${role} archive`);
  return {
    version: '1.0',
    primary: { filename: PRIMARY_FILE },
    juryParameters: plain(PANELS[role]),
    codeReview: codeReview.CODE_REVIEW_FILE,
  };
}

export function primaryFor(spec) {
  return { query: codeReview.buildClaimQuery(spec), outcomes: [...codeReview.BUG_OUTCOMES], references: [] };
}

/**
 * @param {{ codeReview: Buffer, baseline: Buffer, knownIssues: Buffer|null, attestation: Buffer }} files -
 *   the builder's exact bytes
 * @returns {{ spec: object, query: string, names: object, listing: { bytes: Buffer, members: { name: string, bytes: Buffer }[] }, dispute: { bytes: Buffer, members: { name: string, bytes: Buffer }[] } }}
 * @throws {TypeError} a spec common's buildClaimQuery refuses, or members the spec does not name
 */
export function buildListingArchives(files) {
  const spec = JSON.parse(Buffer.from(files.codeReview).toString('utf8'));
  const names = memberNames(spec);
  if (Boolean(names.knownIssues) !== Boolean(files.knownIssues)) {
    throw new TypeError(names.knownIssues ? `code_review.json names ${names.knownIssues}, which the build did not return` : 'the build returned known issues that code_review.json does not name');
  }
  const primary = primaryFor(spec);
  const rest = [
    { name: names.codeReview, bytes: Buffer.from(files.codeReview) },
    { name: names.attestation, bytes: Buffer.from(files.attestation) },
    { name: names.baseline, bytes: Buffer.from(files.baseline) },
    ...(names.knownIssues ? [{ name: names.knownIssues, bytes: Buffer.from(files.knownIssues) }] : []),
  ];
  const archive = (role) => {
    const members = [{ name: MANIFEST_FILE, bytes: json(manifestFor(role)) }, { name: PRIMARY_FILE, bytes: json(primary) }, ...rest];
    return { bytes: zipStored(members), members };
  };
  return { spec, query: primary.query, names, listing: archive('listing'), dispute: archive('dispute') };
}
