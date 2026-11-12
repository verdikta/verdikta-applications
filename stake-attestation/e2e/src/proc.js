// Child processes of a round. Each is the leader of its own process group, with its output in a file
// and a tail for the failure message, so closing it reaches everything it started. Whatever else
// happens, a process that exits takes them down with it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// The stop flag. A signal sets it, and whatever is waiting gives up: a waitUntil at its next look or
// its read in hand, a tool run, whatever asked with onStop. What cannot be interrupted, such as an A6a
// starter on its way to creating something, is left to finish, because then it gets its closer.
export class RoundStopped extends Error {
  constructor() {
    super('the round is stopping');
    this.name = 'RoundStopped';
  }
}

let stopping = false;
const stopListeners = new Set();
export const isStopping = () => stopping;

export function requestStop() {
  if (stopping) return;
  stopping = true;
  for (const fn of [...stopListeners]) fn();
  stopListeners.clear();
}

/** Calls `fn` when the stop comes, or at once if it has. @returns {() => void} takes it off again */
export function onStop(fn) {
  if (stopping) {
    fn();
    return () => {};
  }
  stopListeners.add(fn);
  return () => stopListeners.delete(fn);
}

export function throwIfStopping() {
  if (stopping) throw new RoundStopped();
}

/**
 * The promise, or a RoundStopped as soon as the round is stopping: for what would only be waited on, a
 * read or a receipt, which starts nothing. Never for a step that creates something: that one is
 * awaited to its end so that it gets its closer.
 */
export function unlessStopped(promise) {
  // the answer that loses the race still has a handler
  Promise.resolve(promise).catch(() => {});
  if (stopping) return Promise.reject(new RoundStopped());
  let off = () => {};
  const stopped = new Promise((_, reject) => { off = onStop(() => reject(new RoundStopped())); });
  return Promise.race([promise, stopped]).finally(off);
}

/** The promise, or a rejection naming `what` when `ms` run out. */
export function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms} ms`)), ms);
  });
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Every process group this run started, by its id, whoever started it (noteGroup): a leader's death does not end
// its group, so a group is only over when it has no members. Forgotten once it is seen empty, so a later use of the
// number is never taken for it.
const startedGroups = new Set();
process.on('exit', () => {
  for (const pgid of startedGroups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch { /* gone */ }
  }
});

/** A process group this run started. @param {number} pgid - its leader's pid */
export function noteGroup(pgid) {
  startedGroups.add(pgid);
}

/** A group whose leader exited and which is empty is over. */
export function noteLeaderExit(pgid) {
  if (!groupAlive(pgid)) startedGroups.delete(pgid);
}

/** The groups this run started that still have members. */
export const liveGroups = () => [...startedGroups].filter(groupAlive);

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

/** Whether a process group still has members. */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Stops process groups by id, whether or not their leaders are still there: SIGTERM, up to `graceMs`, then SIGKILL.
 * @param {number[]} pgids
 * @returns {Promise<{ stopped: number[], alive: number[] }>} those that had members, and those that still do
 */
export async function stopProcessGroups(pgids, { graceMs = 8000, killMs = 2000 } = {}) {
  const stopped = pgids.filter(groupAlive);
  const signalAll = (signal) => {
    for (const pgid of stopped) {
      try {
        process.kill(-pgid, signal);
      } catch { /* gone */ }
    }
  };
  const until = async (ms) => {
    const end = Date.now() + ms;
    while (stopped.some(groupAlive) && Date.now() < end) await sleep(50);
  };
  signalAll('SIGTERM');
  await until(graceMs);
  if (stopped.some(groupAlive)) {
    signalAll('SIGKILL');
    await until(killMs);
  }
  for (const pgid of pgids) noteLeaderExit(pgid);
  return { stopped, alive: stopped.filter(groupAlive) };
}

/** A long-running service. @returns {{ name, pid, tail(), exited(), close(), log }} */
export function launch(name, argv, { cwd, env, logDir }) {
  const file = path.join(logDir, `${name}.log`);
  const out = fs.openSync(file, 'a');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  if (child.pid) noteGroup(child.pid);
  let ended = null;
  child.once('exit', (code, signal) => {
    ended = { code, signal };
    if (child.pid) noteLeaderExit(child.pid);
  });
  child.once('error', (err) => {
    ended = { code: null, signal: err.message };
  });
  // Its group, not its leader: a leader that died can have left the rest running.
  const close = async () => {
    if (child.pid) await stopProcessGroups([child.pid]);
  };
  const tail = () => {
    try {
      return fs.readFileSync(file, 'utf8').slice(-6000);
    } catch {
      return '';
    }
  };
  return { name, pid: child.pid, tail, exited: () => ended, close, log: file };
}

/** Polls until `ready()` gives something true, the process died, the round is stopping, or time runs out; each says which. */
export async function waitUntil(what, ready, { timeoutMs, everyMs = 250, proc = null }) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    throwIfStopping();
    if (proc?.exited()) throw new Error(`${proc.name} exited ${JSON.stringify(proc.exited())} while ${what}:\n${proc.tail()}`);
    try {
      const v = await unlessStopped(ready());
      if (v) return v;
    } catch (err) {
      if (err instanceof RoundStopped) throw err;
      last = err;
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms ${what}${last ? ` (${last.message})` : ''}${proc ? `:\n${proc.tail()}` : ''}`);
    await sleep(everyMs);
  }
}

function processTable() {
  const ps = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (ps.status !== 0) throw new Error(`ps exited ${ps.status ?? ps.signal ?? ps.error?.message}`);
  return ps.stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
}

const signalled = (id, signal) => {
  try {
    process.kill(id, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * What a stopped service left running. The server runs each builder step in a process group of its own,
 * so stopping the server does not reach it. Such a step names the run's folder or instance, its docker
 * CLI children are in its group, and they name the scanners' and sandboxes' containers (vab-<random>, with
 * a generic label, on a daemon other runs share): read here, before anything is stopped, so those and
 * no others are removed. Children of this process (the tool) are in its own group, and go one by one.
 * @param {string[]} marks - text only this run's processes carry
 * @param {object} [o]
 * @param {string[]} [o.except] - a command line holding one of these is not the run's: someone's tail of its logs
 * @param {number} [o.graceMs]
 * @returns {Promise<{ groups: number[], singles: number[], containers: string[] }>}
 */
export async function stopProcessesNaming(marks, { except = [], graceMs = 10000 } = {}) {
  const table = processTable();
  const ownGroup = table.find((r) => r.pid === process.pid)?.pgid;
  const hits = table.filter((r) => r.pid !== process.pid && marks.some((m) => r.command.includes(m)) && !except.some((e) => r.command.includes(e)));
  const groups = [...new Set(hits.map((r) => r.pgid))].filter((g) => g !== ownGroup);
  const singles = hits.filter((r) => r.pgid === ownGroup).map((r) => r.pid);
  const members = table.filter((r) => groups.includes(r.pgid));
  const containers = [...new Set([...hits, ...members].map((r) => /--name (vab-[0-9a-f]+)/.exec(r.command)?.[1]).filter(Boolean))];
  // SIGTERM first: the docker CLI passes it to the container it is attached to.
  for (const g of groups) signalled(-g, 'SIGTERM');
  for (const p of singles) signalled(p, 'SIGTERM');
  const until = Date.now() + graceMs;
  const alive = () => [...groups.map((g) => -g), ...singles].filter((id) => signalled(id, 0));
  while (alive().length && Date.now() < until) await sleep(100);
  for (const id of alive()) signalled(id, 'SIGKILL');
  return { groups, singles, containers };
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
