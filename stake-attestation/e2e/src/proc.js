// Child processes of a round. Each is the leader of its own process group, with its output in a file
// and a tail for the failure message, so closing it reaches everything it started. Whatever else
// happens, a process that exits takes them down with it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const running = new Set();
process.on('exit', () => {
  for (const child of running) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* gone */ }
  }
});

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A long-running service. @returns {{ name, pid, tail(), exited(), close(), log }} */
export function launch(name, argv, { cwd, env, logDir }) {
  const file = path.join(logDir, `${name}.log`);
  const out = fs.openSync(file, 'a');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  running.add(child);
  let ended = null;
  child.once('exit', (code, signal) => {
    ended = { code, signal };
    running.delete(child);
  });
  child.once('error', (err) => {
    ended = { code: null, signal: err.message };
    running.delete(child);
  });
  const close = () => new Promise((resolve) => {
    if (ended || !child.pid) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return resolve();
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch { /* gone */ }
      setTimeout(done, 500);
    }, 8000).unref();
    return undefined;
  });
  const tail = () => {
    try {
      return fs.readFileSync(file, 'utf8').slice(-6000);
    } catch {
      return '';
    }
  };
  return { name, pid: child.pid, tail, exited: () => ended, close, log: file };
}

/** Polls until `ready()` gives something true, the process died, or time runs out; each says which. */
export async function waitUntil(what, ready, { timeoutMs, everyMs = 250, proc = null }) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    if (proc?.exited()) throw new Error(`${proc.name} exited ${JSON.stringify(proc.exited())} while ${what}:\n${proc.tail()}`);
    try {
      const v = await ready();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms ${what}${last ? ` (${last.message})` : ''}${proc ? `:\n${proc.tail()}` : ''}`);
    await sleep(everyMs);
  }
}

/**
 * What a killed service left running. The server runs each builder step in a process group of its own,
 * so stopping the server does not reach it. Everything of a run names the run's folder or its instance.
 * @param {string[]} marks
 * @returns {number[]} the pids signalled
 */
export function killProcessesNaming(marks) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const pids = (ps.stdout ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => marks.some((m) => line.includes(m)))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* gone */ }
  }
  return pids;
}

/** A command that must succeed; its output is the error when it does not. */
export function must(cmd, args, { cwd, env, timeout = 900000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal ?? r.error?.message} in ${cwd ?? process.cwd()}: ${(r.stderr || r.stdout || '').slice(-3000)}`);
  return r.stdout;
}

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'maker',
      GIT_AUTHOR_EMAIL: 'maker@verdikta.invalid',
      GIT_COMMITTER_NAME: 'maker',
      GIT_COMMITTER_EMAIL: 'maker@verdikta.invalid',
      GIT_AUTHOR_DATE: '1767225600 +0000',
      GIT_COMMITTER_DATE: '1767225600 +0000',
    },
  }).trim();
}
