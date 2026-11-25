// The wallet sign-in the maker-only routes use (src/auth/walletAuth.js; node P4b2): the server
// issues a one-time challenge naming an action, a resource and the address that must sign it;
// the wallet signs the message as it is (EIP-191 personal_sign); the server rebuilds the message
// from its own copy of the challenge and recovers the signer with ethers. A nonce answers once,
// a challenge expires, and only the address it names gets through.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

import { AUTH_ACTIONS, authMessage, createWalletAuth } from '../src/auth/walletAuth.js';
import { wallet } from './helpers/scan.js';

const ID = '0123456789abcdef0123456789abcdef';
const RESOURCE = `listing:${ID}`;

function clock(start = Date.parse('2026-11-02T10:00:00.250Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

async function signed(auth, signer, { action = 'read-scan', resource = RESOURCE, address = signer.address } = {}) {
  const c = auth.challenge({ action, resource, address });
  return { c, signature: await signer.signMessage(c.message) };
}

describe('the sign-in message', () => {
  test('has the documented format, byte for byte', () => {
    const msg = authMessage({
      action: 'read-scan',
      resource: RESOURCE,
      address: '0x5f2a00000000000000000000000000000000c0de',
      nonce: '9f86d081884c7d659a2feaa0c55ad015',
      issuedAt: '2026-11-02T10:00:00Z',
      expiresAt: '2026-11-02T10:05:00Z',
    });
    assert.equal(msg, [
      'Verdikta stake attestation: sign in',
      'Sign to read the baseline scan of a listing you made. This is not a transaction: it costs nothing and moves no funds.',
      '',
      'Version: 1',
      'Action: read-scan',
      `Resource: listing:${ID}`,
      'Address: 0x5F2A00000000000000000000000000000000c0DE',
      'Nonce: 9f86d081884c7d659a2feaa0c55ad015',
      'Issued At: 2026-11-02T10:00:00Z',
      'Expiration Time: 2026-11-02T10:05:00Z',
    ].join('\n'));
    assert.equal(getAddress('0x5f2a00000000000000000000000000000000c0de'), '0x5F2A00000000000000000000000000000000c0DE');
  });

  test('is ASCII with one field per line: no value can add a line of its own', () => {
    const base = { action: 'read-scan', resource: RESOURCE, address: wallet().address, nonce: '9f86d081884c7d659a2feaa0c55ad015', issuedAt: '2026-11-02T10:00:00Z', expiresAt: '2026-11-02T10:05:00Z' };
    assert.throws(() => authMessage({ ...base, resource: `${RESOURCE}\nAddress: 0x0` }), TypeError);
    assert.throws(() => authMessage({ ...base, resource: 'listing:é' }), TypeError);
    assert.throws(() => authMessage({ ...base, action: 'transfer-funds' }), TypeError);
    assert.throws(() => authMessage({ ...base, address: '0x1234' }), TypeError);
    assert.throws(() => authMessage({ ...base, nonce: 'short' }), TypeError);
  });

  test('every action has a statement', () => {
    assert.ok(Object.keys(AUTH_ACTIONS).includes('read-scan'));
    for (const [k, v] of Object.entries(AUTH_ACTIONS)) assert.match(`${k} ${v}`, /^[a-z-]+ [\x20-\x7e]+$/);
  });
});

describe('createWalletAuth', () => {
  test('a challenge names the action, the resource and the address, with a fresh nonce and an expiry', () => {
    const t = clock();
    const auth = createWalletAuth({ ttlMs: 300000, now: t.now });
    const maker = wallet();
    const a = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address.toLowerCase() });
    const b = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    assert.match(a.nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(a.address, maker.address, 'checksummed');
    assert.equal(a.issuedAt, '2026-11-02T10:00:00Z');
    assert.equal(a.expiresAt, '2026-11-02T10:05:00Z');
    assert.equal(a.message, authMessage(a));
  });

  test('the address the challenge names signs: accepted', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    assert.deepEqual(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }), { ok: true, address: maker.address, issuedAt: c.issuedAt, expiresAt: c.expiresAt });
  });

  test('another wallet signs the same challenge: 403', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const other = wallet();
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await other.signMessage(c.message) });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'WRONG_ADDRESS');
  });

  test('the right wallet signing another message (an edited expiry) is not the address either: 403', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    const edited = c.message.replace(/Expiration Time: .*/, 'Expiration Time: 2099-01-01T00:00:00Z');
    const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await maker.signMessage(edited) });
    assert.equal(r.status, 403);
  });

  test('a nonce answers once: the same signature again is refused (replay)', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).ok, true);
    const again = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature });
    assert.deepEqual([again.ok, again.status, again.code], [false, 401, 'CHALLENGE_UNKNOWN']);
  });

  test('a failed attempt uses the nonce up too', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await wallet().signMessage(c.message) }).status, 403);
    const late = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await maker.signMessage(c.message) });
    assert.deepEqual([late.status, late.code], [401, 'CHALLENGE_UNKNOWN']);
  });

  test('a challenge past its expiry is refused, even with the right signature', async () => {
    const t = clock();
    const auth = createWalletAuth({ ttlMs: 60000, now: t.now });
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    t.advance(60000);
    const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature });
    assert.deepEqual([r.ok, r.status, r.code], [false, 401, 'CHALLENGE_EXPIRED']);
    // and it stays used: no second try once the clock is wound back
    t.advance(-60000);
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).code, 'CHALLENGE_UNKNOWN');
  });

  test('a challenge is good until its expiry instant', async () => {
    const t = clock(Date.parse('2026-11-02T10:00:00.000Z'));
    const auth = createWalletAuth({ ttlMs: 60000, now: t.now });
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    t.advance(60000);
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).ok, true);
  });

  test('a challenge for one resource or action does not open another', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    const r = auth.verify({ action: 'read-scan', resource: `listing:${'f'.repeat(32)}`, address: maker.address, nonce: c.nonce, signature });
    assert.deepEqual([r.status, r.code], [401, 'CHALLENGE_MISMATCH']);
  });

  test('a nonce the server never issued, or a malformed signature, is refused', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const unknown = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: 'a'.repeat(32), signature: await maker.signMessage('x') });
    assert.deepEqual([unknown.status, unknown.code], [401, 'CHALLENGE_UNKNOWN']);
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    const bad = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: `0x${'00'.repeat(65)}` });
    assert.deepEqual([bad.status, bad.code], [401, 'SIGNATURE_INVALID']);
    for (const body of [{}, { nonce: 'xyz', signature: '0x00' }, { nonce: c.nonce, signature: 42 }, { nonce: c.nonce }]) {
      const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, ...body });
      assert.deepEqual([r.status, r.code], [400, 'AUTH_REQUEST_INVALID'], JSON.stringify(body));
    }
  });

  test('an attempt with a malformed signature uses the nonce up as well (R1-F2)', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    for (const malformed of ['0x00', 42, undefined, `0x${'zz'.repeat(65)}`]) {
      const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
      const first = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: malformed });
      assert.deepEqual([first.status, first.code], [400, 'AUTH_REQUEST_INVALID']);
      const then = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await maker.signMessage(c.message) });
      assert.deepEqual([then.ok, then.status, then.code], [false, 401, 'CHALLENGE_UNKNOWN'], String(malformed));
    }
  });

  test('a stranger asking for challenges, as many as they like, never stops the maker\'s sign-in', async () => {
    // a hunter who would keep a maker from pinning a dispute statement in its window asks for that claim's challenge
    // again and again: each is for the maker's address, so only the maker could answer it, and none takes room
    const auth = createWalletAuth();
    const maker = wallet();
    for (let i = 0; i < 20000; i += 1) auth.challenge({ action: 'pin-dispute', resource: 'claim:7', address: maker.address });
    const c = auth.challenge({ action: 'pin-dispute', resource: 'claim:7', address: maker.address });
    const r = auth.verify({ action: 'pin-dispute', resource: 'claim:7', address: maker.address, nonce: c.nonce, signature: await maker.signMessage(c.message) });
    assert.equal(r.ok, true);
  });

  test('a nonce is the server\'s: one with an edited issue time, or from another server\'s key, is unknown', async () => {
    const t = clock();
    const auth = createWalletAuth({ ttlMs: 60000, now: t.now });
    const maker = wallet();
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    // a later issue time would stretch the challenge's life
    const later = `${(Number.parseInt(c.nonce.slice(0, 8), 16) + 3600).toString(16).padStart(8, '0')}${c.nonce.slice(8)}`;
    const forged = { ...c, nonce: later, issuedAt: '2026-11-02T11:00:00Z', expiresAt: '2026-11-02T11:01:00Z' };
    const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: later, signature: await maker.signMessage(authMessage(forged)) });
    assert.deepEqual([r.status, r.code], [401, 'CHALLENGE_UNKNOWN']);
    const other = createWalletAuth({ ttlMs: 60000, now: t.now });
    const o = other.challenge({ action: 'read-scan', resource: RESOURCE, address: maker.address });
    const r2 = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: o.nonce, signature: await maker.signMessage(o.message) });
    assert.deepEqual([r2.status, r2.code], [401, 'CHALLENGE_UNKNOWN']);
  });

  test('a challenge for another address does not open this one\'s', async () => {
    const auth = createWalletAuth();
    const maker = wallet();
    const stranger = wallet();
    const c = auth.challenge({ action: 'read-scan', resource: RESOURCE, address: stranger.address });
    const r = auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature: await stranger.signMessage(c.message) });
    assert.deepEqual([r.status, r.code], [401, 'CHALLENGE_MISMATCH']);
  });

  test('an answered nonce stays refused: used until its expiry, expired after', async () => {
    const t = clock();
    const auth = createWalletAuth({ ttlMs: 60000, maxUsed: 3, now: t.now });
    const maker = wallet();
    const { c, signature } = await signed(auth, maker);
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).ok, true);
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).code, 'CHALLENGE_UNKNOWN');
    t.advance(60001);
    // expired: still refused, now by its expiry
    assert.equal(auth.verify({ action: 'read-scan', resource: RESOURCE, address: maker.address, nonce: c.nonce, signature }).code, 'CHALLENGE_EXPIRED');
  });

  test('a challenge for an unknown action, a bad resource or a non-address is refused', () => {
    const auth = createWalletAuth();
    const address = wallet().address;
    assert.throws(() => auth.challenge({ action: 'withdraw', resource: RESOURCE, address }), TypeError);
    assert.throws(() => auth.challenge({ action: 'read-scan', resource: 'listing 1', address }), TypeError);
    assert.throws(() => auth.challenge({ action: 'read-scan', resource: RESOURCE, address: '0x0000000000000000000000000000000000000000' }), TypeError);
  });
});
