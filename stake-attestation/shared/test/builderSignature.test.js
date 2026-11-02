// Node P9: "did the builder sign this listing", as the site's feed and the hunter tool (P5) ask it,
// from the listing archive's bytes alone: the attestation over the files it binds, under the trust
// the caller gives. Common's validator is passed in (this package has no dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { didBuilderSign, readSignedListing } from '../src/builderSignature.js';
import { zipStored } from '../src/zip.js';

const pretty = (v) => `${JSON.stringify(v, null, 2)}\n`;
const DEFAULT_SPEC = { repo: 'https://github.com/acme/vault', baseCommit: 'a'.repeat(40), attestation: 'attestation.json', baseline: 'baseline.json', stake: {} };
const files = (over = {}, panel = 'standard') => ({
  'manifest.json': pretty({ version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { panel }, codeReview: 'code_review.json' }),
  'primary_query.json': pretty({ query: 'the query', outcomes: ['six'], references: [] }),
  'code_review.json': pretty(DEFAULT_SPEC),
  'attestation.json': pretty({ trust: 'production', signature: { keyId: 'k1' }, issuedAt: '2026-11-02T00:00:00Z', sha256: { codeReview: 'spec-hash', baseline: 'baseline-hash', knownIssues: null } }),
  'baseline.json': '{}',
  ...over,
});
const ORDER = ['manifest.json', 'primary_query.json', 'code_review.json', 'attestation.json', 'baseline.json'];
const zip = (members) => zipStored([...ORDER, ...Object.keys(members).filter((n) => !ORDER.includes(n))].filter((n) => members[n] !== undefined).map((name) => ({ name, bytes: Buffer.from(members[name]) })));
const yes = () => ({ ok: true, issues: [] });
const codeReview = (issues = []) => ({
  ATTESTATION_FILE: 'attestation.json',
  BASELINE_FILE: 'baseline.json',
  validateCodeReviewSpec: yes,
  CODE_STANDARD_PANEL: { panel: 'standard' },
  CODE_STANDARD_DISPUTE_PANEL: { panel: 'dispute' },
  BUG_OUTCOMES: ['six'],
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
  assert.deepEqual(readSignedListing(zip(none), { codeReview: codeReview() }).reason, 'NOT_SIGNED_BY_BUILDER');
  assert.deepEqual(readSignedListing(zip(files()), { codeReview: codeReview([{ code: 'ATTESTATION_BAD_SIGNATURE' }]) }).reason, 'NOT_SIGNED_BY_BUILDER');
  assert.equal(readSignedListing(Buffer.from('not a zip'), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID');
});

test('dev keys count only for a statement that says dev, and only when the caller gives them', () => {
  const dev = files({ 'attestation.json': pretty({ trust: 'dev', signature: { keyId: 'd1' }, sha256: {} }) });
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
  const listingBytes = zip(files({ 'code_review.json': pretty(spec) }));
  const disputeBytes = zip(files({ 'code_review.json': pretty(spec) }, 'dispute'));
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
  // one spec with other known issues or another baseline is other signed files
  for (const sha256 of [{ codeReview: 'another-hash', baseline: 'baseline-hash', knownIssues: null }, { codeReview: 'spec-hash', baseline: 'another-hash', knownIssues: null }, { codeReview: 'spec-hash', baseline: 'baseline-hash', knownIssues: 'other-issues' }]) {
    const other = zip(files({ 'code_review.json': pretty(spec), 'attestation.json': pretty({ trust: 'production', signature: { keyId: 'k1' }, sha256 }) }, 'dispute'));
    assert.equal(ask({ disputeBytes: other }).reason, 'ARCHIVE_MISMATCH', JSON.stringify(sha256));
  }
});

test('signed files repackaged in any way are not what the flow issued: anything else than its bytes', () => {
  const manifest = (over) => pretty({ version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { panel: 'standard' }, codeReview: 'code_review.json', ...over });
  const primary = (over) => pretty({ query: 'the query', outcomes: ['six'], references: [], ...over });
  const cases = [
    { 'manifest.json': JSON.stringify({ codeReview: 'code_review.json' }) },
    { 'manifest.json': manifest({ juryParameters: { panel: 'one cheap model' } }) },
    { 'manifest.json': manifest({ primary: { filename: 'missing.json' } }) },
    { 'manifest.json': manifest({ additional: [{ name: 'x' }] }) },
    { 'manifest.json': `\ufeff${manifest()}` },
    { 'manifest.json': JSON.stringify(JSON.parse(manifest())) },
    { 'primary_query.json': primary({ query: 'another query' }) },
    { 'primary_query.json': primary({ outcomes: ['two'] }) },
    { 'primary_query.json': primary({ references: 'a string' }) },
    { 'primary_query.json': primary({ references: ['https://example.invalid'] }) },
    { 'primary_query.json': `\ufeff${primary()}` },
    { 'extra.txt': 'a member the flow never writes' },
  ];
  for (const over of cases) assert.equal(readSignedListing(zip(files(over)), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID', JSON.stringify(over));
  assert.equal(readSignedListing(zip(files()), { codeReview: codeReview() }).signed, true);
  // the same members in another order are other bytes too
  const m = files();
  assert.equal(readSignedListing(zipStored(Object.keys(m).reverse().map((name) => ({ name, bytes: Buffer.from(m[name]) }))), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID');
});

test('a byte order mark on the attestation or a member the arbiters parse is no statement', () => {
  const bom = files({ 'attestation.json': `\ufeff${files()['attestation.json']}` });
  assert.equal(readSignedListing(zip(bom), { codeReview: codeReview() }).reason, 'ARCHIVE_INVALID');
});
