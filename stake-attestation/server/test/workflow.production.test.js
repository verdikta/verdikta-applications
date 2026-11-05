// Trust at the end (node P15, acceptance 1): the archive a run leaves is verified under common's production
// set before it is offered. Past that check only under a stubbed set, in a process of its own, because no test
// holds the private half of the Verdikta key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../src/common.js';

const STUB = fileURLToPath(new URL('./helpers/trustStub.cjs', import.meta.url));
const RUN = fileURLToPath(new URL('./fixtures/workflow-production-run.js', import.meta.url));
const PINS = JSON.parse(fs.readFileSync(new URL('../../builder/action/pins.json', import.meta.url), 'utf8'));

function run(reviewers) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const out = execFileSync(process.execPath, ['--require', STUB, RUN], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STUB_TRUSTED_KEY: JSON.stringify({ keyId: codeReview.builderKeyId(raw), publicKey: raw }),
      TEST_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      TEST_REVIEWERS: reviewers,
    },
  });
  return JSON.parse(out.trim().split('\n').at(-1));
}

for (const reviewers of ['on', 'off']) {
  test(`reviewers ${reviewers}: the same flow ends with both CIDs and list()'s arguments, under production trust`, () => {
    const r = run(reviewers);
    assert.equal(r.view.status, 'ready', JSON.stringify(r.view.error));
    assert.equal(r.view.trust, 'production');
    assert.equal(r.view.devTrust, null);
    assert.ok(r.view.archives.listing.cid && r.view.archives.dispute.cid);
    assert.ok(r.view.list.params);
    assert.match(r.view.run.url, /\/actions\/runs\/[0-9]+$/);
    assert.equal(r.dispatches, 1);
    if (reviewers === 'on') assert.ok(r.seen.includes('awaiting_approval'), `a visible job state: ${r.seen.join(', ')}`);
    else assert.ok(!r.seen.includes('awaiting_approval'), `no person in the loop: ${r.seen.join(', ')}`);
  });
}

test('common at this pin holds the key production signs with, so SIGNING_KEY_NOT_TRUSTED is behind us', () => {
  const entry = codeReview.PRODUCTION_BUILDER_KEYS.find((k) => k.keyId === PINS.builderKey.keyId);
  assert.ok(entry, `@verdikta/common's set holds ${PINS.builderKey.keyId}`);
  assert.equal(entry.publicKey, PINS.builderKey.publicKey);
});
