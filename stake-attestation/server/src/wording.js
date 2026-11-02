// The wording rule (stake-attestation/README.md): the record is a statement of what was staked and
// what the arbiters found, never a guarantee, so neither banned word may appear in anything the
// server writes about a listing, a record or a badge. Every string the server generates (badge
// text, labels, messages) passes through assertWording, which uses the shared helper CI runs over
// the source. What the server only relays from the chain (a maker's repository URL, say) is the
// maker's, not the server's wording, and is passed through as it is.
import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

export class WordingError extends Error {
  constructor(text, hits) {
    super(`WORDING: the server must not write "${hits[0].word}"`);
    this.name = 'WordingError';
    this.code = 'WORDING';
    this.text = text;
  }
}

/** @returns {string} the text, unchanged; throws WordingError on a banned word. */
export function assertWording(text) {
  const hits = findForbiddenWords(String(text));
  if (hits.length) throw new WordingError(text, hits);
  return text;
}
