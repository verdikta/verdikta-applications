// Decrypt-and-check (src/lib/check.js) with common's real encryption: the steps and verdicts
// the check page shows, and when it offers flagBadDisclosure (the contract's rule: the listing's
// maker, before disclosedAt + disclosureGrace, once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import disclosure from '@verdikta/common/src/codeReview/disclosure.js';

import { checkDisclosure, flagOffer } from '../src/lib/check.js';
import { disclosureKeyBytes32 } from '../src/lib/disclosure.js';

const maker = disclosure.generateDisclosureKeyPair();
const listingKey = disclosureKeyBytes32(maker.recipient);
const archive = new TextEncoder().encode('PK\u0003\u0004 a claim archive');

function claimFor({ plaintext = archive, committed = archive, recipient = maker.recipient } = {}) {
  const ciphertext = disclosure.encryptForDisclosure(plaintext, recipient, disclosure.generateDisclosureSecrets());
  return {
    ciphertext,
    claim: { archiveHash: disclosure.disclosureSha256(committed), ciphertextSha256: disclosure.disclosureSha256(ciphertext), ciphertextCid: 'bafkreiexample' },
  };
}

const run = (claim, fetched, identity = maker.identity) => checkDisclosure({
  identity,
  listingKey,
  claim,
  fetchCiphertext: async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched;
  },
});

test('a matching copy passes every step and hands back the plaintext', async () => {
  const { claim, ciphertext } = claimFor();
  const r = await run(claim, ciphertext);
  assert.equal(r.verdict, 'match');
  assert.deepEqual(r.steps, { key: 'passed', fetch: 'passed', ciphertext: 'passed', decrypt: 'passed', plaintext: 'passed' });
  assert.deepEqual([...r.plaintext], [...archive]);
});

test('fetched bytes that are not the committed ciphertext stop the check there', async () => {
  const { claim } = claimFor();
  const r = await run(claim, new TextEncoder().encode('something else'));
  assert.equal(r.verdict, 'bad');
  assert.equal(r.reason.key, 'ciphertext');
  assert.equal(r.reason.vars.expected, claim.ciphertextSha256);
  assert.deepEqual(r.steps, { key: 'passed', fetch: 'passed', ciphertext: 'failed', decrypt: 'skipped', plaintext: 'skipped' });
  assert.equal(r.plaintext, null);
});

test('a ciphertext sealed to another key does not decrypt with the listing\'s', async () => {
  const other = disclosure.generateDisclosureKeyPair();
  const { claim, ciphertext } = claimFor({ recipient: other.recipient });
  const r = await run(claim, ciphertext);
  assert.equal(r.verdict, 'bad');
  assert.equal(r.reason.key, 'decrypt');
  assert.equal(r.reason.vars.code, 'NO_MATCHING_IDENTITY');
  assert.deepEqual(r.steps, { key: 'passed', fetch: 'passed', ciphertext: 'passed', decrypt: 'failed', plaintext: 'skipped' });
});

test('a decrypted archive that is not the committed one fails the last step', async () => {
  const { claim, ciphertext } = claimFor({ committed: new TextEncoder().encode('the committed archive') });
  const r = await run(claim, ciphertext);
  assert.equal(r.verdict, 'bad');
  assert.equal(r.reason.key, 'plaintext');
  assert.equal(r.reason.vars.actual, disclosure.disclosureSha256(archive));
  assert.deepEqual(r.steps, { key: 'passed', fetch: 'passed', ciphertext: 'passed', decrypt: 'passed', plaintext: 'failed' });
  assert.equal(r.plaintext, null);
});

test('the maker\'s own key problems are told apart from a bad disclosure, and nothing is fetched', async () => {
  const { claim, ciphertext } = claimFor();
  let fetched = 0;
  const counting = (identity) => checkDisclosure({ identity, listingKey, claim, fetchCiphertext: async () => { fetched += 1; return ciphertext; } });
  const wrong = await counting(disclosure.generateDisclosureKeyPair().identity);
  assert.equal(wrong.verdict, 'wrongKey');
  assert.deepEqual(wrong.steps, { key: 'failed', fetch: 'skipped', ciphertext: 'skipped', decrypt: 'skipped', plaintext: 'skipped' });
  const garbage = await counting('AGE-SECRET-KEY-1NOTAKEY');
  assert.equal(garbage.verdict, 'badIdentity');
  assert.equal(fetched, 0);
  // surrounding whitespace from a paste is not a different key
  assert.equal((await counting(`  ${maker.identity}\n`)).verdict, 'match');
});

test('a ciphertext the gateway cannot deliver is unavailable', async () => {
  const { claim } = claimFor();
  const err = Object.assign(new Error('gone'), { reason: { key: 'http', vars: { status: 404 } } });
  const r = await run(claim, err);
  assert.equal(r.verdict, 'unavailable');
  assert.deepEqual(r.reason, { key: 'http', vars: { status: 404 } });
  assert.deepEqual(r.steps, { key: 'passed', fetch: 'failed', ciphertext: 'skipped', decrypt: 'skipped', plaintext: 'skipped' });
});

test('the flag is offered for a bad or unavailable copy, before the grace ends, once', () => {
  const base = { disclosedAt: 1000n, disclosureGrace: 48n * 3600n, now: 2000n, flagged: false };
  const end = 1000 + 48 * 3600;
  assert.deepEqual(flagOffer({ ...base, verdict: 'bad' }), { offer: true, why: null, graceEnd: end });
  assert.equal(flagOffer({ ...base, verdict: 'unavailable' }).offer, true);
  for (const verdict of ['match', 'wrongKey', 'badIdentity']) assert.deepEqual(flagOffer({ ...base, verdict }), { offer: false, why: 'notBad', graceEnd: end });
  assert.deepEqual(flagOffer({ ...base, verdict: 'bad', flagged: true }), { offer: false, why: 'alreadyFlagged', graceEnd: end });
  // the contract requires block.timestamp < disclosedAt + disclosureGrace
  assert.equal(flagOffer({ ...base, verdict: 'bad', now: BigInt(end - 1) }).offer, true);
  assert.deepEqual(flagOffer({ ...base, verdict: 'bad', now: BigInt(end) }), { offer: false, why: 'graceOver', graceEnd: end });
  assert.equal(flagOffer({ ...base, verdict: 'bad', disclosureGrace: 0n, now: 1000n }).why, 'graceOver');
});
