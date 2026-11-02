// Node P9: the warning every listing page carries, which the hunter tool (P5) reuses: who reads a
// proof first, and that the code may exist elsewhere. It passes the wording rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LISTING_WARNING, LISTING_WARNING_LINES, wordingProblems } from '../src/index.js';

test('it says who reads a proof first and that the code may exist elsewhere', () => {
  assert.match(LISTING_WARNING.proofFirst, /staker's disclosure key/);
  assert.match(LISTING_WARNING.proofFirst, /first/);
  assert.match(LISTING_WARNING.elsewhere, /may exist elsewhere/);
  assert.deepEqual(LISTING_WARNING_LINES, [LISTING_WARNING.proofFirst, LISTING_WARNING.elsewhere]);
});

test('it passes the banned-words and judgemental-phrase checks', () => {
  for (const line of Object.values(LISTING_WARNING)) assert.deepEqual(wordingProblems(line), [], line);
});

test('it can be imported on its own, with nothing of node in it (the client bundles it)', async () => {
  const m = await import('@verdikta/stake-attestation-shared/listing-warning');
  assert.equal(m.LISTING_WARNING.proofFirst, LISTING_WARNING.proofFirst);
});
