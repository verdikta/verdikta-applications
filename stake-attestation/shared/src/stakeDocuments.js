// `stake.documents` (owner decision Q61 (a); node P20): where a listing's code's requirements are written, such as
// its README, specs or interface docs. @verdikta/common holds every rule of the field (documentGlobProblem,
// selectDocuments, isDocumentText, STAKE_DOCUMENT_LIMITS; docs/CODE_REVIEW_SPECIFICATION.md, "Stake documents"), and
// the arbiters' code-runner adds the files it picks to the jurors' context pack, right after the in-scope source.
// The site, its builder and the hunter tool call common's functions and report common's codes: nothing here holds a
// glob rule. What lives here is when a listing names documents at all, which decides whether the builder's report
// and the tool's forecast say anything of them, and what every place that offers or shows the field says of the
// scope. Nothing of node in this file: the client bundles it.

/** Where the field is, in code_review.json. */
export const STAKE_DOCUMENTS_PATH = '/stake/documents';

/** What the listing form, the record and the hunter tool say beside the field (design §10.3; owner, Q61 (a)). */
export const STAKE_DOCUMENTS_NOTE = 'Documents never widen the scope: a finding\'s affected paths must still be in scope, and the claim\'s '
  + 'query is the same with or without them. The jurors read them as the maker\'s own statement of what the code must do.';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether a code_review.json (or a draft of one) names documents: its own stake block holds stake.documents as a
 * list with an entry. The runner at the pin decides its pack's documents tier by the same test (verdikta-arbiter
 * code-runner/src/pack.js, namesDocuments): without the field, or with an empty list, there is no tier, and a
 * listing's archives, report and forecast are what they were before the field existed.
 * @param {unknown} spec
 * @returns {boolean}
 */
export function namesDocuments(spec) {
  if (!isObject(spec) || !isObject(spec.stake) || !Object.hasOwn(spec.stake, 'documents')) return false;
  return Array.isArray(spec.stake.documents) && spec.stake.documents.length > 0;
}

/**
 * The listing's document globs as it names them, a copy; none when it names none.
 * @param {unknown} spec
 * @returns {unknown[]}
 */
export function documentGlobs(spec) {
  return namesDocuments(spec) ? [...spec.stake.documents] : [];
}
