// Node P9: "did the builder sign this listing", as the site's feed and the hunter tool (P5) ask it,
// from the listing archive's bytes alone: the attestation over the files it binds, under the trust
// the caller gives. Common's validator is passed in (this package has no dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { didBuilderSign, readSignedListing } from '../src/builderSignature.js';
import { zipStored } from '../src/zip.js';

const files = (over = {}, panel = 'standard') => ({
  'manifest.json': JSON.stringify({ version: '1.0', codeReview: 'code_review.json', primary: { filename: 'primary_query.json' }, juryParameters: { panel } }),
  'primary_query.json': JSON.stringify({ query: 'the query', outcomes: ['six'] }),
  'code_review.json': JSON.stringify({ repo: 'https://github.com/acme/vault', baseCommit: 'a'.repeat(40), attestation: 'attestation.json', baseline: 'baseline.json', stake: {} }),
  'attestation.json': JSON.stringify({ trust: 'production', signature: { keyId: 'k1' }, issuedAt: '2026-11-02T00:00:00Z', sha256: { codeReview: 'spec-hash' } }),
  'baseline.json': '{}',
  ...over,
});
const zip = (members) => zipStored(Object.entries(members).map(([name, text]) => ({ name, bytes: Buffer.from(text) })));
const yes = () => ({ ok: true, issues: [] });
const codeReview = (issues = []) => ({
  ATTESTATION_FILE: 'attestation.json',
  BASELINE_FILE: 'baseline.json',
  validateCodeReviewSpec: yes,
  CODE_STANDARD_PANEL: { panel: 'standard' },
  CODE_STANDARD_DISPUTE_PANEL: { panel: 'dispute' },
  validateClassEnvelope: (panel, name) => ({ ok: ['standard', 'dispute', 'smaller'].includes(panel?.panel) && name === 'code-standard', issues: [] }),
  validateBugOutcomes: (o) => ({ ok: Array.isArray(o) && o[0] === 'six', issues: [] }),
  buildClaimQuery: () => 'the query',
  validateBaseline: yes,
  validateKnownIssues: yes,
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

test('did the builder sign this listing: both archives, the listing the chain holds', () => {
  const spec = { repo: 'https://github.com/acme/vault', baseCommit: 'a'.repeat(40), attestation: 'attestation.json', baseline: 'baseline.json', stake: { disclosureKey: 'age1key' } };
  const listingBytes = zip(files({ 'code_review.json': JSON.stringify(spec) }));
  const disputeBytes = zip(files({ 'code_review.json': JSON.stringify(spec) }, 'dispute'));
  const cr = { ...codeReview(), parseDisclosureKey: () => new Uint8Array(32).fill(7) };
  const key = `0x${'07'.repeat(32)}`;
  const listing = { repo: spec.repo, baseCommit: spec.baseCommit, disclosureKey: key };
  const ask = (over) => didBuilderSign({ listingBytes, disputeBytes, codeReview: cr, listing, ...over });
  assert.equal(ask().signed, true);
  assert.equal(ask({ listing: { ...listing, disclosureKey: `0x${'08'.repeat(32)}` } }).reason, 'ARCHIVE_MISMATCH');
  assert.equal(ask({ listing: { ...listing, baseCommit: 'b'.repeat(40) } }).reason, 'ARCHIVE_MISMATCH');
  assert.equal(ask({ codeReview: { ...cr, validateAttestation: () => ({ ok: false, issues: [{ code: 'X' }], warnings: [] }) } }).reason, 'NOT_SIGNED_BY_BUILDER');
  assert.equal(ask({ listingBytes: Buffer.from('nope') }).reason, 'ARCHIVE_INVALID');
  // the archives must be what they are on-chain, of one signed spec
  assert.equal(ask({ disputeBytes: listingBytes }).reason, 'ARCHIVE_MISMATCH');
  assert.equal(ask({ listingBytes: disputeBytes }).reason, 'ARCHIVE_MISMATCH');
  const other = zip(files({ 'code_review.json': JSON.stringify(spec), 'attestation.json': JSON.stringify({ trust: 'production', signature: { keyId: 'k1' }, sha256: { codeReview: 'another-hash' } }) }, 'dispute'));
  assert.equal(ask({ disputeBytes: other }).reason, 'ARCHIVE_MISMATCH');
});

test('signed files repackaged around another panel, query or outcomes, or no primary file, are not a listing arbiters would judge', () => {
  const manifest = (over) => JSON.stringify({ version: '1.0', codeReview: 'code_review.json', primary: { filename: 'primary_query.json' }, juryParameters: { panel: 'standard' }, ...over });
  const cases = [
    { 'manifest.json': JSON.stringify({ codeReview: 'code_review.json' }) },
    { 'manifest.json': manifest({ juryParameters: { panel: 'one cheap model' } }) },
    { 'manifest.json': manifest({ juryParameters: { panel: 'smaller' } }) },
    { 'manifest.json': manifest({ primary: { filename: 'missing.json' } }) },
    { 'primary_query.json': JSON.stringify({ query: 'another query', outcomes: ['six'] }) },
    { 'primary_query.json': JSON.stringify({ query: 'the query', outcomes: ['two'] }) },
  ];
  for (const over of cases) assert.equal(readSignedListing(zip(files(over)), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID', JSON.stringify(over));
  assert.equal(readSignedListing(zip(files()), { codeReview: codeReview() }).signed, true);
});
