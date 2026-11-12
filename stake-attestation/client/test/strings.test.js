// UI strings live in src/strings.js so the wording rule can be checked in one place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

import { STRINGS } from '../src/strings.js';

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
