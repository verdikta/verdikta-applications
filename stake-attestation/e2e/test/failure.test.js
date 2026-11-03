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

const logRoot = (name) => path.join(tmp, `${name}-logs`);

function runRound(name, env = {}, { onLine } = {}) {
  const reportFile = path.join(tmp, `${name}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/round.js', '--report', reportFile], {
      cwd: E2E,
      env: { ...process.env, SA_E2E_LOG_DIR: logRoot(name), ...env },
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

/** Lines of `ps` that name the run: the run's folder or its instance, whatever process group they are in. */
function processesNaming(...marks) {
  const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return ps.stdout.split('\n').filter((l) => marks.some((m) => m && l.includes(m)));
}

function assertNothingLeft(report, out) {
  const instance = report?.instance ?? /instance (sae2e[0-9a-f]+)/.exec(out)?.[1];
  assert.ok(instance, `the run named its instance: ${out.slice(-500)}`);
  const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } });
  const containers = docker('ps', '--all', '--format', '{{.Names}}\t{{.Image}}\t{{.Labels}}').stdout.split('\n').filter((l) => l.includes(instance));
  assert.deepEqual(containers, [], 'no container of the run');
  const images = docker('image', 'ls', '--format', '{{.Repository}}').stdout.split('\n').filter((l) => l.includes(`/${instance}/`));
  assert.deepEqual(images, [], 'no image of the run');
  for (const { name, pid } of report?.pids ?? []) {
    assert.equal(alive(pid), false, `${name} (${pid}) is still running`);
    assert.equal(alive(-pid), false, `${name}'s process group (${pid}) still has members`);
  }
  assert.deepEqual(processesNaming(instance, report?.workDir), [], 'no process names the run');
  if (report?.workDir) assert.equal(fs.existsSync(report.workDir), false, 'its folder is gone');
}

test('a service that will not start is a failure, not a skip: the code runner refuses its config', async () => {
  // A log directory someone named may hold anything: the run adds its own folder and removes nothing.
  fs.mkdirSync(logRoot('runner-start'), { recursive: true });
  const kept = path.join(logRoot('runner-start'), 'not-the-rounds.txt');
  fs.writeFileSync(kept, 'kept');
  const r = await runRound('runner-start', { SA_E2E_BREAK: 'runner-start' });
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.equal(r.report.ok, false);
  assert.match(r.report.failure, /code-runner/);
  assert.match(r.out, /FAILED/);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'kept');
  assert.equal(path.dirname(r.report.logDir), logRoot('runner-start'));
  assert.ok(fs.existsSync(path.join(r.report.logDir, 'code-runner.log')));
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

const dockerNames = () => spawnSync('docker', ['ps', '--all', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } }).stdout.split('\n');

/** The late step's child, however the run ended: its group is its own. */
async function endOfLateStep(lateStep, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (alive(-lateStep.pid) && Date.now() < until) await new Promise((r) => { setTimeout(r, 250); });
  return !alive(-lateStep.pid);
}

test('stopped while a startup step is under way, what that step creates just after the signal is stopped too (R4-F1)', async () => {
  // The step is apart from the round and names nothing of the run, so no sweep can stop it: it creates its
  // container seconds after the signal. A sweep made once, at the signal, has long finished by then.
  const r = await runRound('signal-in-start', { SA_E2E_BREAK: 'signal-in-start', SA_E2E_LATE_SECONDS: '6' });
  const late = r.report?.lateStep;
  try {
    assert.ok(late, r.out.slice(-1500));
    assert.equal(r.code, 143, r.out.slice(-1500));
    assert.equal(r.report.signal, 'SIGTERM');
    assert.ok(await endOfLateStep(late), 'the late step ended');
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    assert.ok(!dockerNames().includes(late.name), `${late.name} was created after the sweep and left behind`);
    assert.ok(!r.report.checks.some((c) => c.name === 'registry.up'), 'and no later step of the startup ran');
    assertNothingLeft(r.report, r.out);
  } finally {
    if (late) spawnSync('docker', ['rm', '--force', '--volumes', late.name], { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } });
  }
});

test('a startup step that outlasts the bound fails the run, by name, and the sweep still runs', async () => {
  const r = await runRound('signal-past-bound', { SA_E2E_BREAK: 'signal-in-start', SA_E2E_LATE_SECONDS: '60', SA_E2E_STOP_BOUND_MS: '2000' });
  const late = r.report?.lateStep;
  try {
    assert.ok(late, r.out.slice(-1500));
    assert.equal(r.code, 143, r.out.slice(-1500));
    assert.equal(r.report.ok, false);
    assert.match(r.report.failure, /had not stopped/);
    assert.ok(r.report.cleanupFailures.some((f) => /had not stopped/.test(f)), JSON.stringify(r.report.cleanupFailures));
    assert.deepEqual(r.report.leftovers, { containers: [], images: [] }, 'the sweep ran');
    assert.ok(alive(-late.pid), 'the step really was still out');
  } finally {
    if (late && alive(-late.pid)) process.kill(-late.pid, 'SIGKILL');
  }
});

test('a signal somewhere in the real startup, and another while it stops: one exit, its own code, nothing left', async () => {
  let timer = null;
  const r = await runRound('signal-twice', {}, {
    onLine: (line, child) => {
      if (!timer && line.includes('[round] start')) {
        timer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGTERM'), 300);
        }, 2500);
      }
    },
  });
  assert.ok(timer, r.out.slice(-1500));
  assert.equal(r.code, 143, r.out.slice(-1500));
  assert.equal(r.report.signal, 'SIGTERM');
  assertNothingLeft(r.report, r.out);
});

test('stopped in the middle of a build, it stops the builder too, though the builder has a process group of its own', async () => {
  let timer = null;
  const r = await runRound('signal-in-build', {}, {
    onLine: (line, child) => {
      if (!timer && line.includes('[round] list')) timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    },
  });
  assert.ok(timer, r.out.slice(-1500));
  assert.equal(r.code, 143, r.out.slice(-1500));
  assert.equal(r.report.signal, 'SIGTERM');
  assertNothingLeft(r.report, r.out);
});

test('stopped in the middle of the baseline scan, it stops the scanner, whose container names nothing of the run but its process does', async () => {
  const r = await runRound('signal-in-scan', { SA_E2E_BREAK: 'signal-in-scan' });
  assert.equal(r.code, 143, r.out.slice(-1500));
  assert.equal(r.report.signal, 'SIGTERM');
  assert.ok(r.report.stopped.groups.length >= 1, 'the builder step\'s own group was found and stopped');
  assertNothingLeft(r.report, r.out);
  const names = spawnSync('docker', ['ps', '--all', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } }).stdout.split('\n');
  for (const name of r.report.stopped.containers) assert.ok(!names.includes(name), `${name} is still there`);
});

test('stopped with EA requests out, it ends them and does not wait for them', async () => {
  let at = null;
  const r = await runRound('signal-in-round', {}, {
    onLine: (line, child) => {
      // The first reveal that goes through. The bridge sees it within a poll, and the sandbox takes seconds.
      if (!at && line.includes('verdikta-attest reveal -> exit 0')) {
        at = Date.now();
        setTimeout(() => child.kill('SIGTERM'), 2000);
      }
    },
  });
  assert.ok(at, r.out.slice(-1500));
  assert.equal(r.code, 143, r.out.slice(-1500));
  assert.ok(r.report.cancelledJobs >= 1, `${r.report.cancelledJobs} EA request(s) cut off`);
  assert.ok(Date.now() - at < 120000, `${Date.now() - at} ms to stop`);
  assertNothingLeft(r.report, r.out);
});

test('where CI requires the class platform, any other host is a failure', { skip: os.arch() === 'x64' ? 'this host is the class platform' : false }, async () => {
  const r = await runRound('class-platform', { SA_E2E_REQUIRE_CLASS_PLATFORM: '1' });
  assert.equal(r.code, 1);
  assert.match(r.report.failure, /refuses the local report substitution/);
});
