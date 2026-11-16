// Node P20: `stake.documents` (owner decision Q61 (a)) is offered. @verdikta/common holds the field's rules
// (documentGlobProblem, selectDocuments, isDocumentText, STAKE_DOCUMENT_LIMITS), and nothing here copies them: what
// lives here is when a listing names documents at all, as the arbiters' runner at the pin decides it
// (code-runner/src/pack.js, namesDocuments: a list with an entry), and what every place that offers or shows the
// field says of it. P21's refusal is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wordingProblems } from '../src/index.js';
import { STAKE_DOCUMENTS_NOTE, STAKE_DOCUMENTS_PATH, documentGlobs, namesDocuments } from '../src/stakeDocuments.js';

const spec = (stake) => ({ version: 1, kind: 'bug', stake });
const REFUSAL = ['STAKE_DOCUMENTS', 'NOT_OFFERED'].join('_');

test('a stake block names documents when stake.documents is a list with an entry, as the runner at the pin reads it', () => {
  for (const documents of [['README.md'], ['docs/**', 'SPEC.md'], ['./bad', 'README.md']]) {
    assert.equal(namesDocuments(spec({ scope: { include: ['src/**'] }, documents })), true, JSON.stringify(documents));
    assert.deepEqual(documentGlobs(spec({ documents })), documents);
  }
  // no field, an empty list, or anything but a list: no documents tier, and nothing changes
  for (const documents of [undefined, [], 'README.md', null, { 0: 'README.md' }]) {
    const s = spec(documents === undefined ? { scope: { include: ['src/**'] } } : { documents });
    assert.equal(namesDocuments(s), false, JSON.stringify(documents));
    assert.deepEqual(documentGlobs(s), []);
  }
  for (const v of [null, undefined, 'spec', 1, [], { version: 1 }, spec(null), spec([]), spec('x')]) {
    assert.equal(namesDocuments(v), false, JSON.stringify(v));
    assert.deepEqual(documentGlobs(v), []);
  }
  // an inherited key is not the maker's
  assert.equal(namesDocuments(spec(Object.create({ documents: ['README.md'] }))), false);
  assert.equal(STAKE_DOCUMENTS_PATH, '/stake/documents');
});

test('documentGlobs is a copy: changing it changes no spec', () => {
  const s = spec({ documents: ['README.md'] });
  documentGlobs(s).push('docs/**');
  assert.deepEqual(s.stake.documents, ['README.md']);
});

test('the note every place says: documents never widen the scope, and the query is the same; it passes the wording check', () => {
  assert.match(STAKE_DOCUMENTS_NOTE, /never widen the scope/);
  assert.match(STAKE_DOCUMENTS_NOTE, /query/);
  assert.doesNotMatch(STAKE_DOCUMENTS_NOTE, /not offered/i);
  assert.deepEqual(wordingProblems(STAKE_DOCUMENTS_NOTE), []);
});

test('P21\'s refusal is gone from the package', async () => {
  const exported = await import('@verdikta/stake-attestation-shared/stake-documents');
  assert.equal(exported.namesDocuments, namesDocuments);
  assert.equal(exported[REFUSAL], undefined);
  assert.equal(exported.stakeDocumentsIssue, undefined);
  const all = await import('../src/index.js');
  assert.equal(all[REFUSAL], undefined);
  assert.equal(all.namesDocuments, namesDocuments);
});
