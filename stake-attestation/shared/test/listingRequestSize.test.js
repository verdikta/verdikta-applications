// Node P11: the size rule's module on its own. It has no dependency, like the rest of this package, so
// common's limits are an argument; the builder's tests run it on the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wordingProblems } from '../src/index.js';
import { LISTING_REQUEST_MAX_BYTES, LISTING_REQUEST_TOO_LARGE, listingParts, listingRequestRefusal, listingRequestSize, requestBytes } from '../src/listingRequestSize.js';

const finding = { properties: { title: { maxLength: 4 }, rootCause: { maxLength: 4 }, affectedPaths: { maxItems: 2 }, poc: { properties: { command: { maxLength: 4 }, observable: { maxLength: 4 } } } }, definitions: { RepoPath: { maxLength: 4 } } };
const codeReview = {
  schemas: { finding },
  SPEC_LIMIT_MAXIMA: { maxPatchBytes: 8 },
  MAX_PRIOR_FINDINGS: 2,
  CODE_CLASSES: { small: { envelope: { contextPackTokens: 2 } } },
  getCodeClass() { return this.CODE_CLASSES.small; },
};
const parts = (bytes) => ({ spec: {}, attestation: {}, knownIssues: [], baseline: { pad: 'x'.repeat(bytes - 6 - 10) } });

test('under the bound: no refusal. Over it: the named code, with the size, the bound and each part', () => {
  assert.equal(listingRequestSize(parts(LISTING_REQUEST_MAX_BYTES)).bytes, LISTING_REQUEST_MAX_BYTES);
  assert.equal(listingRequestRefusal(parts(LISTING_REQUEST_MAX_BYTES), { codeReview }), null);
  const r = listingRequestRefusal(parts(LISTING_REQUEST_MAX_BYTES + 1), { codeReview });
  assert.equal(r.code, LISTING_REQUEST_TOO_LARGE);
  assert.equal(r.bytes, LISTING_REQUEST_MAX_BYTES + 1);
  assert.equal(r.bound, LISTING_REQUEST_MAX_BYTES);
  assert.match(r.detail, new RegExp(`${LISTING_REQUEST_MAX_BYTES + 1} bytes`));
  assert.match(r.detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
  assert.match(r.detail, /baseline \d+/);
  assert.deepEqual(wordingProblems(r.detail), []);
});

test('a file is read as the arbiters read it: strict UTF-8, then JSON; attestation given as a file or as a value', () => {
  const files = { codeReview: Buffer.from('{}'), baseline: Buffer.from('{}'), knownIssues: null, attestation: Buffer.from('{"a":1}') };
  assert.deepEqual(listingParts(files).attestation, { a: 1 });
  assert.deepEqual(listingParts({ ...files, attestation: { a: 2 } }).attestation, { a: 2 });
  assert.throws(() => listingParts({ ...files, baseline: Buffer.from([0x7b, 0xff, 0x7d]) }));
  assert.throws(() => listingParts({ ...files, baseline: Buffer.from('not json') }));
});

test('known issues count at the larger of their file and their place in the request', () => {
  const list = Buffer.from('[]');
  const padded = Buffer.concat([list, Buffer.alloc(100, 0x20)]);
  const base = { codeReview: Buffer.from('{}'), baseline: Buffer.from('{}'), attestation: {} };
  assert.equal(listingRequestSize(listingParts({ ...base, knownIssues: list })).parts.knownIssues, 2);
  assert.equal(listingRequestSize(listingParts({ ...base, knownIssues: padded })).parts.knownIssues, 102);
  // and the rest as the request holds them
  assert.equal(requestBytes({ a: '\u0001' }), Buffer.byteLength('{"a":"\\u0001"}'));
});
