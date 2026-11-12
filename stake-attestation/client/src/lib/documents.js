// The listing form's documents field (stake.documents; owner decision Q61 (a); node P20): up to 16 globs, one per
// line, naming where the code's requirements are written. Each line is checked in the browser with @verdikta/common's
// own documentGlobProblem, from its browser-safe scope module, and reported by the code common's validator gives
// that entry; the form holds no glob rule of its own. common's validator (src/codeReview/validate.js) turns each
// problem into its code with the table below, and test/documents.test.js holds the table to what it answers for
// every kind of entry. The server checks the same draft with that validator before anything is built.
import scope from '@verdikta/common/src/codeReview/scope.js';
import constants from '@verdikta/common/src/codeReview/constants.js';

const { documentGlobProblem } = scope;

/** At most this many globs (common's STAKE_DOCUMENT_LIMITS.maxEntries, its schema's maxItems). */
export const MAX_DOCUMENTS = constants.STAKE_DOCUMENT_LIMITS.maxEntries;

/** documentGlobProblem's answer, as the code common's validator reports it. */
const PROBLEM_CODES = Object.freeze({
  notString: 'STAKE_DOCUMENT_GLOB_INVALID',
  length: 'STAKE_DOCUMENT_GLOB_INVALID',
  whitespace: 'STAKE_DOCUMENT_GLOB_INVALID',
  absolute: 'STAKE_DOCUMENT_OUTSIDE_REPOSITORY',
  parent: 'STAKE_DOCUMENT_OUTSIDE_REPOSITORY',
  notPlain: 'STAKE_DOCUMENT_NOT_PLAIN',
});

/** The field's entries with the textarea line each is on (from 1): one per line, each trimmed, blank lines dropped. */
export function numberedLines(text) {
  return String(text).split('\n').map((s, i) => ({ line: i + 1, text: s.trim() })).filter((x) => x.text !== '');
}

/** The field's entries: one per line, each trimmed, blank lines dropped. */
export function documentLines(text) {
  return numberedLines(text).map((x) => x.text);
}

/**
 * Each entry common would refuse, at its index, by common's code: a glob that is not a document glob, or the same as
 * an earlier one (STAKE_DOCUMENT_DUPLICATE); and first, past MAX_DOCUMENTS, `tooMany` (common's schema says so of the list).
 * @param {unknown[]} entries
 * @returns {{ index: number|null, entry: unknown, code: string }[]}
 */
export function documentIssues(entries) {
  // the list's own issue first, then each entry's, as common's validator reports both
  const out = entries.length > MAX_DOCUMENTS ? [{ index: null, entry: null, code: 'tooMany' }] : [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const problem = documentGlobProblem(entry);
    if (problem !== null) out.push({ index, entry, code: PROBLEM_CODES[problem] });
    else if (seen.has(entry)) out.push({ index, entry, code: 'STAKE_DOCUMENT_DUPLICATE' });
    else seen.add(entry);
  });
  return out;
}
