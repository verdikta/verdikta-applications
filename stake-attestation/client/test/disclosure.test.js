// The disclosure key helpers (src/lib/disclosure.js): the pair is common's, from the browser-safe
// entry '@verdikta/common/src/codeReview/disclosure.js'; the key file is age-keygen's format, so
// stock `age -d -i` reads it; the bytes32 list() stores is what common's parseDisclosureKey decodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import common from '@verdikta/common';

import {
  disclosureKeyBytes32,
  disclosureRecipient,
  generateDisclosureKeyPair,
  identityFromKeyFile,
  keyFileName,
  keyFileText,
} from '../src/lib/disclosure.js';

test('a generated pair is an age X25519 pair whose recipient common accepts as a disclosure key', () => {
  const { identity, recipient } = generateDisclosureKeyPair();
  assert.match(recipient, /^age1[ac-hj-np-z02-9]{58}$/);
  assert.match(identity, /^AGE-SECRET-KEY-1[ACDEFGHJKLMNPQRSTUVWXYZ023456789]{58}$/);
  assert.equal(disclosureRecipient(identity), recipient);
  assert.equal(common.codeReview.parseDisclosureKey(recipient).length, 32);
  assert.notEqual(generateDisclosureKeyPair().identity, identity);
});

test('the key file is age-keygen\'s format, and reading it back gives the identity', () => {
  const pair = generateDisclosureKeyPair();
  const text = keyFileText({ ...pair, createdAt: new Date('2026-11-02T10:20:30.456Z') });
  assert.equal(text, `# created: 2026-11-02T10:20:30Z\n# public key: ${pair.recipient}\n${pair.identity}\n`);
  assert.equal(identityFromKeyFile(text), pair.identity);
  assert.equal(identityFromKeyFile(`\r\n  ${pair.identity}  \r\n`), pair.identity);
  assert.equal(identityFromKeyFile('# public key: age1...\n'), null);
  assert.equal(identityFromKeyFile(''), null);
  assert.equal(keyFileName(pair.recipient), `verdikta-disclosure-key-${pair.recipient.slice(4, 12)}.txt`);
});

test('the bytes32 list() stores is the X25519 key common decodes from the recipient', () => {
  const { recipient } = generateDisclosureKeyPair();
  assert.equal(disclosureKeyBytes32(recipient), `0x${Buffer.from(common.codeReview.parseDisclosureKey(recipient)).toString('hex')}`);
  assert.throws(() => disclosureKeyBytes32('age1notakey'), /disclosure key/);
});
