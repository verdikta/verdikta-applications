// Node P9: "did the builder sign this listing", as the site's feed and the hunter tool (P5) ask it,
// from the listing archive's bytes alone: the attestation over the files it binds, under the trust
// the caller gives. Common's validator is passed in (this package has no dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSignedListing } from '../src/builderSignature.js';
import { zipStored } from '../src/zip.js';

const files = (over = {}) => ({
  'manifest.json': JSON.stringify({ version: '1.0', codeReview: 'code_review.json' }),
  'code_review.json': JSON.stringify({ repo: 'https://github.com/acme/vault', baseCommit: 'a'.repeat(40), attestation: 'attestation.json', baseline: 'baseline.json', stake: {} }),
  'attestation.json': JSON.stringify({ trust: 'production', signature: { keyId: 'k1' }, issuedAt: '2026-11-02T00:00:00Z' }),
  'baseline.json': '{}',
  ...over,
});
const zip = (members) => zipStored(Object.entries(members).map(([name, text]) => ({ name, bytes: Buffer.from(text) })));
const codeReview = (issues = []) => ({
  ATTESTATION_FILE: 'attestation.json',
  BASELINE_FILE: 'baseline.json',
  validateCodeReviewSpec: () => ({ ok: true, issues: [] }),
  validateAttestation: (a, o) => { codeReview.last = { a, o }; return { ok: issues.length === 0, issues, warnings: [] }; },
});

test('signed: the attestation verifies over the archive\'s own files', () => {
  const cr = codeReview();
  const r = readSignedListing(zip(files()), { codeReview: cr });
  assert.equal(r.signed, true);
  assert.equal(r.keyId, 'k1');
  assert.equal(r.trust, 'production');
  assert.equal(r.spec.baseCommit, 'a'.repeat(40));
  assert.equal(codeReview.last.o.trust, undefined, 'production unless the caller gives dev keys and the statement says dev');
  assert.equal(Buffer.from(codeReview.last.o.files.baseline).toString(), '{}');
});

test('not signed: no attestation, or one that does not verify, or an archive that is not one', () => {
  const none = files();
  delete none['attestation.json'];
  assert.deepEqual(readSignedListing(zip(none), { codeReview: codeReview([{ code: 'ATTESTATION_MISSING' }]) }).reason, 'NOT_SIGNED_BY_BUILDER');
  assert.deepEqual(readSignedListing(zip(files()), { codeReview: codeReview([{ code: 'ATTESTATION_BAD_SIGNATURE' }]) }).reason, 'NOT_SIGNED_BY_BUILDER');
  assert.equal(readSignedListing(Buffer.from('not a zip'), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID');
});

test('dev keys count only for a statement that says dev, and only when the caller gives them', () => {
  const dev = files({ 'attestation.json': JSON.stringify({ trust: 'dev', signature: { keyId: 'd1' } }) });
  const keys = [{ publicKey: 'p' }];
  readSignedListing(zip(dev), { codeReview: codeReview(), devKeys: keys });
  assert.deepEqual(codeReview.last.o.trust, { dev: true, keys });
  readSignedListing(zip(files()), { codeReview: codeReview(), devKeys: keys });
  assert.equal(codeReview.last.o.trust, undefined);
  readSignedListing(zip(dev), { codeReview: codeReview() });
  assert.equal(codeReview.last.o.trust, undefined);
});
