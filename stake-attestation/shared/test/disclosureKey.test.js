// Node P35: a listing's disclosure key is one X25519 public key in two encodings, the age recipient (age1…) a listing
// archive and stock age write, and the bytes32 StakeAttestation stores (getListing, the feed's disclosureKey). The site
// and the hunter tool show both, side by side, with one sentence that says they are one key. The conversion is
// bech32 with the HRP "age" over the key's 32 bytes; here it is held to a pair stock age-keygen made (the contracts'
// disclosure vectors), both ways, and to every way a recipient can be broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { wordingProblems } from '../src/index.js';
import { DISCLOSURE_KEY_NOTE, disclosureBytes32Of, disclosureRecipientOf } from '../src/disclosureKey.js';

// TEST-ONLY KEYS, written by stock age v1.3.2 (onchain/test/scripts/generate-disclosure-vectors.js): protect nothing
const VECTORS = JSON.parse(fs.readFileSync(new URL('../../onchain/test/fixtures/disclosure-vectors.v1.json', import.meta.url), 'utf8'));
const KNOWN = { recipient: VECTORS.maker.recipient, bytes32: `0x${Buffer.from(VECTORS.maker.publicKeyBase64, 'base64').toString('hex')}` };
const random32 = () => `0x${crypto.randomBytes(32).toString('hex')}`;

test('the pair stock age made: its recipient is its 32 bytes, both ways', () => {
  assert.match(KNOWN.recipient, /^age1[ac-hj-np-z02-9]{58}$/);
  assert.match(KNOWN.bytes32, /^0x[0-9a-f]{64}$/);
  assert.equal(disclosureRecipientOf(KNOWN.bytes32), KNOWN.recipient);
  assert.equal(disclosureBytes32Of(KNOWN.recipient), KNOWN.bytes32);
  // the contract's bytes32 comes back from the chain in any case; the recipient is lowercase, as age writes it
  assert.equal(disclosureRecipientOf(KNOWN.bytes32.toUpperCase().replace(/^0X/, '0x')), KNOWN.recipient);
});

test('a round trip is exact: every recipient stock age wrote, and random keys, come back as they were', () => {
  for (const r of [VECTORS.maker.recipient, VECTORS.other.recipient]) assert.equal(disclosureRecipientOf(disclosureBytes32Of(r)), r);
  for (let i = 0; i < 200; i += 1) {
    const hex = random32();
    const recipient = disclosureRecipientOf(hex);
    assert.match(recipient, /^age1[ac-hj-np-z02-9]{58}$/);
    assert.equal(disclosureBytes32Of(recipient), hex);
  }
  for (const hex of [`0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`]) assert.equal(disclosureBytes32Of(disclosureRecipientOf(hex)), hex);
});

test('a recipient that is not an age X25519 recipient is refused, whatever is wrong with it', () => {
  const r = KNOWN.recipient;
  const swap = (s, i) => `${s.slice(0, i)}${s[i] === 'q' ? 'p' : 'q'}${s.slice(i + 1)}`;
  const bad = [
    swap(r, 10), // one character: the checksum fails
    swap(r, r.length - 1), // in the checksum itself
    r.toUpperCase(), // age writes recipients lowercase
    `${r.slice(0, 10)}${r[10].toUpperCase()}${r.slice(11)}`, // mixed case
    r.slice(0, -1), // short
    `${r}q`, // long
    `agf1${r.slice(4)}`, // another HRP
    r.replace(/^age1/, 'age'), // no separator
    `${r.slice(0, 12)}b${r.slice(13)}`, // b is not a bech32 character
    '', ' ', `${r} `,
  ];
  for (const x of bad) assert.throws(() => disclosureBytes32Of(x), { name: 'TypeError' }, JSON.stringify(x));
  for (const x of [null, undefined, 1, {}, [r]]) assert.throws(() => disclosureBytes32Of(x), { name: 'TypeError' });
});

test('a bytes32 that is not 32 bytes of hex is refused', () => {
  for (const x of ['', '0x', KNOWN.bytes32.slice(0, -2), `${KNOWN.bytes32}00`, KNOWN.bytes32.slice(2), `0x${'g'.repeat(64)}`, ` ${KNOWN.bytes32}`, null, undefined, 32, {}]) {
    assert.throws(() => disclosureRecipientOf(x), { name: 'TypeError' }, JSON.stringify(x));
  }
});

test('the sentence beside the two forms says they are one key; it passes the wording check', () => {
  assert.match(DISCLOSURE_KEY_NOTE, /one key/i);
  assert.match(DISCLOSURE_KEY_NOTE, /age recipient \(age1…\)/);
  assert.match(DISCLOSURE_KEY_NOTE, /bytes32/);
  assert.deepEqual(wordingProblems(DISCLOSURE_KEY_NOTE), []);
});

test('the package exports it, and the module holds nothing of node: the client bundles it', async () => {
  const exported = await import('@verdikta/stake-attestation-shared/disclosure-key');
  assert.equal(exported.disclosureRecipientOf, disclosureRecipientOf);
  assert.equal(exported.disclosureBytes32Of, disclosureBytes32Of);
  assert.equal(exported.DISCLOSURE_KEY_NOTE, DISCLOSURE_KEY_NOTE);
  const all = await import('../src/index.js');
  assert.equal(all.disclosureRecipientOf, disclosureRecipientOf);
  const source = fs.readFileSync(new URL('../src/disclosureKey.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b|\brequire\(|\bBuffer\b|\bprocess\./);
});
