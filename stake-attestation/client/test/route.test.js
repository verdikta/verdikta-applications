// The address names the page (src/App.jsx route()). A listing's id is read from it once, and from there on it has one
// form: the decimal number with no leading zeros, which is how the contract, the site's record and the feed write it.
// A page that kept the id as it was typed read listing 1 for "#/fund/001" and then compared "001" with the record's
// "1": the listing was listed among the other listings of its own repository, with the hold the record had of it
// (PR 242, R5-F1). So every reader of the id is given the same one, where the address is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// route() as App.jsx has it: the function's own text, which is plain JavaScript, run on an address's hash
const text = /^function route\(\) \{\n[\s\S]*?\n\}$/m.exec(source)?.[0];
const route = (hash) => new Function('window', `${text}\nreturn route();`)({ location: { hash } });

test('route(): the function is read from App.jsx whole', () => {
  assert.match(text ?? '', /^function route\(\) \{\n {2}const h = window\.location\.hash/);
  assert.match(text, /return \{ page: 'home' \};\n\}$/);
});

test('a listing\'s address gives one id for one listing, however the address writes it', () => {
  const ROWS = [
    // the address                       the listing id every reader of it is given
    ['#/fund/1', '1'],
    ['#/fund/001', '1'],
    ['#/fund/00000000000000000001', '1'],
    ['#/fund/10', '10'],
    ['#/fund/010', '10'],
    ['#/fund/0', '0'],
    ['#/fund/000', '0'],
    // twenty digits are a number the page keeps whole: more than a double holds
    ['#/fund/18446744073709551615', '18446744073709551615'],
    ['#/fund/99999999999999999999', '99999999999999999999'],
    ['#/fund/09007199254740993', '9007199254740993'],
  ];
  for (const [hash, listingId] of ROWS) assert.deepEqual(route(hash), { page: 'fund', listingId }, hash);
  // the finding's pair: one listing, one id
  assert.deepEqual(route('#/fund/001'), route('#/fund/1'));
  // and it is a string of digits, as the record and the feed have it: what they are compared with
  for (const [hash] of ROWS) assert.match(route(hash).listingId, /^(0|[1-9]\d*)$/, hash);
});

test('a listing\'s address: no id is the lookup, and what is not a listing id is not a listing\'s page', () => {
  assert.deepEqual(route('#/fund'), { page: 'fund', listingId: null });
  for (const hash of ['#/fund/', '#/fund/1x', '#/fund/-1', '#/fund/1.0', '#/fund/0x1', '#/fund/1/2', '#/fund/ 1', '#/fund/123456789012345678901']) {
    assert.deepEqual(route(hash), { page: 'home' }, hash);
  }
});
