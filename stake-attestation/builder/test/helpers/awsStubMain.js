#!/usr/bin/env node
// A stand-in for the `aws` command line, the only one any test reaches: no test or CI job calls AWS.
// It reads what `aws kms sign` would read, records what it was given in <stub>/calls.jsonl, and answers
// as <stub>/config.json says: signing with a key made for the test, or the wrong answers a real KMS, a
// wrong call or a bad signer could give.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [stub, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(stub, 'config.json'), 'utf8'));
const value = (flag) => argv[argv.indexOf(flag) + 1];
const messageFile = String(value('--message')).replace(/^fileb:\/\//, '');
const message = fs.readFileSync(messageFile);
const tokenFile = process.env.AWS_WEB_IDENTITY_TOKEN_FILE ?? null;
fs.appendFileSync(path.join(stub, 'calls.jsonl'), `${JSON.stringify({
  argv,
  env: process.env,
  message: message.toString('hex'),
  messageFile,
  token: tokenFile ? fs.readFileSync(tokenFile, 'utf8') : null,
  tokenMode: tokenFile ? fs.statSync(tokenFile).mode & 0o777 : null,
})}\n`);

const key = crypto.createPrivateKey(config.privateKey);
const sign = (bytes) => crypto.sign(null, bytes, key).toString('base64');
switch (config.mode ?? 'ok') {
  case 'ok':
    process.stdout.write(`${sign(message)}\n`);
    break;
  case 'trailing-newline-signed': // text-mode handling of the message
    process.stdout.write(`${sign(Buffer.concat([message, Buffer.from('\n')]))}\n`);
    break;
  case 'prehash': // ED25519_PH_SHA_512, or a digest sent as the message
    process.stdout.write(`${sign(crypto.createHash('sha512').update(message).digest())}\n`);
    break;
  case 'other-key': // a KMS key that is not the pinned one
    process.stdout.write(`${crypto.sign(null, message, crypto.generateKeyPairSync('ed25519').privateKey).toString('base64')}\n`);
    break;
  case 'not-a-signature':
    process.stdout.write('{"Signature": "AAAA", "KeyId": "arn:aws:kms:us-east-1:111122223333:key/stub"}\n');
    break;
  case 'denied':
    process.stderr.write('An error occurred (AccessDeniedException) when calling the Sign operation: User: arn:aws:sts::111122223333:assumed-role/stub/session is not authorized to perform: kms:Sign on resource: arn:aws:kms:us-east-1:111122223333:key/stub\n');
    process.exitCode = 254;
    break;
  case 'unknown-failure':
    process.stderr.write('something new about account 111122223333 and arn:aws:kms:us-east-1:111122223333:key/stub\n');
    process.exitCode = 255;
    break;
  default:
    throw new Error(`no such mode: ${config.mode}`);
}
