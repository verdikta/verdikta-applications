// The wording rule (stake-attestation/README.md): the record is a statement of what was staked and
// what the arbiters found, never a guarantee, so nothing the server writes about a listing, a record
// or a badge may hold a banned word or a judgemental phrase. Every string the server generates
// (badge text, labels, facts, messages) passes through assertWording, which uses the shared helper
// CI runs over the source. What the server only relays from the chain (a maker's repository URL,
// say) is the maker's, not the server's wording, and is passed through as it is.
import { wordingProblems } from '@verdikta/stake-attestation-shared';

export class WordingError extends Error {
  constructor(text, problems) {
    super(`WORDING: the server must not write this: ${problems[0]}`);
    this.name = 'WordingError';
    this.code = 'WORDING';
    this.text = text;
  }
}

/** @returns {string} the text, unchanged; throws WordingError on a banned word or a judgemental phrase. */
export function assertWording(text) {
  const problems = wordingProblems(String(text));
  if (problems.length) throw new WordingError(text, problems);
  return text;
}
