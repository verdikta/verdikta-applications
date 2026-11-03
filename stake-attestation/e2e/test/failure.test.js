// Acceptance 3 and "failure is loud": the round broken on purpose. Each case runs the real script and
// reads its real exit code. It must fail, name why, and leave nothing behind: no process it started,
// no container, no image of the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-failure-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runRound(name, env = {}, { onLine } = {}) {
  const reportFile = path.join(tmp, `${name}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/round.js', '--report', reportFile], {
      cwd: E2E,
      env: { ...process.env, SA_E2E_LOG_DIR: path.join(tmp, `${name}-logs`), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const seen = (chunk) => {
      out += chunk;
      if (onLine) onLine(String(chunk), child);
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
      resolve({ code, signal, out, report });
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertNothingLeft(report, out) {
  const instance = report?.instance ?? /instance (sae2e[0-9a-f]+)/.exec(out)?.[1];
  assert.ok(instance, `the run named its instance: ${out.slice(-500)}`);
  const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } });
  const containers = docker('ps', '--all', '--format', '{{.Names}}\t{{.Image}}\t{{.Labels}}').stdout.split('\n').filter((l) => l.includes(instance));
  assert.deepEqual(containers, [], 'no container of the run');
  const images = docker('image', 'ls', '--format', '{{.Repository}}').stdout.split('\n').filter((l) => l.includes(`/${instance}/`));
  assert.deepEqual(images, [], 'no image of the run');
  for (const { name, pid } of report?.pids ?? []) assert.equal(alive(pid), false, `${name} (${pid}) is still running`);
}

test('a service that will not start is a failure, not a skip: the code runner refuses its config', async () => {
  const r = await runRound('runner-start', { SA_E2E_BREAK: 'runner-start' });
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.equal(r.report.ok, false);
  assert.match(r.report.failure, /code-runner/);
  assert.match(r.out, /FAILED/);
  assertNothingLeft(r.report, r.out);
});

test('a claim that should be judged and is abstained on fails the round: an abstention never passes as a settled claim', async () => {
  const r = await runRound('valid-claim-abstains', { SA_E2E_BREAK: 'valid-claim-abstains' });
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.equal(r.report.ok, false);
  assert.match(r.report.failure, /^valid\.round\.fulfilled/, r.report.failure);
  assert.ok(!r.report.checks.some((c) => c.name.startsWith('valid.settled')), 'nothing past it ran');
  assertNothingLeft(r.report, r.out);
});

test('stopped by a signal, it stops everything it started, and the exit code says so', async () => {
  let sent = false;
  const r = await runRound('signal', {}, {
    onLine: (line, child) => {
      if (!sent && line.includes('services up')) {
        sent = true;
        child.kill('SIGTERM');
      }
    },
  });
  assert.equal(sent, true, r.out.slice(-1500));
  assert.equal(r.code, 143, r.out.slice(-1500));
  assert.equal(r.report.signal, 'SIGTERM');
  assert.ok(r.report.pids.length >= 4, JSON.stringify(r.report.pids));
  assertNothingLeft(r.report, r.out);
});

test('where CI requires the class platform, any other host is a failure', { skip: os.arch() === 'x64' ? 'this host is the class platform' : false }, async () => {
  const r = await runRound('class-platform', { SA_E2E_REQUIRE_CLASS_PLATFORM: '1' });
  assert.equal(r.code, 1);
  assert.match(r.report.failure, /refuses the local report substitution/);
});
