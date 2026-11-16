#!/usr/bin/env node
// The production builder key's signer, for the builder's { command, publicKey, env } route: the bytes to
// sign on stdin, the 64-byte Ed25519 signature, base64, on stdout. The key stays in AWS KMS (owner, Q5 and
// Q47): it can't be exported, and nothing here could read it. The builder checks every signature against
// the pinned public key, so this file is not what makes a signature trusted.
//
// It takes the job's identity at the moment it signs and keeps it to one process: it asks the runner for an
// OIDC token, writes it to a private file, and lets the aws command line trade that for a short session
// (AssumeRoleWithWebIdentity). No credential enters the job's environment, the builder or a later step, and
// the folder holding the token, the message and the CLI's session cache is gone when it exits.
//
// What AWS says is not repeated: its messages name the account, the role and the key, and a caller's logs
// can be public. A failure reaches the log as the error's class only, from the list below.
//
//   VERDIKTA_KMS_KEY_ARN   the key's ARN, or its alias's (the region is read from it)
//   VERDIKTA_KMS_ROLE_ARN  the role this job assumes
//   ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN   the runner's, with id-token: write
//   GITHUB_RUN_ID          optional: names the AWS session, so CloudTrail shows which run signed
//
// Exit codes: 65 the message can't be signed, 78 a reference is missing or malformed, 69 AWS or the
// runner refused or failed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// KMS's Sign takes 1 to 4096 bytes as RAW; anything longer it asks for as a digest, which plain Ed25519 can't take.
export const KMS_RAW_MESSAGE_BYTES = 4096;
const OIDC_AUDIENCE = 'sts.amazonaws.com';
const KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:([a-z]{2}(?:-[a-z]+)+-[0-9]+):[0-9]{12}:(?:key\/[A-Za-z0-9-]{1,128}|alias\/[A-Za-z0-9/_-]{1,256})$/;
const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const AWS_TIMEOUT_MS = 50000; // the builder's route stops waiting at 60 s
const TOKEN_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 64 * 1024;
// The classes of failure worth naming. Each is matched in AWS's text, and only this name is printed.
const AWS_FAILURES = Object.freeze([
  'AccessDenied', 'InvalidIdentityToken', 'ExpiredToken', 'IDPCommunicationError', 'NotFoundException', 'DisabledException',
  'KeyUnavailableException', 'KMSInvalidStateException', 'InvalidKeyUsageException', 'ThrottlingException', 'DependencyTimeoutException',
  'KMSInternalException', 'EndpointConnectionError', 'Unable to locate credentials', 'Could not connect',
]);

export class SignerRefusal extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The one call this file makes. fileb: hands AWS the bytes as they are, never decoded as text or base64. */
export function kmsSignArgs({ keyArn, messageFile, region }) {
  return [
    'kms', 'sign',
    '--key-id', keyArn,
    '--message', `fileb://${messageFile}`,
    '--message-type', 'RAW',
    '--signing-algorithm', 'ED25519_SHA_512',
    '--region', region,
    '--output', 'text',
    '--query', 'Signature',
    '--cli-connect-timeout', '10',
    '--cli-read-timeout', '30',
  ];
}

function awsCall(args, env) {
  return new Promise((resolve) => {
    const child = spawn('aws', args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out = { stdout: '', stderr: '' };
    const collect = (name) => (chunk) => { if (out[name].length < MAX_OUTPUT_BYTES) out[name] += chunk.toString('utf8'); };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const timer = setTimeout(() => child.kill('SIGKILL'), AWS_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ...out, code: null, spawnError: err.code ?? 'failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...out, code, spawnError: null });
    });
  });
}

/**
 * Asks KMS to sign. `credentials` says how aws authenticates: it gets a private folder, removed when this
 * function returns, and the key's region, and answers with the call's whole environment.
 * @param {object} o
 * @param {Buffer} o.message
 * @param {string} o.keyArn
 * @param {(dir: string, region: string) => Promise<Record<string,string>>|Record<string,string>} o.credentials
 * @returns {Promise<string>} the signature, base64
 * @throws {SignerRefusal}
 */
export async function signWithKms({ message, keyArn, credentials }) {
  if (message.length > KMS_RAW_MESSAGE_BYTES) {
    throw new SignerRefusal(65, `the signing bytes are ${message.length} bytes, above AWS KMS's ${KMS_RAW_MESSAGE_BYTES}-byte limit for a RAW message: nothing was sent, and nothing is signed`);
  }
  if (message.length === 0) throw new SignerRefusal(65, 'there are no signing bytes: AWS KMS signs at least one byte');
  const arn = KEY_ARN.exec(typeof keyArn === 'string' ? keyArn : '');
  if (!arn) throw new SignerRefusal(78, 'VERDIKTA_KMS_KEY_ARN must be a KMS key or alias ARN');
  const region = arn[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-kms-'));
  try {
    const env = await credentials(dir, region);
    const messageFile = path.join(dir, 'message');
    fs.writeFileSync(messageFile, message, { mode: 0o600 });
    const r = await awsCall(kmsSignArgs({ keyArn, messageFile, region }), env);
    if (r.spawnError) throw new SignerRefusal(69, r.spawnError === 'ENOENT' ? 'the aws command line is not on PATH' : 'the aws command line could not start');
    if (r.code !== 0) {
      const name = AWS_FAILURES.find((f) => r.stderr.includes(f));
      throw new SignerRefusal(69, name
        ? `aws kms sign failed: ${name}`
        : `aws kms sign failed (exit ${r.code ?? 'by timeout'}); its output is not shown, as it can name the account`);
    }
    const signature = r.stdout.trim();
    if (!SIGNATURE.test(signature)) throw new SignerRefusal(69, 'aws kms sign did not answer with an Ed25519 signature; its output is not shown');
    return signature;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The runner's OIDC token, for AWS's audience. */
async function oidcToken({ requestUrl, requestToken }) {
  if (!requestUrl || !requestToken) {
    throw new SignerRefusal(69, 'this job has no OIDC token to ask for: it needs id-token: write, which a fork\'s pull request does not get and a caller has to grant');
  }
  const url = new URL(requestUrl);
  url.searchParams.set('audience', OIDC_AUDIENCE);
  let value;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    if (!res.ok) throw new SignerRefusal(69, `the runner refused an OIDC token: HTTP ${res.status}`);
    value = (await res.json()).value;
  } catch (err) {
    if (err instanceof SignerRefusal) throw err;
    throw new SignerRefusal(69, 'the runner did not answer with an OIDC token');
  }
  if (typeof value !== 'string' || !JWT.test(value)) throw new SignerRefusal(69, 'the runner did not answer with an OIDC token');
  return value;
}

/**
 * aws's whole environment in the job: a role to assume with a token from a private file, and nothing of
 * the job's. HOME is the private folder because the CLI caches the session under it. Metadata services are
 * off: if the role can't be assumed the call fails, and it never falls back on what the machine holds.
 */
function webIdentityEnv(env) {
  return async (dir, region) => {
    const roleArn = env.VERDIKTA_KMS_ROLE_ARN;
    if (!ROLE_ARN.test(typeof roleArn === 'string' ? roleArn : '')) throw new SignerRefusal(78, 'VERDIKTA_KMS_ROLE_ARN must be an IAM role ARN');
    const token = await oidcToken({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
    const tokenFile = path.join(dir, 'web-identity-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const run = /^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : 'local';
    return {
      PATH: env.PATH || '/usr/bin:/bin',
      HOME: dir,
      AWS_REGION: region,
      AWS_ROLE_ARN: roleArn,
      AWS_ROLE_SESSION_NAME: `verdikta-builder-sign-${run}`,
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
      AWS_STS_REGIONAL_ENDPOINTS: 'regional',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_MAX_ATTEMPTS: '2',
      AWS_PAGER: '',
    };
  };
}

async function main() {
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  const signature = await signWithKms({ message: Buffer.concat(parts), keyArn: process.env.VERDIKTA_KMS_KEY_ARN, credentials: webIdentityEnv(process.env) });
  process.stdout.write(`${signature}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`kms-sign: ${err instanceof SignerRefusal ? err.message : 'failed'}\n`);
    process.exitCode = err instanceof SignerRefusal ? err.exitCode : 1;
  }
}
