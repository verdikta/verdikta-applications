// The fake `aws` on a test's PATH, and a fake of the runner's OIDC token endpoint. A test holds the fake's
// key, so it can tell what was signed; nothing here can reach a cloud account.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNER = fileURLToPath(new URL('../../action/kms-sign.js', import.meta.url));
const MAIN = fileURLToPath(new URL('./awsStubMain.js', import.meta.url));

// AWS's own documentation account and an obviously fake key: what a leak would look like, for the tests that look for one.
export const ACCOUNT = '111122223333';
export const KEY_ARN = `arn:aws:kms:us-east-1:${ACCOUNT}:key/00000000-1111-2222-3333-444444444444`;
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/stub-signing-role`;

export function ed25519Pair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    verifyKey: publicKey,
  };
}

/** A folder holding an `aws` that answers as `mode` says. */
export function installAwsStub({ pem = ed25519Pair().pem, mode = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-awsstub-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privateKey: pem, mode }));
  fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${MAIN}" "${dir}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  return {
    bin,
    path: `${bin}${path.delimiter}${process.env.PATH}`,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The runner's token endpoint: answers a bearer-authenticated GET with { value }. */
export async function oidcEndpoint({ value = 'header.payload.signature', status = 200 } = {}) {
  const requests = [];
  const requestToken = 'stub-request-token';
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.statusCode = status;
    res.end(JSON.stringify({ count: 1, value }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.address().port}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken },
    requestToken,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs the signer as the builder's route does: bytes on stdin, the signature on stdout. */
export function runSigner(message, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SIGNER], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}
