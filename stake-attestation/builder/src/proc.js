// The one place the builder starts processes: an argv array, never a shell, an explicit
// environment, a timeout that kills, and capped output.
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} o
 * @param {Record<string,string>} o.env - the child's whole environment
 * @param {number} o.timeoutMs
 * @param {Buffer|string} [o.stdin]
 * @param {number} [o.maxBytes] - per stream; the rest is dropped and flagged
 * @param {string} [o.cwd]
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:Buffer, stderr:Buffer, stdoutTruncated:boolean, stderrTruncated:boolean, timedOut:boolean, spawnError:string|null}>}
 */
export function run(cmd, args, { env, timeoutMs, stdin = null, maxBytes = DEFAULT_MAX_BYTES, cwd } = {}) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new TypeError('args must be an array of strings');
  if (!env || typeof env !== 'object') throw new TypeError('env is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs is required');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.stdin.on('error', () => {});
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
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
