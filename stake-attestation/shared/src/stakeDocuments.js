// `stake.documents` (owner decision Q61 (a)): where a listing's requirements are written. @verdikta/common's
// schema takes it since 1.9.0-attest.4, and the arbiters' code-runner adds the files it names to the jurors'
// context pack. This site, its builder and the hunter tool do not offer it yet (node P20 does): the listing form
// has no field for it, nothing here reads the files it names, and `check` would forecast a pack without them.
// So a listing that names it, an empty list too, is refused by this one code wherever a listing comes in (the
// listing API, the builder's spec step and its sign, the tool's check), never signed with the field unread and
// never with the field dropped.

/** The refusal's code, the same at every entry point. */
export const STAKE_DOCUMENTS_NOT_OFFERED = 'STAKE_DOCUMENTS_NOT_OFFERED';

/** Where it is, in code_review.json. */
export const STAKE_DOCUMENTS_PATH = '/stake/documents';

/** What it says. */
export const STAKE_DOCUMENTS_DETAIL = 'Stake documents are not offered yet: the site, its builder and the hunter tool refuse a listing '
  + 'that names stake.documents.';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The refusal for a code_review.json (or a draft of one) whose stake block names `documents`, whatever its value.
 * @param {unknown} spec
 * @returns {{ code: string, path: string, detail: string }|null}
 */
export function stakeDocumentsIssue(spec) {
  if (!isObject(spec) || !isObject(spec.stake) || !Object.hasOwn(spec.stake, 'documents')) return null;
  return { code: STAKE_DOCUMENTS_NOT_OFFERED, path: STAKE_DOCUMENTS_PATH, detail: STAKE_DOCUMENTS_DETAIL };
}
