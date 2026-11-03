// What a round needs before it starts: every package's locked dependencies, verdikta-arbiter at the
// pinned commit with its own, onchain's contracts compiled. Each step fails loudly; none is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { git, must } from './proc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(here, '..');
export const APP_DIR = path.resolve(E2E_DIR, '..');
export const PIN = JSON.parse(fs.readFileSync(path.join(E2E_DIR, 'arbiter.pin.json'), 'utf8'));

const SIBLINGS = ['shared', 'onchain', 'server', 'tool', 'builder', 'client'];
const ARBITER_PACKAGES = ['external-adapter', 'ai-node', 'code-runner', 'e2e'];
const installed = (dir) => fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'));

/** This repository's packages, each from its own lock file, with no lifecycle script (as CI installs them). */
export function installSiblings(log) {
  for (const name of SIBLINGS) {
    const dir = path.join(APP_DIR, name);
    if (installed(dir)) continue;
    log(`npm ci in ${name}`);
    must('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  }
}

/**
 * verdikta-arbiter at the pin, in e2e/.arbiter/<commit>: fetched by id with no credential (the
 * repository is public), or SA_E2E_ARBITER_DIR, which must be at the pin unless
 * SA_E2E_ARBITER_UNPINNED=1 says otherwise, and the report then names what ran.
 * @returns {{ dir: string, commit: string, pinned: boolean }}
 */
export function arbiterCheckout(log, env = process.env) {
  let dir = env.SA_E2E_ARBITER_DIR;
  if (!dir) {
    dir = path.join(E2E_DIR, '.arbiter', PIN.commit.slice(0, 12));
    if (!fs.existsSync(path.join(dir, '.git', 'shallow'))) {
      log(`fetching verdikta-arbiter at ${PIN.commit}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q');
      git(dir, 'fetch', '-q', '--depth', '1', PIN.repository, PIN.commit);
      git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    }
  }
  dir = path.resolve(dir);
  const commit = git(dir, 'rev-parse', 'HEAD');
  const pinned = commit === PIN.commit;
  if (!pinned && env.SA_E2E_ARBITER_UNPINNED !== '1') {
    throw new Error(`verdikta-arbiter at ${dir} is at ${commit}, not the pinned ${PIN.commit} (set SA_E2E_ARBITER_UNPINNED=1 to run another commit, or move arbiter.pin.json)`);
  }
  for (const name of ARBITER_PACKAGES) {
    const pkg = path.join(dir, name);
    if (installed(pkg)) continue;
    log(`npm ci in verdikta-arbiter/${name}`);
    must('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pkg });
  }
  return { dir, commit, pinned };
}

/** onchain's own compile, with its own settings: the round deploys these artifacts. */
export function compileContracts(log) {
  log('compiling the contracts');
  must(path.join(APP_DIR, 'onchain', 'node_modules', '.bin', 'hardhat'), ['compile', '--quiet'], {
    cwd: path.join(APP_DIR, 'onchain'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' },
  });
}

/** Chromium for the client's pages: installed when missing, and a failure to install is the round's. */
export async function browserReady(log) {
  const require = createRequire(path.join(APP_DIR, 'client', 'package.json'));
  const { chromium } = require('playwright');
  if (!fs.existsSync(chromium.executablePath())) {
    log('installing Chromium for the client\'s pages');
    must(path.join(APP_DIR, 'client', 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], { cwd: path.join(APP_DIR, 'client') });
  }
  return chromium;
}
