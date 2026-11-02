// UI strings live in src/strings.js so the wording rule can be checked in one place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

import { STRINGS, fill } from '../src/strings.js';

function leaves(value, at = 'STRINGS') {
  if (typeof value === 'string') return [[at, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
}

test('the UI strings name the app and describe the record honestly', () => {
  assert.equal(STRINGS.appName, 'Verdikta stake attestation');
  assert.ok(STRINGS.home.lead.length > 0);
  assert.match(STRINGS.home.recordNote, /not a guarantee/);
});

test('no UI string holds a banned word', () => {
  for (const [at, text] of leaves(STRINGS)) {
    assert.deepEqual(findForbiddenWords(text), [], at);
  }
});

test('every UI string is a string, and placeholders are {name}', () => {
  const all = leaves(STRINGS);
  assert.ok(all.length > 100);
  for (const [at, text] of all) {
    assert.equal(typeof text, 'string', at);
    assert.doesNotMatch(text.replace(/\{\w+\}/g, '').replace(/\$\{?[A-Z_]+\}?/g, ''), /[{}]/, at);
  }
});

test('fill puts values into placeholders and leaves unknown ones', () => {
  assert.equal(fill('Listing {id} is open until {until}', { id: 7, until: 'then' }), 'Listing 7 is open until then');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}');
  assert.equal(fill('{toString}', {}), '{toString}');
});

test('the wording about the private key says it stays with the maker', () => {
  assert.match(STRINGS.key.shownOnce, /never sent/);
  assert.match(STRINGS.check.intro, /never sent anywhere/);
});
