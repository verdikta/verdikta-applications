// The builder's configuration (a JSON file; see the app README, "The environment builder").
//
// Secrets are never values in it. The code-runner's token and an explorer's API key are named by
// where they live (an environment variable or a file) and read only when used; the signing key
// is named the same way (src/signing.js). The parsed config can therefore be logged or written
// whole without leaking anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_GIT_HOSTS } from '@verdikta/stake-attestation-shared/control-proof';

import { AGENT_ENDPOINTS } from './agent.js';
import { codeReview } from './common.js';
import { BuilderError } from './errors.js';
import { imageLimits } from './image.js';
import { isLoopbackHost } from './net.js';

export const PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
// A registry host and a repository path, as attestation.v1.json's image pattern accepts them.
const REPOSITORY = new RegExp(`^(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)+|localhost)(?::[0-9]{1,5})?/${COMPONENT}(?:/${COMPONENT})*$`);
const MAX_DEADLINE_MS = 900000;

function fail(detail) {
  throw new BuilderError('CONFIG_INVALID', detail);
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function keys(obj, allowed, where) {
  if (!isObject(obj)) fail(`${where} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where} has an unknown key "${k}"`);
}

/** An http(s) URL: https anywhere, plain http only to a loopback host. */
function serviceUrl(value, where) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(`${where} is not a URL`);
  }
  if (u.username || u.password) fail(`${where} must not carry credentials`);
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return u;
  fail(`${where} must be https (plain http only to a loopback address)`);
  return u;
}

function envName(value, where) {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) fail(`${where} must be an environment variable name`);
  return value;
}

function platform(value, where) {
  if (!PLATFORMS.includes(value)) fail(`${where} must be a platform the builder knows: ${PLATFORMS.join(', ')}`);
  return value;
}

/** The secret behind a token source: a file (a mounted secret) or an environment variable. */
function secretReader({ file, envVar }, env, what) {
  return () => {
    let value;
    if (file) {
      try {
        value = fs.readFileSync(file, 'utf8');
      } catch {
        throw new BuilderError('SECRET_UNAVAILABLE', `${what}: the file ${file} cannot be read`);
      }
    } else {
      value = env[envVar];
      if (typeof value !== 'string') throw new BuilderError('SECRET_UNAVAILABLE', `${what}: the environment variable ${envVar} is not set`);
    }
    value = value.trim();
    if (!value) throw new BuilderError('SECRET_UNAVAILABLE', `${what} is empty`);
    return value;
  };
}

function parseSigningKey(key) {
  if (key === undefined || key === 'dev') return 'dev';
  if (!isObject(key)) fail('signing.key must be "dev", { env } or { command, publicKey, env? }');
  if (Object.hasOwn(key, 'env') && !Object.hasOwn(key, 'command')) {
    keys(key, ['env'], 'signing.key');
    return Object.freeze({ env: envName(key.env, 'signing.key.env') });
  }
  if (Object.hasOwn(key, 'command')) {
    keys(key, ['command', 'publicKey', 'env'], 'signing.key');
    if (!Array.isArray(key.command) || key.command.length === 0 || !key.command.every((a) => typeof a === 'string' && a.length > 0)) {
      fail('signing.key.command must be the signer\'s argv, an array of strings');
    }
    if (typeof key.publicKey !== 'string') fail('signing.key.publicKey must be the signer\'s Ed25519 public key (base64 of its 32 raw bytes)');
    const passEnv = key.env === undefined ? [] : key.env;
    if (!Array.isArray(passEnv)) fail('signing.key.env must be a list of environment variable names for the signer');
    passEnv.forEach((n, i) => envName(n, `signing.key.env[${i}]`));
    return Object.freeze({ command: Object.freeze([...key.command]), publicKey: key.publicKey, env: Object.freeze([...passEnv]) });
  }
  fail('signing.key must be "dev", { env } or { command, publicKey, env? }');
  return null;
}

/**
 * The baseline scan's settings: the agent pass's model (src/agent.js), used only with --agent.
 * The token is named by its environment variable and read when the pass runs.
 */
function parseScan(raw, env) {
  if (raw === undefined) return Object.freeze({ agent: null });
  keys(raw, ['agent'], 'scan');
  if (raw.agent === undefined) return Object.freeze({ agent: null });
  const a = raw.agent;
  keys(a, ['provider', 'model', 'apiUrl', 'apiKeyEnv', 'maxSourceBytes', 'maxOutputTokens', 'timeoutSeconds'], 'scan.agent');
  const pool = codeReview.CODE_CLASSES['code-standard'].models;
  if (!pool.some((m) => m.provider === a.provider && m.model === a.model)) {
    fail(`scan.agent must name a model of the code-standard pool as { provider, model }: ${pool.map((m) => `${m.provider} ${m.model}`).join(', ')}`);
  }
  if (!Object.hasOwn(AGENT_ENDPOINTS, a.provider)) {
    fail(`scan.agent.provider must serve a chat-completions API (${Object.keys(AGENT_ENDPOINTS).join(', ')}); ${a.provider} models are not supported by the agent pass`);
  }
  const apiUrl = a.apiUrl === undefined ? AGENT_ENDPOINTS[a.provider] : serviceUrl(a.apiUrl, 'scan.agent.apiUrl').href;
  const apiKeyEnv = envName(a.apiKeyEnv, 'scan.agent.apiKeyEnv');
  const int = (v, def, min, max, where) => {
    const n = v === undefined ? def : v;
    if (!Number.isInteger(n) || n < min || n > max) fail(`${where} must be an integer from ${min} to ${max}`);
    return n;
  };
  return Object.freeze({
    agent: Object.freeze({
      provider: a.provider,
      model: a.model,
      apiUrl,
      apiKeyEnv,
      maxSourceBytes: int(a.maxSourceBytes, 300000, 1000, 2000000, 'scan.agent.maxSourceBytes'),
      maxOutputTokens: int(a.maxOutputTokens, 4000, 256, 32000, 'scan.agent.maxOutputTokens'),
      timeoutMs: int(a.timeoutSeconds, 180, 10, 900, 'scan.agent.timeoutSeconds') * 1000,
      apiKey: () => {
        const v = env[apiKeyEnv];
        if (typeof v !== 'string' || !v.trim()) throw new BuilderError('SECRET_UNAVAILABLE', `the agent pass's token: the environment variable ${apiKeyEnv} is not set`);
        return v.trim();
      },
    }),
  });
}

/**
 * @param {object} raw - the parsed JSON
 * @param {{ baseDir: string, env?: Record<string,string|undefined> }} o - paths resolve against baseDir;
 *   secrets are read from env when used
 */
export function parseConfig(raw, { baseDir, env = process.env } = {}) {
  keys(raw, ['registry', 'runner', 'explorers', 'solc', 'signing', 'platforms', 'limits', 'repoMirrors', 'workDir', 'docker', 'scan', 'control'], 'the config');
  const resolve = (p) => path.resolve(baseDir, p);

  // registry: where the build pushes and reads the image; `publishAs`, when set, is the repository
  // code_review.json names instead, the same digest copied there byte for byte by a later step
  // (the reusable workflow's publish job), so the build itself needs no registry credential.
  keys(raw.registry, ['repository', 'apiUrl', 'publishAs'], 'registry');
  const repository = raw.registry.repository;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    fail('registry.repository must be a lowercase image repository with its registry host and no tag or digest, e.g. ghcr.io/verdikta/stake-env');
  }
  const publishAs = raw.registry.publishAs === undefined ? null : raw.registry.publishAs;
  if (publishAs !== null && (typeof publishAs !== 'string' || !REPOSITORY.test(publishAs))) {
    fail('registry.publishAs must be a lowercase image repository with its registry host and no tag or digest, e.g. ghcr.io/acme/stake-env');
  }
  const registry = Object.freeze({ repository, publishAs, apiUrl: raw.registry.apiUrl === undefined ? null : serviceUrl(raw.registry.apiUrl, 'registry.apiUrl').origin });

  // runner
  keys(raw.runner, ['url', 'socket', 'tokenFile', 'tokenEnv', 'deadlineMs'], 'runner');
  const r = raw.runner;
  if ((r.url === undefined) === (r.socket === undefined)) fail('runner needs exactly one of url and socket');
  if (r.url !== undefined) serviceUrl(r.url, 'runner.url');
  if (r.socket !== undefined && (typeof r.socket !== 'string' || !r.socket)) fail('runner.socket must be a path');
  if ((r.tokenFile === undefined) === (r.tokenEnv === undefined)) fail('runner needs exactly one of tokenFile and tokenEnv');
  if (r.tokenFile !== undefined && typeof r.tokenFile !== 'string') fail('runner.tokenFile must be a path');
  if (r.tokenEnv !== undefined) envName(r.tokenEnv, 'runner.tokenEnv');
  const deadlineMs = r.deadlineMs === undefined ? MAX_DEADLINE_MS : r.deadlineMs;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) fail(`runner.deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`);
  const runner = Object.freeze({
    url: r.url === undefined ? null : r.url,
    socket: r.socket === undefined ? null : resolve(r.socket),
    deadlineMs,
    token: secretReader({ file: r.tokenFile === undefined ? null : resolve(r.tokenFile), envVar: r.tokenEnv }, env, 'the code-runner token'),
  });

  // explorers, by chain id
  const explorers = new Map();
  if (raw.explorers !== undefined) {
    if (!isObject(raw.explorers)) fail('explorers must be an object keyed by chain id');
    for (const [id, e] of Object.entries(raw.explorers)) {
      if (!/^[1-9][0-9]{0,15}$/.test(id)) fail(`explorers: "${id}" is not a chain id`);
      keys(e, ['apiUrl', 'apiKeyEnv', 'timeoutMs'], `explorers.${id}`);
      const parsedUrl = serviceUrl(e.apiUrl, `explorers.${id}.apiUrl`);
      if (parsedUrl.search || parsedUrl.hash) fail(`explorers.${id}.apiUrl must have no query: the API key belongs in apiKeyEnv`);
      const apiUrl = parsedUrl.href;
      const apiKeyEnv = e.apiKeyEnv === undefined ? null : envName(e.apiKeyEnv, `explorers.${id}.apiKeyEnv`);
      const timeoutMs = e.timeoutMs === undefined ? 30000 : e.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail(`explorers.${id}.timeoutMs must be a positive integer`);
      explorers.set(Number(id), Object.freeze({
        apiUrl,
        apiKeyEnv,
        timeoutMs,
        apiKey: () => {
          if (!apiKeyEnv) return null;
          const v = env[apiKeyEnv];
          if (typeof v !== 'string' || !v.trim()) throw new BuilderError('SECRET_UNAVAILABLE', `the explorer API key: the environment variable ${apiKeyEnv} is not set`);
          return v.trim();
        },
      }));
    }
  }

  // signing
  if (raw.signing !== undefined) keys(raw.signing, ['key'], 'signing');
  const signing = Object.freeze({ key: parseSigningKey(raw.signing?.key) });

  // platforms
  const p = raw.platforms ?? {};
  keys(p, ['setup', 'run', 'extra'], 'platforms');
  const extra = p.extra ?? [];
  if (!Array.isArray(extra) || extra.some((x) => x === CLASS_PLATFORM || !PLATFORMS.includes(x)) || new Set(extra).size !== extra.length) {
    fail(`platforms.extra lists dev platforms beside the class's ${CLASS_PLATFORM}: ${PLATFORMS.filter((x) => x !== CLASS_PLATFORM).join(', ')}`);
  }
  const platforms = Object.freeze({
    setup: p.setup === undefined ? CLASS_PLATFORM : platform(p.setup, 'platforms.setup'),
    run: p.run === undefined ? CLASS_PLATFORM : platform(p.run, 'platforms.run'),
    extra: Object.freeze([...extra]),
  });

  // limits
  let limits;
  try {
    limits = imageLimits(raw.limits);
  } catch (err) {
    fail(err.message);
  }

  // mirrors
  const mirrors = new Map();
  if (raw.repoMirrors !== undefined) {
    if (!isObject(raw.repoMirrors)) fail('repoMirrors must be an object { "<https repository URL>": "<path or https URL>" }');
    for (const [url, source] of Object.entries(raw.repoMirrors)) {
      if (!/^https:\/\/\S+$/.test(url)) fail(`repoMirrors: "${url}" is not an https repository URL`);
      if (typeof source !== 'string' || !source) fail(`repoMirrors["${url}"] must be a path or an https URL`);
      mirrors.set(url, /^https:\/\//.test(source) ? source : resolve(source));
    }
  }

  // docker
  const d = raw.docker ?? {};
  keys(d, ['bin', 'host', 'buildTimeoutSeconds', 'pushTimeoutSeconds'], 'docker');
  const seconds = (v, def, where) => {
    const s = v === undefined ? def : v;
    if (!Number.isInteger(s) || s < 1) fail(`${where} must be a positive integer`);
    return s * 1000;
  };
  const docker = Object.freeze({
    bin: d.bin === undefined ? 'docker' : String(d.bin),
    host: d.host === undefined ? null : String(d.host),
    buildTimeoutMs: seconds(d.buildTimeoutSeconds, 1800, 'docker.buildTimeoutSeconds'),
    pushTimeoutMs: seconds(d.pushTimeoutSeconds, 900, 'docker.pushTimeoutSeconds'),
  });

  if (raw.workDir !== undefined && (typeof raw.workDir !== 'string' || !raw.workDir)) fail('workDir must be a path');
  const workDir = raw.workDir === undefined ? os.tmpdir() : resolve(raw.workDir);

  // solc: where the verified-source check gets the compiler it trusts
  const so = raw.solc ?? {};
  keys(so, ['baseUrl', 'cacheDir'], 'solc');
  const solcBase = so.baseUrl === undefined ? 'https://binaries.soliditylang.org' : serviceUrl(so.baseUrl, 'solc.baseUrl').href.replace(/\/+$/, '');
  if (so.cacheDir !== undefined && (typeof so.cacheDir !== 'string' || !so.cacheDir)) fail('solc.cacheDir must be a path');
  const solc = Object.freeze({ baseUrl: solcBase, cacheDir: so.cacheDir === undefined ? path.join(workDir, 'verdikta-builder-solc') : resolve(so.cacheDir) });

  const scan = parseScan(raw.scan, env);

  // control: the project's proof (src/listingProof.js): the hosts a listing's repository may be on,
  // the same list as the site's (SA_CONTROL_GIT_HOSTS), and the bounds on reading it
  const c = raw.control ?? {};
  keys(c, ['gitHosts', 'timeoutMs', 'maxBytes'], 'control');
  const gitHosts = c.gitHosts ?? DEFAULT_GIT_HOSTS;
  if (!Array.isArray(gitHosts) || gitHosts.length === 0 || !gitHosts.every((h) => typeof h === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/.test(h))) fail('control.gitHosts must list lowercase host names');
  const positive = (v, def, where) => {
    const n = v === undefined ? def : v;
    if (!Number.isInteger(n) || n < 1) fail(`${where} must be a positive integer`);
    return n;
  };
  const control = Object.freeze({ gitHosts: Object.freeze([...gitHosts]), timeoutMs: positive(c.timeoutMs, 120000, 'control.timeoutMs'), maxBytes: positive(c.maxBytes, 256 * 1024 * 1024, 'control.maxBytes') });

  return Object.freeze({
    registry,
    runner,
    scan,
    control,
    explorers,
    signing,
    platforms,
    limits,
    docker,
    solc,
    workDir,
    mirrorFor: (url) => mirrors.get(url) ?? null,
  });
}

/** Reads and parses a config file; its relative paths resolve against the file's folder. */
export function loadConfig(file, { env = process.env } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BuilderError('CONFIG_INVALID', `${file}: ${err.message}`);
  }
  return parseConfig(raw, { baseDir: path.dirname(path.resolve(file)), env });
}
