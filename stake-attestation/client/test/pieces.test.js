// The site draws parts of two lines apart from their words: a disclosure key's two forms as chips, and another
// listing's commit in monospace and its state as a pill. The page's text must still be the line strings.js says,
// character for character (what a reader selects, a search of the page finds and a tool reads), so each line is
// drawn from its pieces, and the pieces joined are fill()'s line.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joined, pieces } from '../src/lib/pieces.js';
import { STRINGS, fill } from '../src/strings.js';

const D = STRINGS.disclosure;
const S = STRINGS.sameRepository;

test('the pieces of a line, joined, are the line fill makes', () => {
  const key = { recipient: `age1${'q'.repeat(58)}`, bytes32: `0x${'ab'.repeat(32)}` };
  assert.equal(joined(pieces(D.line, key)), fill(D.line, key));
  for (const state of Object.values(STRINGS.fund.states)) {
    const other = { id: '12', commit: 'c'.repeat(40), state };
    assert.equal(joined(pieces(S.line, other)), fill(S.line, other));
  }
});

test('each {name} with a value is one piece, in the line\'s order; the words between are text', () => {
  assert.deepEqual(pieces('{a} and {b}, then {a}.', { a: 1, b: 'two' }), [
    { name: 'a', value: '1' },
    { text: ' and ' },
    { name: 'b', value: 'two' },
    { text: ', then ' },
    { name: 'a', value: '1' },
    { text: '.' },
  ]);
  assert.deepEqual(pieces('no names here'), [{ text: 'no names here' }]);
  assert.deepEqual(pieces(''), []);
});

test('a {name} with no value stays as text, as fill leaves it', () => {
  const list = pieces('{id} at {commit}', { id: 3 });
  assert.deepEqual(list, [{ name: 'id', value: '3' }, { text: ' at ' }, { text: '{commit}' }]);
  assert.equal(joined(list), fill('{id} at {commit}', { id: 3 }));
});

test('the two lines hold the values their components draw apart, and each form of the key has a copy name', () => {
  const names = (line) => pieces(line, { recipient: 'r', bytes32: 'b', id: 'i', commit: 'c', state: 's' }).filter((p) => p.name).map((p) => p.name);
  assert.deepEqual(names(D.line).sort(), ['bytes32', 'recipient']);
  assert.deepEqual(names(S.line).sort(), ['commit', 'id', 'state']);
  for (const form of names(D.line)) assert.equal(typeof D.copy[form], 'string');
  // the state is a pill: the words that lead to it are in the text and not drawn, so they must be words, not a value
  const line = pieces(S.line, { id: 'i', commit: 'c', state: 's' });
  const at = line.findIndex((p) => p.name === 'state');
  assert.ok(at > 0 && typeof line[at - 1].text === 'string');
});
