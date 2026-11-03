// A valid baseline.json whose JSON in the code-runner's request is exactly `bytes` long, for the size
// rule's tests in the builder, the server and the local round. Every test passes all three runs, as a
// big suite would, so each one is in `tests` and in `stable`.
const body = (baseCommit, ids, buildSeconds) => ({
  version: 1,
  baseCommit,
  framework: 'forge',
  runs: 3,
  tests: ids.map((id) => ({ id, results: ['pass', 'pass', 'pass'] })),
  stable: [...ids],
  unstable: [],
  timings: { buildSeconds, testSeconds: [1.5, 1.4, 1.6] },
});
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const idOf = (i, length) => {
  const prefix = `test/Big.t.sol > Big > test_${i}_`;
  return `${prefix}${'x'.repeat(Math.max(0, length - prefix.length - 2))}()`;
};

/**
 * @param {number} bytes - the size wanted
 * @param {string} baseCommit
 * @param {{ idLength?: number }} [o] - how long most test ids are (a test id is at most 1024)
 * @returns {object} the baseline
 * @throws {RangeError} `bytes` is too small for a baseline, or for one more test
 */
export function baselineOfBytes(bytes, baseCommit, { idLength = 1000 } = {}) {
  const ids = [];
  const each = size(body(baseCommit, [idOf(1, idLength), idOf(2, idLength)], 4.2)) - size(body(baseCommit, [idOf(1, idLength)], 4.2));
  // leave the last test or two to make up the exact size
  const whole = Math.max(0, Math.floor((bytes - size(body(baseCommit, [], 4.2))) / each) - 1);
  for (let i = 0; i < whole; i += 1) ids.push(idOf(i, idLength));
  for (let i = whole; ; i += 1) {
    const left = bytes - size(body(baseCommit, ids, 4.2));
    if (left < 0) throw new RangeError(`no baseline of ${bytes} bytes`);
    if (left === 0) return body(baseCommit, ids, 4.2);
    if (left === 1) return body(baseCommit, ids, 4.25); // one digit more: a test costs an even number of bytes per character
    const shortest = size(body(baseCommit, [...ids, idOf(i, 0)], 4.2)) - size(body(baseCommit, ids, 4.2));
    if (left < shortest) {
      // too little room for a test of its own: a character more in the last id costs two bytes
      const last = ids.pop();
      ids.push(`${last.slice(0, -2)}${'y'.repeat(Math.floor(left / 2))}()`);
      continue;
    }
    const prefixLength = idOf(i, 0).length;
    const length = Math.min(1024, prefixLength + Math.floor((left - shortest) / 2));
    ids.push(idOf(i, length));
  }
}
