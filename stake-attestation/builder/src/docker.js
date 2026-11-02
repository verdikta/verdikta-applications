// The docker CLI, and the one way the builder runs an image.
//
// The builder spawns only the docker CLI and git (src/proc.js), with argv arrays. The CLI gets an
// allow-listed environment: the daemon's address and the operator's docker config (for the push
// credentials), never the signing key, the runner's token or an explorer key. The maker's code
// runs in two places only: the setup stage of `docker build` (the one with network) and
// sandboxRunArgs below, which has none.
import crypto from 'node:crypto';

import { run } from './proc.js';

const ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'TMPDIR', 'XDG_RUNTIME_DIR']);

/** The sandbox user, as the code-runner runs every step (code-runner/README.md, Isolation). */
export const SANDBOX_USER = '10001:10001';

/**
 * The docker CLI's environment: the allow-listed variables of `base`, BuildKit on.
 * @param {Record<string,string|undefined>} [base]
 * @param {{ host?: string|null }} [o]
 */
export function dockerEnv(base = process.env, { host = null } = {}) {
  const env = {};
  for (const k of ENV_ALLOW) if (typeof base[k] === 'string') env[k] = base[k];
  if (host) env.DOCKER_HOST = host;
  env.DOCKER_BUILDKIT = '1';
  return env;
}

/**
 * @param {{ bin?: string, host?: string|null, baseEnv?: object }} [o]
 * @returns {{ run(args: string[], opts?: { timeoutMs?: number, stdin?: Buffer|string, maxBytes?: number }): Promise<object> }}
 */
export function createDocker({ bin = 'docker', host = null, baseEnv = process.env } = {}) {
  const env = dockerEnv(baseEnv, { host });
  return {
    run(args, { timeoutMs = 120000, stdin = null, maxBytes } = {}) {
      return run(bin, args, { env, timeoutMs, stdin, maxBytes });
    },
  };
}

/**
 * The argv of every `docker run` the builder makes of an env image: the code-runner's sandbox
 * flags (no network, read-only root, no capabilities, no new privileges, uid 10001, tmpfs scratch
 * for the work tree, $HOME and /tmp, the class's cpus, memory and pids), never pulling.
 * @param {object} o
 * @param {string} o.image
 * @param {string} o.platform
 * @param {string} o.name
 * @param {string} o.label
 * @param {string[]} o.argv - the program and its arguments
 */
export function sandboxRunArgs({ image, platform, name, label, argv, cpus = 2, memoryMb = 4096, pids = 4096 }) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('argv is required');
  return [
    'run', '--rm', '--pull', 'never', '--platform', platform,
    '--name', name, '--label', label,
    '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--ipc', 'none',
    '--user', SANDBOX_USER,
    '--pids-limit', String(pids), '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`, '--cpus', String(cpus),
    '--tmpfs', '/work:rw,exec,nosuid,nodev,size=1024m,mode=0755,uid=10001,gid=10001',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777',
    '--tmpfs', '/home/sandbox:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001',
    '--env', 'HOME=/home/sandbox', '--env', 'TZ=UTC', '--env', 'LANG=C.UTF-8', '--env', 'CI=true',
    '--workdir', '/work', '--init',
    '--entrypoint', '/usr/bin/env',
    image,
    ...argv,
  ];
}

/**
 * Runs `argv` in a fresh sandboxed container of `image` and removes it, whatever happened.
 * @returns {Promise<{exitCode:number|null, stdout:Buffer, stderr:Buffer, stdoutTruncated:boolean, timedOut:boolean, spawnError:string|null}>}
 */
export async function runSandboxed({ docker, image, platform, argv, timeoutMs, maxBytes, cpus, memoryMb }) {
  const name = `vab-${crypto.randomBytes(6).toString('hex')}`;
  try {
    return await docker.run(sandboxRunArgs({ image, platform, name, label: 'io.verdikta.builder=1', argv, cpus, memoryMb }), { timeoutMs, maxBytes });
  } finally {
    await docker.run(['rm', '--force', '--volumes', name], { timeoutMs: 60000 });
  }
}
