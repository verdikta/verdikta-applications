// Node P21: `stake.documents` (owner decision Q61 (a)), which @verdikta/common's schema takes since
// 1.9.0-attest.4, is not offered here yet (node P20 offers it). A listing that names it is refused by one
// code, wherever a listing comes in: the site's listing API, the builder and the hunter tool's check. The
// rule and its text live here, so the three refuse alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wordingProblems } from '../src/index.js';
import { STAKE_DOCUMENTS_DETAIL, STAKE_DOCUMENTS_NOT_OFFERED, stakeDocumentsIssue } from '../src/stakeDocuments.js';

const spec = (stake) => ({ version: 1, kind: 'bug', stake });

test('a stake block that names documents is refused by one code, saying documents are not offered yet', () => {
  for (const documents of [['README.md'], ['docs/**', 'SPEC.md'], [], 'README.md', null]) {
    assert.deepEqual(stakeDocumentsIssue(spec({ scope: { include: ['src/**'] }, documents })), {
      code: STAKE_DOCUMENTS_NOT_OFFERED,
      path: '/stake/documents',
      detail: STAKE_DOCUMENTS_DETAIL,
    }, JSON.stringify(documents));
  }
  assert.equal(STAKE_DOCUMENTS_NOT_OFFERED, 'STAKE_DOCUMENTS_NOT_OFFERED');
  assert.match(STAKE_DOCUMENTS_DETAIL, /documents are not offered yet/i);
  assert.match(STAKE_DOCUMENTS_DETAIL, /stake\.documents/);
});

test('a spec without documents, without a stake block, or not an object, has no such issue', () => {
  assert.equal(stakeDocumentsIssue(spec({ scope: { include: ['src/**'] } })), null);
  assert.equal(stakeDocumentsIssue({ version: 1 }), null);
  for (const v of [null, undefined, 'spec', 1, [], spec(null), spec([]), spec('x')]) assert.equal(stakeDocumentsIssue(v), null, JSON.stringify(v));
  // an inherited key is not the maker's
  assert.equal(stakeDocumentsIssue(spec(Object.create({ documents: ['README.md'] }))), null);
});

test('the text passes the wording check, and the package exports the rule', async () => {
  assert.deepEqual(wordingProblems(STAKE_DOCUMENTS_DETAIL), []);
  const exported = await import('@verdikta/stake-attestation-shared/stake-documents');
  assert.equal(exported.stakeDocumentsIssue, stakeDocumentsIssue);
  assert.equal(exported.STAKE_DOCUMENTS_NOT_OFFERED, STAKE_DOCUMENTS_NOT_OFFERED);
});
