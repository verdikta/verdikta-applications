// The one place the builder starts processes: an argv array, never a shell, an explicit
// environment, a timeout that kills, and capped output.
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const GROUP_CLOSE_WAIT_MS = 2000;
// The leaders of the process groups running now (`group: true`).
const groups = new Set();

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* the group has gone */
  }
}

/** Stops every process group `run` started and still runs: for a process that is told to stop. */
export function killRunningGroups() {
  for (const pid of groups) killGroup(pid);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} o
 * @param {Record<string,string>} o.env - the child's whole environment
 * @param {number} o.timeoutMs
 * @param {Buffer|string} [o.stdin]
 * @param {number} [o.maxBytes] - per stream; the rest is dropped and flagged
 * @param {string} [o.cwd]
 * @param {AbortSignal} [o.signal] - stops the child with SIGKILL, as the timeout does
 * @param {boolean} [o.group] - run the child as the leader of its own process group, so a stop
 *   reaches everything it started (git's transport and pack processes write on after git itself is
 *   killed, and hold its pipes); whatever is left of the group when the child ends is killed too
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:Buffer, stderr:Buffer, stdoutTruncated:boolean, stderrTruncated:boolean, timedOut:boolean, spawnError:string|null}>}
 */
export function run(cmd, args, { env, timeoutMs, stdin = null, maxBytes = DEFAULT_MAX_BYTES, cwd, signal: stop = null, group = false } = {}) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new TypeError('args must be an array of strings');
  if (!env || typeof env !== 'object') throw new TypeError('env is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs is required');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: group });
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, timedOut: false, spawnError: err.message });
      return;
    }
    const out = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
    const collect = (name) => (chunk) => {
      const room = maxBytes - out[`${name}Bytes`];
      if (room <= 0) {
        out[`${name}Truncated`] = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) out[`${name}Truncated`] = true;
      out[name].push(part);
      out[`${name}Bytes`] += part.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    let timedOut = false;
    let spawnError = null;
    if (group && child.pid) groups.add(child.pid);
    let closeWait = null;
    const kill = () => {
      if (!group || !child.pid) {
        child.kill('SIGKILL');
        return;
      }
      killGroup(child.pid);
      // something outside the group may still hold the pipes: stop waiting for it
      closeWait ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, GROUP_CLOSE_WAIT_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onStop = kill;
    if (stop) {
      if (stop.aborted) onStop();
      else stop.addEventListener('abort', onStop, { once: true });
    }
    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.stdin.on('error', () => {});
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (closeWait) clearTimeout(closeWait);
      stop?.removeEventListener('abort', onStop);
      if (group && child.pid) {
        killGroup(child.pid);
        groups.delete(child.pid);
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out.stdout),
        stderr: Buffer.concat(out.stderr),
        stdoutTruncated: out.stdoutTruncated,
        stderrTruncated: out.stderrTruncated,
        timedOut,
        spawnError,
      });
    });
  });
}

/** The last `bytes` of a buffer or string as text, marked when cut. */
export function tail(value, bytes = 32 * 1024) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length <= bytes) return buf.toString('utf8');
  return `[… ${buf.length - bytes} bytes cut]\n${buf.subarray(buf.length - bytes).toString('utf8')}`;
}
