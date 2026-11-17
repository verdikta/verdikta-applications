// Node P35 (claim test, item 6): a listing whose only document stated no requirement left a hunter to guess them. The
// page a maker lists code on now recommends, once, a document that states the code's requirements, beside the field
// that names it, and says what the jurors have without one: what agents.txt says they read (section 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { wordingProblems } from '../e2e/support/wording.js';
import { STRINGS } from '../src/strings.js';

const form = fs.readFileSync(new URL('../src/components/ListingForm.jsx', import.meta.url), 'utf8');

test('the listing form recommends a document that states the requirements, in the documents section', () => {
  const text = STRINGS.listing.hints.requirementsDocument;
  assert.equal(typeof text, 'string');
  assert.match(text, /^We recommend/);
  assert.match(text, /document that states/);
  assert.match(text, /requirements/);
  assert.match(text, /source files a claim names/, 'what the jurors have without one');
  assert.deepEqual(wordingProblems(text), []);
  // rendered once, in the documents fieldset, beside the field's own hint
  const documents = form.slice(form.indexOf('<legend>{L.sections.documents}</legend>'), form.indexOf('<legend>{L.sections.awards}</legend>'));
  assert.match(documents, /L\.hints\.requirementsDocument/);
  assert.equal(form.split('L.hints.requirementsDocument').length, 2, 'once');
  // one recommendation: no other string on the page says it
  const others = JSON.stringify({ ...STRINGS.listing, hints: { ...STRINGS.listing.hints, requirementsDocument: '' } });
  assert.doesNotMatch(others, /We recommend/);
});
