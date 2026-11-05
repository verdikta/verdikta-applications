#!/usr/bin/env node
// The owner's opt-in check at G1 (docs/builder-kms-signing.md), and the only code in this repository that
// reaches a real KMS: it signs a throwaway message with the real key, under whatever AWS identity the shell
// holds, and verifies the answer here against the pinned public key, with a path that shares nothing with
// AWS. Neither `npm test` nor CI runs it, and it refuses to start without VERDIKTA_KMS_LIVE_CHECK=1.
//
//   VERDIKTA_KMS_LIVE_CHECK=1 VERDIKTA_KMS_KEY_ARN=<key arn> node action/kms-live-check.js
//
// Exit 0 when the signature verifies, 1 when it doesn't or AWS refused, 2 without the opt-in. Its message has
// a context of its own, so its signature can never pass for an attestation's. It prints no ARN.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../src/common.js';
import { productionKeyProblem } from '../src/signing.js';
import { SignerRefusal, signWithKms } from './kms-sign.js';
import { ACTION_PINS } from './services.js';

const CONTEXT = 'verdikta-kms-live-check/v1';

function verifyKeyOf(publicKey) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }, format: 'jwk' });
}

/**
 * @param {object} o
 * @param {string} o.keyArn
 * @param {{ publicKey: string, keyId: string }} [o.pin]
 * @param {object[]} [o.trusted] - common's production set
 * @param {(line: string) => void} [o.out]
 * @returns {Promise<boolean>} whether the key signed and the signature verifies under the pin
 */
export async function liveCheck({ keyArn, pin = ACTION_PINS.builderKey, trusted = codeReview.PRODUCTION_BUILDER_KEYS, out = (l) => process.stdout.write(`${l}\n`) }) {
  const message = Buffer.from(`${CONTEXT}\n${crypto.randomBytes(16).toString('hex')}`, 'utf8');
  let signature;
  try {
    signature = Buffer.from(await signWithKms({ message, keyArn, credentials: () => ({ ...process.env }) }), 'base64');
  } catch (err) {
    if (!(err instanceof SignerRefusal)) throw err;
    out(`FAILED: ${err.message}`);
    return false;
  }
  const key = verifyKeyOf(pin.publicKey);
  if (!crypto.verify(null, message, key, signature)) {
    out(`FAILED: the signature does not verify under the pinned public key ${pin.publicKey}: this KMS key is not the builder key`);
    return false;
  }
  if (crypto.verify(null, Buffer.concat([message, Buffer.from('x')]), key, signature)) {
    out('FAILED: the signature also verifies over a changed message');
    return false;
  }
  out(`OK: the KMS key signed with plain Ed25519, and the signature verifies under the pinned public key, key id ${pin.keyId}`);
  const problem = productionKeyProblem(pin, trusted);
  out(problem ? `NOTE: production signing stays refused for now: ${problem}` : 'OK: this checkout\'s @verdikta/common trusts the key');
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.env.VERDIKTA_KMS_LIVE_CHECK !== '1') {
    process.stderr.write('kms-live-check calls the real KMS, so it only runs with VERDIKTA_KMS_LIVE_CHECK=1 (and VERDIKTA_KMS_KEY_ARN, under an AWS identity allowed kms:Sign)\n');
    process.exitCode = 2;
  } else {
    process.exitCode = (await liveCheck({ keyArn: process.env.VERDIKTA_KMS_KEY_ARN })) ? 0 : 1;
  }
}
