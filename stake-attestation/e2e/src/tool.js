// The hunter tool, as a hunter runs it: the CLI in a process of its own, configured by VERDIKTA_* and
// CODE_RUNNER_*, its exit code read and its --json answer parsed.
import { spawn } from 'node:child_process';
import path from 'node:path';

import { APP_DIR } from './setup.js';

const BIN = path.join(APP_DIR, 'tool', 'bin', 'verdikta-attest.js');
const TOOL_TIMEOUT_MS = 900_000;

export function createTool({ chain, ipfs, runnerUrl, runnerToken, devKey, log }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    VERDIKTA_CONTRACT: chain.contract,
    VERDIKTA_RPC_URL: chain.rpcUrl,
    VERDIKTA_IPFS_GATEWAY: ipfs.url,
    VERDIKTA_PIN_BACKEND: 'pinata',
    VERDIKTA_PIN_URL: ipfs.url,
    VERDIKTA_PIN_TOKEN: ipfs.pinKey,
    VERDIKTA_WALLET_KEY: chain.keys.hunter,
    VERDIKTA_DEV_BUILDER_KEYS: devKey,
    VERDIKTA_POLL_MS: '250',
    CODE_RUNNER_URL: runnerUrl,
    CODE_RUNNER_TOKEN: runnerToken,
  };
  /** @returns {Promise<{ code: number|null, json: object|null, stdout: string, stderr: string }>} */
  return function tool(...args) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, [BIN, ...args, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        let json = null;
        try {
          json = JSON.parse(stdout);
        } catch { /* an error answer has no JSON */ }
        log(`verdikta-attest ${args[0]} -> exit ${code}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
        resolve({ code, json, stdout, stderr });
      });
    });
  };
}
