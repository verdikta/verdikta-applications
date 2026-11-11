// Node P19 (owner, 2026-11-10, Q73 #5): the listing form says, at its known-issues fields, what a known issue does.
// A claim whose root cause is a listed known issue settles DUPLICATE whatever the entry says about why; a behaviour
// meant as no bug at all stays off known issues and is documented as intended in the code (NatSpec), so a claim
// about it falls under INVALID. The listing documents field is node P20's and is not named here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { STRINGS } from '../src/strings.js';

const H = STRINGS.listing.hints;
const FORM = fs.readFileSync(new URL('../src/components/ListingForm.jsx', import.meta.url), 'utf8');

test('the known-issues hint: a root cause on the list settles DUPLICATE, whatever the entry says about why', () => {
  assert.match(H.knownIssues, /root cause is one of them/);
  assert.match(H.knownIssues, /DUPLICATE/);
  assert.match(H.knownIssues, /whatever the entry says about why/);
});

test('the known-issues hint: a behaviour meant as no bug stays off the list and is documented as intended in the code', () => {
  assert.match(H.knownIssuesIntended, /no bug at all/);
  assert.match(H.knownIssuesIntended, /leave it off known issues/);
  assert.match(H.knownIssuesIntended, /document it as intended in the code \(NatSpec\)/);
  assert.match(H.knownIssuesIntended, /falls under INVALID/);
});

test('neither names a listing documents field, which is node P20\'s', () => {
  for (const text of [H.knownIssues, H.knownIssuesIntended]) {
    assert.doesNotMatch(text, /\bdocuments\b/i);
    assert.doesNotMatch(text, /document field/i);
  }
});

test('the form shows both at the known-issues fields', () => {
  const start = FORM.indexOf('<legend>{L.sections.knownIssues}</legend>');
  assert.ok(start > 0, 'the known-issues fieldset');
  const fieldset = FORM.slice(start, FORM.indexOf('</fieldset>', start));
  assert.ok(fieldset.includes('{L.hints.knownIssues}'), fieldset);
  assert.ok(fieldset.includes('{L.hints.knownIssuesIntended}'), fieldset);
  assert.ok(fieldset.indexOf('{L.hints.knownIssuesIntended}') < fieldset.indexOf('<KnownIssuesEditor'), 'before the entries');
});
