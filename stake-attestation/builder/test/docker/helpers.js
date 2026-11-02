// Setup for the tests that need a real Docker daemon: a throwaway registry:2, the fixture
// repository, and the code-runner from verdikta-arbiter at the pinned commit as a sidecar.
// Everything a test starts carries its own id and is removed by the returned `remove`/`stop`.
//
// Registries. The daemon pushes to and the code-runner pulls from 127.0.0.1:<port> on the
// daemon's host (a registry on the host network: on Docker Desktop that is the VM, which macOS
// cannot reach); the builder reads manifests from a second registry container over the same
// storage, published on this machine's 127.0.0.1 (config `registry.apiUrl`). On Linux both
// are on the same loopback anyway.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '..', 'fixtures');
export const PIN = JSON.parse(fs.readFileSync(path.join(here, 'code-runner.pin.json'), 'utf8'));

/** registry:2 (2.8.3), the multi-platform index pinned by digest (the same pin the code-runner's tests use). */
export const REGISTRY_IMAGE = 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

export function docker(args, { allowFail = false, timeout = 600000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFail) assert.equal(r.status, 0, `docker ${args.join(' ')}: ${r.stderr}`);
  return r;
}

export function newId() {
  return `vab${crypto.randomBytes(4).toString('hex')}`;
}

/** The daemon's architecture decides the platforms: arm64 hosts here have no amd64 emulation. */
export function testPlatforms() {
  if (process.env.SA_BUILDER_TEST_PLATFORMS === 'amd64') return { setup: 'linux/amd64', run: 'linux/amd64', extra: [] };
  const arch = docker(['info', '--format', '{{.Architecture}}']).stdout.trim();
  return /^(aarch64|arm64)$/.test(arch)
    ? { setup: 'linux/arm64', run: 'linux/arm64', extra: ['linux/arm64'] }
    : { setup: 'linux/amd64', run: 'linux/amd64', extra: [] };
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(fn, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Two registry:2 containers over one volume: one for the daemon (push, pull), one for this machine (reads). */
export async function startRegistries(id) {
  const volume = `${id}-registry`;
  const push = `${id}-registry-push`;
  const read = `${id}-registry-read`;
  const remove = () => {
    docker(['rm', '--force', '--volumes', push, read], { allowFail: true });
    docker(['volume', 'rm', '--force', volume], { allowFail: true });
  };
  try {
    docker(['volume', 'create', '--label', `io.verdikta.builder.test=${id}`, volume]);
    let pushPort = null;
    for (let i = 0; i < 10 && !pushPort; i += 1) {
      const port = 20000 + crypto.randomInt(30000);
      docker(['rm', '--force', push], { allowFail: true });
      docker(['run', '--detach', '--name', push, '--label', `io.verdikta.builder.test=${id}`, '--network', 'host', '--volume', `${volume}:/var/lib/registry`,
        '--env', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`, REGISTRY_IMAGE]);
      const up = await until(() => {
        const logs = docker(['logs', push], { allowFail: true });
        return /listening on 127\.0\.0\.1/.test(`${logs.stdout}${logs.stderr}`);
      });
      if (up) pushPort = port;
    }
    assert.ok(pushPort, 'the push registry started');
    docker(['run', '--detach', '--name', read, '--label', `io.verdikta.builder.test=${id}`, '--publish', '127.0.0.1::5000', '--volume', `${volume}:/var/lib/registry:ro`, REGISTRY_IMAGE]);
    const readPort = docker(['port', read, '5000/tcp']).stdout.trim().split('\n')[0].split(':').pop();
    const apiUrl = `http://127.0.0.1:${readPort}`;
    assert.ok(await until(async () => (await fetch(`${apiUrl}/v2/`).catch(() => null))?.status === 200), 'the read registry answers');
    return { host: `127.0.0.1:${pushPort}`, apiUrl, remove };
  } catch (err) {
    remove();
    throw err;
  }
}

/** Removes every local image of a test's repository (the builder's tag and any digest reference). */
export function removeImages(repository) {
  const ls = docker(['image', 'ls', '--digests', '--format', '{{json .}}'], { allowFail: true });
  const refs = new Set();
  for (const line of ls.stdout.split('\n').filter(Boolean)) {
    const img = JSON.parse(line);
    if (img.Repository !== repository) continue;
    if (img.Tag && img.Tag !== '<none>') refs.add(`${img.Repository}:${img.Tag}`);
    if (img.Digest && img.Digest !== '<none>') refs.add(`${img.Repository}@${img.Digest}`);
  }
  if (refs.size) docker(['image', 'rm', '--force', ...refs], { allowFail: true });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '1767225600 +0000', GIT_COMMITTER_DATE: '1767225600 +0000' },
  }).trim();
}

/** The fixture Foundry repository (test/fixtures/vault plus `extra` files and `gitlinks`) as a bare mirror. */
export function fixtureRepo(dir, extra = {}, { gitlinks = {} } = {}) {
  const work = path.join(dir, 'work');
  fs.cpSync(path.join(FIXTURES, 'vault'), work, { recursive: true });
  for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  for (const [p, commit] of Object.entries(gitlinks)) git(work, 'update-index', '--add', '--cacheinfo', `160000,${commit},${p}`);
  git(work, '-c', 'user.name=maker', '-c', 'user.email=maker@verdikta.invalid', 'commit', '-q', '-m', 'listed');
  const mirror = path.join(dir, 'mirror.git');
  git(dir, 'clone', '-q', '--bare', work, mirror);
  return { mirror, baseCommit: git(work, 'rev-parse', 'HEAD') };
}

/** The code-runner checkout: SA_CODE_RUNNER_DIR (must be at the pin), else a clone of the pin. */
function codeRunnerDir() {
  let dir = process.env.SA_CODE_RUNNER_DIR;
  if (!dir) {
    const root = path.join(os.tmpdir(), `vab-arbiter-${PIN.commit.slice(0, 12)}`);
    if (!fs.existsSync(path.join(root, '.git'))) {
      fs.mkdirSync(root, { recursive: true });
      git(root, 'init', '-q');
      git(root, 'fetch', '-q', '--depth', '1', PIN.repository, PIN.commit);
      git(root, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    }
    dir = path.join(root, 'code-runner');
  }
  const head = git(path.dirname(path.resolve(dir)), 'rev-parse', 'HEAD');
  if (process.env.SA_CODE_RUNNER_UNPINNED !== '1') {
    assert.equal(head, PIN.commit, `the code-runner at ${dir} is at ${head}, not the pinned ${PIN.commit} (set SA_CODE_RUNNER_UNPINNED=1 to override)`);
  }
  if (!fs.existsSync(path.join(dir, 'node_modules', '@verdikta', 'common'))) {
    const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
    assert.equal(r.status, 0, `npm ci in ${dir}: ${r.stderr}`);
  }
  return { dir, commit: head };
}

/** Starts the code-runner as its README says (its own environment, a fresh token), on a loopback port. */
export async function startCodeRunner({ id, registryHost, platform }) {
  const { dir, commit } = codeRunnerDir();
  const token = crypto.randomBytes(32).toString('hex');
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-runner-state-'));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    CODE_RUNNER_TOKEN: token,
    CODE_RUNNER_HOST: '127.0.0.1',
    CODE_RUNNER_PORT: String(port),
    CODE_RUNNER_RUNTIME: process.env.CODE_RUNNER_RUNTIME || 'runc',
    CODE_RUNNER_PLATFORM: platform,
    CODE_RUNNER_REGISTRY_ALLOWLIST: registryHost,
    CODE_RUNNER_INSTANCE: id,
    CODE_RUNNER_STATE_DIR: state,
    LOG_LEVEL: 'warn',
  };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const url = `http://127.0.0.1:${port}`;
  const health = await until(async () => {
    if (child.exitCode !== null) return 'exited';
    const r = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    return r ? r.json() : null;
  }, { timeoutMs: 60000 });
  assert.ok(health && health !== 'exited', `the code-runner did not start: ${log}`);
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await until(() => child.exitCode !== null, { timeoutMs: 60000 });
    }
    fs.rmSync(state, { recursive: true, force: true });
  };
  return { url, token, commit, health, stop, log: () => log };
}

/** The fixture's draft code_review.json: setup has network; build and test must not. */
export function fixtureDraft(baseCommit, recipient, over = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/verdikta-test/vault-fixture',
    baseCommit,
    env: { from: 'foundry' },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge',
      // At build time: count the IPv4 routes the setup can use (none without a network), and let forge fetch solc.
      setup: 'tail -n +2 /proc/net/route | grep -c . > setup-routes.txt; forge build',
      // At validation: build only where there is no route out.
      build: '[ "$(tail -n +2 /proc/net/route | grep -c .)" = 0 ] && forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS',
    },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 2048 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      scope: { include: ['src/**'] },
      severityRubric: 'immunefi-v2.3',
      disclosureKey: recipient,
    },
    ...over,
  };
}
