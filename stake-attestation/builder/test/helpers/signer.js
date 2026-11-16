#!/usr/bin/env node
// A stand-in for an external signer (a KMS command line, say): reads the bytes to sign on stdin
// and prints the Ed25519 signature, base64, on stdout. The key comes from its own environment
// (TEST_SIGNER_KEY, PKCS#8 PEM); the builder never sees it. Test use only.
import crypto from 'node:crypto';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const pem = process.env.TEST_SIGNER_KEY;
  if (!pem) {
    process.stderr.write('no key\n');
    process.exit(3);
  }
  const sig = crypto.sign(null, Buffer.concat(chunks), crypto.createPrivateKey(pem));
  process.stdout.write(`${sig.toString('base64')}\n`);
});
