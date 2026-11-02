// The maker's dispute statement (erratum E2): at most 4,096 bytes of UTF-8 text, pinned, its CID
// on-chain. The page checks the text before it asks for a signature, and checks the CID the
// server answers against the bytes it sent when the CID is the raw sha2-256 form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { rawCid as serverRawCid } from '../../server/src/pinning/cid.js';
import { MAX_STATEMENT_BYTES, checkStatement, cidMatches, rawCid, statementSha256 } from '../src/lib/statement.js';

const require = createRequire(import.meta.url);
const { codeReview } = require('@verdikta/common');

test('the limit is common\'s MAX_DISPUTE_STATEMENT_BYTES', () => {
  assert.equal(MAX_STATEMENT_BYTES, codeReview.MAX_DISPUTE_STATEMENT_BYTES);
});

test('a statement is UTF-8 bytes, counted as bytes', () => {
  const r = checkStatement('The PoC reads a storage slot the fix window already changed. Café.');
  assert.equal(r.ok, true);
  assert.equal(r.bytes.length, Buffer.byteLength('The PoC reads a storage slot the fix window already changed. Café.', 'utf8'));
  assert.equal(checkStatement('é'.repeat(2048)).ok, true);
  const over = checkStatement('é'.repeat(2049));
  assert.equal(over.ok, false);
  assert.equal(over.error, 'tooLong');
  assert.equal(over.length, 4098);
  assert.equal(checkStatement('a'.repeat(4096)).ok, true);
  assert.equal(checkStatement('a'.repeat(4097)).error, 'tooLong');
});

test('an empty or blank statement, and one with a lone surrogate, are refused', () => {
  assert.equal(checkStatement('').error, 'empty');
  assert.equal(checkStatement(' \n\t ').error, 'empty');
  assert.equal(checkStatement('half a pair: \uD83D').error, 'malformed');
  assert.equal(checkStatement('\uDE00 alone').error, 'malformed');
  assert.equal(checkStatement('a whole pair: 😀').ok, true);
});

test('statementSha256 is the hex SHA-256 of the bytes', () => {
  const { bytes } = checkStatement('statement');
  assert.match(statementSha256(bytes), /^0x[0-9a-f]{64}$/);
  assert.equal(statementSha256(bytes).slice(2), require('node:crypto').createHash('sha256').update(Buffer.from('statement')).digest('hex'));
});

test('rawCid is the server\'s (CIDv1, raw, sha2-256, base32)', () => {
  for (const s of ['statement', 'é'.repeat(100), 'x'.repeat(4096)]) {
    const { bytes } = checkStatement(s);
    assert.equal(rawCid(bytes), serverRawCid(Buffer.from(bytes)));
  }
});

test('cidMatches: a raw CID must be the bytes\'; another form cannot be checked here and is taken as given', () => {
  const { bytes } = checkStatement('statement');
  assert.equal(cidMatches(rawCid(bytes), bytes), true);
  assert.equal(cidMatches(rawCid(checkStatement('other').bytes), bytes), false);
  assert.equal(cidMatches('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', bytes), true);
  assert.equal(cidMatches('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', bytes), true);
  assert.equal(cidMatches('not a cid', bytes), false);
  assert.equal(cidMatches('', bytes), false);
});
