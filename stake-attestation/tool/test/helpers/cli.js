// The CLI as a hunter runs it: a child process with its own environment. Secrets reach it only through
// the environment or a file, never argv. `w` is the test's world; a chain is given over HTTP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRpc } from './chain.js';
import { TOKEN } from './runner.js';

export const BIN = fileURLToPath(new URL('../../bin/verdikta-attest.js', import.meta.url));
const rpcs = new WeakMap();

/** One HTTP bridge per world. */
export async function rpcOf(w) {
  if (!rpcs.has(w)) rpcs.set(w, await startRpc(w.hre));
  return rpcs.get(w);
}

export function closeRpc(w) {
  const r = rpcs.get(w);
  rpcs.delete(w);
  return r ? r.close() : undefined;
}

export function envFor(w, rpcUrl, { runner, keyVia = 'env', extra = {} } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    VERDIKTA_RPC_URL: rpcUrl,
    VERDIKTA_CONTRACT: w.address,
    VERDIKTA_IPFS_GATEWAY: w.ipfs.url,
    VERDIKTA_PIN_BACKEND: 'kubo',
    VERDIKTA_PIN_URL: w.ipfs.url,
    VERDIKTA_DEV_BUILDER_KEYS: w.builderKey.publicKey,
    VERDIKTA_CONFIRMATIONS: '1',
    VERDIKTA_POLL_MS: '5',
    VERDIKTA_WAIT_MS: '8000',
    VERDIKTA_READBACK_MS: '50',
    VERDIKTA_RECEIPT_GRACE_MS: '20',
    ...(runner?.url ? { CODE_RUNNER_URL: runner.url, CODE_RUNNER_TOKEN: TOKEN } : {}),
    ...(keyVia === 'env' ? { VERDIKTA_WALLET_KEY: w.hunterKey } : {}),
    ...extra,
  };
  return env;
}

/** @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }>} */
export function spawnCli(args, env, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function runCli(w, args, { runner, keyVia, extra, timeoutMs } = {}) {
  const rpc = await rpcOf(w);
  return spawnCli(args, envFor(w, rpc.url, { runner, keyVia, extra }), { timeoutMs });
}

export function statePath(dir, name = 'state.json') {
  return path.join(dir, '.verdikta-claim', name);
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
