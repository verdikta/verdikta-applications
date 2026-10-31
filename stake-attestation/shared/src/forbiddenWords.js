// The stake-attestation app never calls a listing, record or badge by the two words assembled
// below: the record is a statement of stake and judgement, not a guarantee (design §20, "Legal").
// The words are built from parts so that this file, and every file that imports it, passes the
// check it implements.
const STEM = ['cert', 'if'].join('');

export const FORBIDDEN_WORDS = Object.freeze([`${STEM}ied`, `${STEM}ication`]);

/**
 * Every occurrence of a banned word in `text`, in any case and inside longer words.
 * @param {string} text
 * @returns {{ word: string, index: number, line: number, column: number }[]} 1-based line and column
 */
export function findForbiddenWords(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const word of FORBIDDEN_WORDS) {
    for (let index = lower.indexOf(word); index !== -1; index = lower.indexOf(word, index + 1)) {
      const before = text.slice(0, index);
      const line = before.split('\n').length;
      const column = index - before.lastIndexOf('\n');
      hits.push({ word, index, line, column });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
