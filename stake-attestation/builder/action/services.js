#!/usr/bin/env node
// The services the reusable builder workflow's build job runs beside the builder, and the configs
// it hands the builder. Nothing here holds a secret: the build job has none.
//
//   start        a registry:2 (pinned by digest) on 127.0.0.1 of the runner, where the build pushes
//                and reads the image without a credential; the code-runner of verdikta-arbiter at
//                the pinned commit, started as its README says (its own environment, a token made
//                for this run); and <dir>/builder.json, which points the builder at both and names
//                the repository the publish job will copy the image to (registry.publishAs)
//   stop         stops both
//   sign-config  <dir>/sign.json for a sign job: the dev key, or the KMS signer (action/kms-sign.js)
//                with the pinned public key, once @verdikta/common's trusted set holds that key
//
//   node action/services.js start --dir <dir> --publish-as <repository> --spec <draft> [--runtime runsc|runc] [--signing dev|production] [--explorer-url <url>]
//   node action/services.js stop --dir <dir>
//   node action/services.js sign-config --dir <dir> --signing dev|production --publish-as <repository>
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../src/config.js';
import { neutralize } from '../src/logSafe.js';
import { productionKeyProblem } from '../src/signing.js';

export const ACTION_PINS = Object.freeze(JSON.parse(fs.readFileSync(new URL('./pins.json', import.meta.url), 'utf8')));

const STAGING_NAME = 'stake-env';
const RUNTIMES = new Set(['runsc', 'runc']);
const LABEL = 'io.verdikta.builder.action=1';
const KMS_SIGNER = fileURLToPath(new URL('./kms-sign.js', import.meta.url));
/** What the signer may see of the sign step's environment; the route gives it PATH and HOME besides. */
export const KMS_SIGNER_ENV = Object.freeze(['VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_RUN_ID']);

/**
 * The build job's builder config: push to and read from the loopback registry, validate on the
 * loopback code-runner (its token in a file), and name `publishAs` in code_review.json. A contract
 * listing gets the keyless explorer given for its chain, so no explorer key enters the build job.
 */
export function builderConfig({ dir, registryPort, runnerPort, publishAs, spec, explorerUrl = null }) {
  const raw = {
    registry: { repository: `127.0.0.1:${registryPort}/${STAGING_NAME}`, publishAs },
    runner: { url: `http://127.0.0.1:${runnerPort}`, tokenFile: path.join(dir, 'runner.token') },
    workDir: path.join(dir, 'tmp'),
    ...(spec?.artifact?.kind === 'contract' && explorerUrl ? { explorers: { [spec.artifact.chainId]: { apiUrl: explorerUrl } } } : {}),
  };
  parseConfig(raw, { baseDir: dir, env: {} });
  return raw;
}

/**
 * The signing mode, exactly. GitHub's expressions compare strings without regard to case, so the workflow's
 * own conditions take `Production` for production, while the rules here would take it for not production:
 * that build would skip production's checks and still hand its digest on to be signed.
 */
export function signingMode(signing) {
  if (signing !== 'dev' && signing !== 'production') throw new Error('signing must be exactly dev or production');
  return signing;
}

/**
 * Stops a production run while @verdikta/common's trusted set doesn't hold the pinned key: every arbiter
 * would refuse what it signs. A test may name the set; verification itself reads only common's.
 */
function assertBuilderKeyTrusted(trustedKeys) {
  const problem = productionKeyProblem(ACTION_PINS.builderKey, trustedKeys);
  if (problem) throw new Error(`SIGNING_KEY_NOT_TRUSTED: ${problem}`);
}

/**
 * A sign job's config. Production is the KMS signer through the builder's command route, never a key in
 * the environment: the config holds names only, and the runner entry is there for the config's schema
 * (sign never contacts it).
 */
export function signConfig({ signing, publishAs, trustedKeys }) {
  if (signing !== 'dev' && signing !== 'production') throw new TypeError('signing must be dev or production');
  if (signing === 'production') assertBuilderKeyTrusted(trustedKeys);
  const raw = {
    registry: { repository: publishAs },
    runner: { url: 'http://127.0.0.1:9', tokenEnv: 'UNUSED_RUNNER_TOKEN' },
    signing: { key: signing === 'dev' ? 'dev' : { command: [process.execPath, KMS_SIGNER], publicKey: ACTION_PINS.builderKey.publicKey, env: [...KMS_SIGNER_ENV] } },
  };
  parseConfig(raw, { baseDir: '/', env: {} });
  return raw;
}

/** `docker run` of the pinned registry:2 on the runner's loopback (host network). */
export function registryArgs({ name, port }) {
  return ['run', '--detach', '--name', name, '--label', LABEL, '--network', 'host', '--env', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`, ACTION_PINS.registry.image];
}

/** The code-runner's whole environment: what its README names, and nothing of the job's. */
export function codeRunnerEnv({ token, port, runtime, registryHost, stateDir, base = process.env }) {
  if (!RUNTIMES.has(runtime)) throw new TypeError(`runtime must be ${[...RUNTIMES].join(' or ')}`);
  return {
    PATH: base.PATH ?? '/usr/bin:/bin',
    HOME: base.HOME ?? '/',
    ...(base.DOCKER_HOST ? { DOCKER_HOST: base.DOCKER_HOST } : {}),
    CODE_RUNNER_TOKEN: token,
    CODE_RUNNER_HOST: '127.0.0.1',
    CODE_RUNNER_PORT: String(port),
    CODE_RUNNER_RUNTIME: runtime,
    CODE_RUNNER_REGISTRY_ALLOWLIST: registryHost,
    CODE_RUNNER_INSTANCE: 'verdikta-builder-action',
    CODE_RUNNER_STATE_DIR: stateDir,
    LOG_LEVEL: 'warn',
  };
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${(r.stderr || r.error?.message || '').slice(-2000)}`);
  return r.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`${what} did not come up in ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Whether the code-runner can check a listing. Its /health is 503 whenever a run would not be admitted,
 * and since node A3c that includes a host without the Semgrep image a claim's scan needs, which the
 * runner never pulls. A listing check does not run the scanner, so a maker's build job does not pay
 * for that image: its absence alone is no reason to wait. Anything beside it, or anything else, is.
 * @param {{ status: number, json: object|null }} answer
 */
export function runnerAnswersListings({ status, json }) {
  if (status === 200) return true;
  if (status !== 503 || json?.service !== 'verdikta-code-runner' || !Array.isArray(json.reasons)) return false;
  const scan = json.scanner;
  return json.reasons.length === 1 && scan?.present === false && typeof scan.problem === 'string' && json.reasons[0] === scan.problem;
}

/**
 * What to say about where the image will be published. An arbiter pulls only from its allowlist and
 * abstains on anything else, and a claim that only gets abstentions ends with the bond to the maker.
 * What an arbiter's list holds is its operator's, so this reads the one thing that can be read: the
 * default of the runner at the pin. A development listing may be for arbiters set up otherwise, so it
 * hears about it; a production signing is for arbiters as they are, and stops.
 * @param {object} o
 * @param {string} o.publishAs
 * @param {string} o.signing
 * @param {{ allowed: (repository: string) => boolean, defaults: string }} o.arbiter - the pinned runner's own rule
 * @returns {{ refuse: boolean, text: string }|null}
 */
export function publishTargetNote({ publishAs, signing, arbiter }) {
  if (arbiter.allowed(publishAs)) return null;
  return {
    refuse: signing === 'production',
    text: `${publishAs} is not on the default registry allowlist of the pinned code-runner (${arbiter.defaults}): an arbiter on its defaults abstains on every claim on this listing, and a claim that only gets abstentions ends with the bond to the maker`,
  };
}

/** The pinned runner's own allowlist rule, from its checkout. */
export function pinnedAllowlist(runnerDir) {
  const { DEFAULT_REGISTRY_ALLOWLIST, allowedBy, parseAllowlist, parseImageRef } = createRequire(path.join(runnerDir, 'package.json'))('./src/registry.js');
  const { entries } = parseAllowlist(DEFAULT_REGISTRY_ALLOWLIST);
  return { defaults: DEFAULT_REGISTRY_ALLOWLIST, allowed: (repository) => Boolean(allowedBy(parseImageRef(`${repository}@sha256:${'0'.repeat(64)}`), entries)) };
}

async function start(opts) {
  const signing = signingMode(opts.signing ?? 'dev');
  // Before anything is built or published: a production listing that can't be signed should stop here.
  if (signing === 'production') assertBuilderKeyTrusted();
  const dir = path.resolve(opts.dir);
  const spec = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
  const state = { registry: `vab-registry-${crypto.randomBytes(4).toString('hex')}`, pid: null };
  const write = () => fs.writeFileSync(path.join(dir, 'services.json'), `${JSON.stringify(state, null, 2)}\n`);

  const registryPort = await freePort();
  sh('docker', registryArgs({ name: state.registry, port: registryPort }));
  write();
  await until(async () => (await fetch(`http://127.0.0.1:${registryPort}/v2/`)).status === 200, 60000, 'registry:2');

  const arbiter = path.join(dir, 'verdikta-arbiter');
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  sh('git', ['init', '--quiet', arbiter], { env: gitEnv });
  sh('git', ['-C', arbiter, 'fetch', '--quiet', '--depth', '1', ACTION_PINS.codeRunner.repository, ACTION_PINS.codeRunner.commit], { env: gitEnv });
  sh('git', ['-C', arbiter, 'checkout', '--quiet', '--detach', ACTION_PINS.codeRunner.commit], { env: gitEnv });
  const runnerDir = path.join(arbiter, 'code-runner');
  sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runnerDir });

  const note = publishTargetNote({ publishAs: opts['publish-as'], signing, arbiter: pinnedAllowlist(runnerDir) });
  if (note?.refuse) throw new Error(note.text);
  if (note) process.stdout.write(`::warning::${note.text}\n`);

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'runner.token'), token, { mode: 0o600 });
  const runnerPort = await freePort();
  const stateDir = fs.mkdtempSync(path.join(dir, 'runner-state-'));
  const log = fs.openSync(path.join(dir, 'code-runner.log'), 'a');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: runnerDir,
    env: codeRunnerEnv({ token, port: runnerPort, runtime: opts.runtime ?? 'runsc', registryHost: `127.0.0.1:${registryPort}`, stateDir }),
    stdio: ['ignore', log, log],
    detached: true,
  });
  child.unref();
  state.pid = child.pid;
  write();
  let health = null;
  try {
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${runnerPort}/health`, { headers: { authorization: `Bearer ${token}` } });
      health = { status: r.status, json: await r.json().catch(() => null) };
      return runnerAnswersListings(health);
    }, 120000, 'the code-runner');
  } catch (err) {
    throw new Error(`${err.message}: ${JSON.stringify(health?.json?.reasons ?? health?.status ?? 'no answer')}`);
  }

  const config = builderConfig({ dir, registryPort, runnerPort, publishAs: opts['publish-as'], spec, explorerUrl: opts['explorer-url'] || null });
  fs.writeFileSync(path.join(dir, 'builder.json'), `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`registry:2 on 127.0.0.1:${registryPort}, the code-runner ${ACTION_PINS.codeRunner.commit.slice(0, 12)} (${opts.runtime ?? 'runsc'}) on 127.0.0.1:${runnerPort}; ${path.join(dir, 'builder.json')}\n`);
}

function stop(opts) {
  const file = path.join(path.resolve(opts.dir), 'services.json');
  if (!fs.existsSync(file)) return;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.pid) {
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (state.registry) spawnSync('docker', ['rm', '--force', '--volumes', state.registry], { encoding: 'utf8' });
  process.stdout.write('stopped the registry and the code-runner\n');
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) opts[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  try {
    if (command === 'start' && opts.dir && opts['publish-as'] && opts.spec) await start(opts);
    else if (command === 'stop' && opts.dir) stop(opts);
    else if (command === 'sign-config' && opts.dir && opts.signing && opts['publish-as']) {
      fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(opts.dir, 'sign.json'), `${JSON.stringify(signConfig({ signing: opts.signing, publishAs: opts['publish-as'] }), null, 2)}\n`);
    } else {
      process.stderr.write('usage: node action/services.js start --dir <dir> --publish-as <repository> --spec <draft> [--runtime runsc|runc] [--signing dev|production] [--explorer-url <url>]\n'
        + '       node action/services.js stop --dir <dir>\n'
        + '       node action/services.js sign-config --dir <dir> --signing dev|production --publish-as <repository>\n');
      return 64;
    }
    return 0;
  } catch (err) {
    process.stderr.write(neutralize(`services: ${err.message}\n`));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
