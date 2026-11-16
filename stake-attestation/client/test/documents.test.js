// Node P20: the listing form's documents field (owner decision Q61 (a)). Up to 16 globs, one per line, each checked in
// the browser with @verdikta/common's documentGlobProblem and reported by the code common's validator gives that
// entry (STAKE_DOCUMENT_*), with no glob rule of the form's own. The table from common's problem to its code is held
// here to what validateCodeReviewSpec answers for each entry, so the form and the server say the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import common from '@verdikta/common';

import { MAX_DOCUMENTS, documentIssues, documentLines, numberedLines } from '../src/lib/documents.js';
import { STRINGS, fill } from '../src/strings.js';

const { codeReview } = common;
const L = STRINGS.listing;

/** What common's validator says of each entry of a stake block naming `documents`. */
const commonSays = (documents) => codeReview.validateCodeReviewSpec({ stake: { documents } }).issues
  .filter((i) => /^\/stake\/documents\/\d+$/.test(i.path))
  .map((i) => ({ index: Number(i.path.split('/').pop()), code: i.code }));

const SAMPLES = [
  'README.md', 'docs/**', 'docs/**/*.md', '**/*.md', '**/docs/**', 'docs/*-spec-*.md', 'docs/v?/*.md',
  '/etc/passwd', '/README.md', '..', '../x', 'docs/../x', 'a/..', './README.md', 'docs/./x', 'docs//x', 'docs/', '.',
  'docs\\x', 'a\u0000b', 'docs/ x', 'docs\tx', '', 'x'.repeat(513), '\u{1F600}'.repeat(512), '\u{1F600}'.repeat(513),
  'README.md', 'docs/**',
];

test('each line is checked with common\'s documentGlobProblem, by the code common\'s validator gives the entry', () => {
  // one sample per list, so each entry's code is its own and not a duplicate's
  for (const entry of SAMPLES) {
    assert.deepEqual(documentIssues([entry]).map(({ index, code }) => ({ index, code })), commonSays([entry]), JSON.stringify(entry));
  }
  // and all of them in one list: the duplicates too, each at its own place
  assert.deepEqual(documentIssues(SAMPLES).filter((i) => i.index !== null).map(({ index, code }) => ({ index, code })), commonSays(SAMPLES));
  assert.deepEqual(commonSays(['README.md', 'README.md']), [{ index: 1, code: 'STAKE_DOCUMENT_DUPLICATE' }]);
});

test('at most 16 entries, as common\'s schema holds them', () => {
  assert.equal(MAX_DOCUMENTS, codeReview.STAKE_DOCUMENT_LIMITS.maxEntries);
  const sixteen = Array.from({ length: 16 }, (_, i) => `docs/${i}.md`);
  assert.deepEqual(documentIssues(sixteen), []);
  assert.equal(codeReview.validateCodeReviewSpec({ stake: { documents: sixteen } }).issues.some((i) => i.path.startsWith('/stake/documents')), false);
  const seventeen = [...sixteen, 'docs/16.md'];
  assert.deepEqual(documentIssues(seventeen), [{ index: null, entry: null, code: 'tooMany' }]);
  assert.ok(codeReview.validateCodeReviewSpec({ stake: { documents: seventeen } }).issues.some((i) => i.path === '/stake/documents'));
});

test('lines are the field\'s entries: one per line, trimmed, blank lines dropped; none is no field', () => {
  assert.deepEqual(documentLines(' README.md \n\n docs/**\r\n'), ['README.md', 'docs/**']);
  assert.deepEqual(numberedLines(' README.md \n\n docs/**\r\n'), [{ line: 1, text: 'README.md' }, { line: 3, text: 'docs/**' }]);
  assert.deepEqual(documentLines('\n  \n'), []);
  assert.deepEqual(documentLines(''), []);
});

test('every code the form can show has its words, and each says what common says the rule is', () => {
  for (const code of ['STAKE_DOCUMENT_OUTSIDE_REPOSITORY', 'STAKE_DOCUMENT_NOT_PLAIN', 'STAKE_DOCUMENT_GLOB_INVALID', 'STAKE_DOCUMENT_DUPLICATE', 'tooMany']) {
    assert.equal(typeof L.documentCodes[code], 'string', code);
  }
  assert.match(fill(L.documentCodes.tooMany, { max: MAX_DOCUMENTS }), /16/);
  assert.match(fill(L.documentIssue, { line: 2, entry: '"./x"', code: 'STAKE_DOCUMENT_NOT_PLAIN', text: L.documentCodes.STAKE_DOCUMENT_NOT_PLAIN }), /line 2/i);
});

test('the field\'s help says what to name and that documents never widen the scope; the known-issues hint names a listing document as the second place', () => {
  assert.match(L.fields.documents, /one glob per line/);
  assert.match(L.hints.documents, /README/);
  assert.match(L.hints.documents, /specs/);
  assert.match(L.hints.documents, /interface/);
  assert.match(L.hints.documents, /requirements/);
  assert.match(L.hints.documents, /never widen the scope/);
  assert.match(L.hints.knownIssuesIntended, /in the code \(NatSpec\) or in a listing document/);
  assert.match(L.hints.knownIssuesIntended, /leave it off known issues/);
  assert.match(L.hints.knownIssuesIntended, /INVALID/);
});

test('the feed and the record page name a listing\'s documents, and say none when it names none', () => {
  for (const S of [STRINGS.feed, STRINGS.record]) {
    assert.equal(typeof S.documents, 'string');
    assert.equal(typeof S.documentsNone, 'string');
    assert.equal(typeof S.documentsUnread, 'string');
  }
  assert.match(STRINGS.record.documentsNote, /never widen the scope/);
});

test('the validation report shows the builder\'s documents step: what the tier would read, past the cap, skipped and unmatched', () => {
  const R = STRINGS.report;
  assert.equal(typeof R.stepNames.documents, 'string');
  for (const k of ['documentsTitle', 'documentsRead', 'documentsPastCap', 'documentsSkipped', 'documentsUnmatched', 'documentsNone']) assert.equal(typeof R[k], 'string', k);
  for (const reason of ['symlink', 'submodule', 'notAFile', 'tooLarge', 'notText', 'notAskable']) assert.equal(typeof R.documentsReasons[reason], 'string', reason);
});
