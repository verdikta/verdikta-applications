// The deploy kit's two builder files (node P23; README "Running the site"): deploy/builder.json, the config the site's
// host gives the baseline scan, and deploy/check-scan-limits.mjs, the check an operator runs to see the scan's
// sandbox limits hold under the host's rootless Docker. With the workflow backend the site's host builds and signs
// nothing: the scan is the only builder step it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { sandboxRunArgs } from '../../src/docker.js';
import { SCAN_TOOLS } from '../../src/scanTools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(here, '..', '..', '..', 'deploy');
const CONFIG = path.join(DEPLOY, 'builder.json');
const check = () => import(pathToFileURL(path.join(DEPLOY, 'check-scan-limits.mjs')).href);

test('deploy/builder.json parses with no secret in the environment: the class platform, no agent pass, nothing to sign with', () => {
  const c = loadConfig(CONFIG, { env: {} });
  assert.equal(c.platforms.run, 'linux/amd64');
  assert.equal(c.scan.agent, null, 'SA_SCAN_AGENT is off: no model is configured');
  assert.equal(c.signing.key, 'dev', 'the host never signs: the signing workflow does');
  assert.equal(c.docker.host, null, 'the daemon comes from DOCKER_HOST, the service user\'s rootless socket');
  assert.equal(c.explorers.size, 0);
  assert.throws(() => c.runner.token(), /SECRET_UNAVAILABLE/, 'no runner token on the host: the scan never asks for one');
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['registry', 'runner']);
});

test('the scan reads none of the parts of the config the host cannot give it: the runner, the registry, a signing key, an explorer', () => {
  const scan = fs.readFileSync(path.resolve(here, '..', '..', 'src', 'scan.js'), 'utf8');
  for (const part of ['runner', 'registry', 'signing', 'explorers', 'solc', 'limits']) {
    assert.doesNotMatch(scan, new RegExp(`config\\.${part}\\b`), `scan.js reads config.${part}`);
  }
});

const DEFAULT_ARGS = sandboxRunArgs({ image: 'x', platform: 'linux/amd64', name: 'n', label: 'l', argv: ['true'] });
const flag = (args, name) => args[args.indexOf(name) + 1];

/** A docker CLI stand-in: `pull` succeeds, `run` prints `cgroup`, `rm` succeeds; every call is kept. */
function fakeDocker(cgroup, { pullExit = 0, runExit = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (args[0] === 'pull') return { exitCode: pullExit, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (args[0] === 'run') return { exitCode: runExit, stdout: Buffer.from(cgroup), stderr: Buffer.alloc(0), timedOut: false, spawnError: null };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

const HOLDS = `${Number(flag(DEFAULT_ARGS, '--memory').replace(/m$/, '')) * 1024 * 1024}\n0\n${flag(DEFAULT_ARGS, '--pids-limit')}\n${Number(flag(DEFAULT_ARGS, '--cpus')) * 100000} 100000\n`;

test('check-scan-limits runs the scan\'s own sandbox, the pinned gitleaks image, and passes when the cgroup holds its limits', async () => {
  const { checkScanLimits } = await check();
  const docker = fakeDocker(HOLDS);
  const lines = [];
  assert.equal(await checkScanLimits({ docker, log: (l) => lines.push(l) }), 0, lines.join('\n'));
  const [pull, run] = docker.calls;
  assert.deepEqual(pull, ['pull', '--quiet', '--platform', 'linux/amd64', SCAN_TOOLS.gitleaks.image], 'pulled as the scan pulls it');
  assert.equal(run[0], 'run');
  // the scan's flags, exactly: only the container's name and the command differ
  const normalize = (args) => args.map((a, i) => (args[i - 1] === '--name' ? '<name>' : a)).slice(0, args.indexOf(SCAN_TOOLS.gitleaks.image) + 1);
  const scanArgs = sandboxRunArgs({ image: SCAN_TOOLS.gitleaks.image, platform: 'linux/amd64', name: 'x', label: 'io.verdikta.builder=1', argv: ['true'] });
  assert.deepEqual(normalize(run), normalize(scanArgs));
  assert.deepEqual(run.slice(run.indexOf(SCAN_TOOLS.gitleaks.image) + 1), ['cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max', '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/cpu.max']);
  assert.deepEqual(docker.calls[2].slice(0, 3), ['rm', '--force', '--volumes'], 'the container removed, as the scan removes it');
  assert.ok(lines.some((l) => /^OK/.test(l)));
});

test('check-scan-limits fails, naming each limit, when rootless Docker dropped them (no cgroup delegation)', async () => {
  const { checkScanLimits } = await check();
  const lines = [];
  assert.equal(await checkScanLimits({ docker: fakeDocker('max\nmax\nmax\nmax 100000\n'), log: (l) => lines.push(l) }), 1);
  const out = lines.join('\n');
  for (const what of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) assert.match(out, new RegExp(what.replace('.', '\\.')), what);
  assert.match(out, /Delegate=/, 'says what to fix');
});

test('check-scan-limits fails when the image cannot be pulled or the container does not run', async () => {
  const { checkScanLimits } = await check();
  assert.equal(await checkScanLimits({ docker: fakeDocker(HOLDS, { pullExit: 1 }), log: () => {} }), 1);
  assert.equal(await checkScanLimits({ docker: fakeDocker('', { runExit: 125 }), log: () => {} }), 1);
  assert.equal(await checkScanLimits({ docker: fakeDocker('4294967296\n'), log: () => {} }), 1, 'a short answer');
});
