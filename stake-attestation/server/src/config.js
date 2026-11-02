// The server's configuration, from the environment only. A credential (a pinning token, an
// explorer key, the builder's signing key) is never a value here: the config names the variable
// it lives in, and only the code that uses it reads it, when it uses it. The parsed config can
// therefore be logged or returned whole.
//
//   PORT, HOST                     where the API listens (5009, 127.0.0.1)
//   SA_CHAIN_ID                    the chain the site lists on; dev trust is refused on Base (8453)
//   SA_ATTESTATION_TRUST           production (default): the builder's attestation must verify
//                                  under @verdikta/common's trusted-builder set, as the arbiters
//                                  check it; dev: a dev key the server's own signing step made
//   SA_PINNING                     mock | kubo | filebase | pinata (default mock, except in
//                                  production, where it is required and mock is refused)
//   SA_KUBO_API_URL                kubo's RPC API (http://127.0.0.1:5001)
//   SA_FILEBASE_RPC_URL            Filebase's IPFS RPC API (https://rpc.filebase.io); token: SA_FILEBASE_TOKEN
//   SA_PINATA_API_URL              Pinata's API (https://api.pinata.cloud); JWT: SA_PINATA_JWT
//   SA_PIN_TIMEOUT_MS              per upload (60000)
//   SA_BUILDER_BIN                 the builder's CLI (../builder/bin/verdikta-build-env.js)
//   SA_BUILDER_CONFIG              the builder's config file (builder.json); no build runs without it
//   SA_BUILDER_WORK_DIR            where each build's folder is made (the OS temp folder)
//   SA_BUILDER_BUILD_ENV           names of the variables `build` is given besides PATH and HOME
//                                  (DOCKER_HOST, the runner token's, the explorer key's, ...)
//   SA_BUILDER_SIGN_ENV            the same for `sign` (the signing key's variable, the KMS signer's)
//   SA_BUILDER_TIMEOUT_MS          per builder step (3600000)
//   SA_MAX_CONCURRENT_BUILDS       builds run at once (1)
//   SA_MAX_QUEUED_BUILDS           builds waiting before POST /api/listings answers 429 (8)
//   SA_ORACLE_MAX_FEE_WEI, SA_ORACLE_DISPUTE_MAX_FEE_WEI, SA_ORACLE_BASE_COST_WEI,
//   SA_ORACLE_ALPHA, SA_ORACLE_MAX_FEE_SCALING
//                                  the oracle parameters list() takes (design §10.8; the class is
//                                  common's code-standard, build plan A8)
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from './common.js';
import { BACKENDS } from './pinning/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAINNET_CHAIN_ID = 8453;
// The aggregator's registered-fee ceiling the contract checks the oracle fees against (§10.8).
const DEFAULT_ORACLE = Object.freeze({
  maxOracleFee: '120000000000000', // 0.00012 ETH per oracle: the code-standard claim panel
  disputeMaxOracleFee: '200000000000000', // 0.0002 ETH per oracle: the dispute panel
  estimatedBaseCost: '10000000000000', // 0.00001 ETH, as the bounty program's default
  alpha: '500',
  maxFeeBasedScaling: '3',
});

export class ConfigError extends Error {
  constructor(detail) {
    super(`CONFIG_INVALID: ${detail}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
  }
}

const fail = (detail) => { throw new ConfigError(detail); };

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(raw);
}

function wei(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^(0|[1-9][0-9]{0,77})$/.test(raw) || BigInt(raw) >= 1n << 256n) fail(`${name} must be a whole number of wei that fits in a uint256`);
  return raw;
}

/** https anywhere; plain http to a loopback host only. No credentials in the URL. */
function serviceUrl(env, name, fallback) {
  const raw = env[name] || fallback;
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`${name} is not a URL`);
  }
  if (u.username || u.password || u.search) fail(`${name} must carry no credentials or query: tokens are read from their own variable`);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) fail(`${name} must be https (plain http only to a loopback address)`);
  return raw.replace(/\/+$/, '');
}

function envNames(env, name) {
  const raw = env[name];
  if (!raw) return [];
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!ENV_NAME.test(n)) fail(`${name}: "${n}" is not an environment variable name`);
    // the server's own settings and credentials (SA_PINATA_JWT, SA_FILEBASE_TOKEN, ...) stay with the server
    if (n.startsWith('SA_')) fail(`${name}: ${n} is the server's own variable and is never passed to the builder`);
  }
  return [...new Set(names)];
}

function pinningConfig(env, production) {
  const backend = env.SA_PINNING || (production ? fail('SA_PINNING must name a pinning backend in production (kubo, filebase or pinata)') : 'mock');
  if (!BACKENDS.includes(backend)) fail(`SA_PINNING must be one of ${BACKENDS.join(', ')}`);
  if (backend === 'mock' && production) fail('SA_PINNING=mock pins nothing anyone can fetch; it is refused in production');
  const timeoutMs = integer(env, 'SA_PIN_TIMEOUT_MS', 60000, { min: 1000 });
  const needs = (tokenEnv) => {
    if (typeof env[tokenEnv] !== 'string' || !env[tokenEnv].trim()) fail(`SA_PINNING=${backend} needs its credential in ${tokenEnv}`);
    return tokenEnv;
  };
  switch (backend) {
    case 'kubo':
      return { backend, url: serviceUrl(env, 'SA_KUBO_API_URL', 'http://127.0.0.1:5001'), tokenEnv: null, timeoutMs };
    case 'filebase':
      return { backend, url: serviceUrl(env, 'SA_FILEBASE_RPC_URL', 'https://rpc.filebase.io'), tokenEnv: needs('SA_FILEBASE_TOKEN'), timeoutMs };
    case 'pinata':
      return { backend, url: serviceUrl(env, 'SA_PINATA_API_URL', 'https://api.pinata.cloud'), tokenEnv: needs('SA_PINATA_JWT'), timeoutMs };
    default:
      return { backend, url: null, tokenEnv: null, timeoutMs };
  }
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {object} frozen; holds no credential
 * @throws {ConfigError}
 */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const chainId = env.SA_CHAIN_ID ? integer(env, 'SA_CHAIN_ID', null, { min: 1 }) : null;
  const trustMode = env.SA_ATTESTATION_TRUST || 'production';
  if (!['production', 'dev'].includes(trustMode)) fail('SA_ATTESTATION_TRUST must be production or dev');
  if (trustMode === 'dev' && (production || chainId === MAINNET_CHAIN_ID)) {
    fail('SA_ATTESTATION_TRUST=dev is for development only: refused in production and on Base mainnet (build plan A6)');
  }
  const codeStandard = codeReview.CODE_CLASSES['code-standard'];
  const oracle = {
    requestedClass: String(codeStandard.classId),
    maxOracleFee: wei(env, 'SA_ORACLE_MAX_FEE_WEI', DEFAULT_ORACLE.maxOracleFee),
    disputeMaxOracleFee: wei(env, 'SA_ORACLE_DISPUTE_MAX_FEE_WEI', DEFAULT_ORACLE.disputeMaxOracleFee),
    estimatedBaseCost: wei(env, 'SA_ORACLE_BASE_COST_WEI', DEFAULT_ORACLE.estimatedBaseCost),
    alpha: String(integer(env, 'SA_ORACLE_ALPHA', Number(DEFAULT_ORACLE.alpha), { max: 1000 })),
    maxFeeBasedScaling: String(integer(env, 'SA_ORACLE_MAX_FEE_SCALING', Number(DEFAULT_ORACLE.maxFeeBasedScaling), { min: 1, max: 1000 })),
  };
  // the contract's _checkOracle, the parts that need no chain read
  if (BigInt(oracle.maxOracleFee) === 0n || BigInt(oracle.disputeMaxOracleFee) === 0n) fail('the oracle fees must be above 0');
  if (BigInt(oracle.estimatedBaseCost) >= BigInt(oracle.maxOracleFee) || BigInt(oracle.estimatedBaseCost) >= BigInt(oracle.disputeMaxOracleFee)) {
    fail('SA_ORACLE_BASE_COST_WEI must be below both oracle fees');
  }
  const builderConfig = env.SA_BUILDER_CONFIG ? path.resolve(env.SA_BUILDER_CONFIG) : null;
  return Object.freeze({
    port: integer(env, 'PORT', 5009, { min: 0, max: 65535 }),
    host: env.HOST || '127.0.0.1',
    production,
    chainId,
    trust: Object.freeze({ mode: trustMode }),
    oracle: Object.freeze(oracle),
    pinning: Object.freeze(pinningConfig(env, production)),
    builder: Object.freeze({
      bin: path.resolve(env.SA_BUILDER_BIN || path.join(here, '..', '..', 'builder', 'bin', 'verdikta-build-env.js')),
      config: builderConfig,
      workDir: path.resolve(env.SA_BUILDER_WORK_DIR || os.tmpdir()),
      buildEnv: Object.freeze(envNames(env, 'SA_BUILDER_BUILD_ENV')),
      signEnv: Object.freeze(envNames(env, 'SA_BUILDER_SIGN_ENV')),
      timeoutMs: integer(env, 'SA_BUILDER_TIMEOUT_MS', 3600000, { min: 1000 }),
    }),
    builds: Object.freeze({
      maxConcurrent: integer(env, 'SA_MAX_CONCURRENT_BUILDS', 1, { min: 1, max: 16 }),
      maxQueued: integer(env, 'SA_MAX_QUEUED_BUILDS', 8, { min: 0, max: 1000 }),
    }),
  });
}
