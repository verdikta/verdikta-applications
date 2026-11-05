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
//   SA_BUILDER_SCAN_ENV            the same for `scan`, the baseline scan (DOCKER_HOST; with the
//                                  agent pass, the variable its builder config names for the key)
//   SA_SCAN_AGENT                  on | off (default): the scan's agent pass (design §8.3; the model
//                                  is the builder config's scan.agent)
//   SA_AUTH_CHALLENGE_TTL_MS       how long a wallet sign-in challenge can be answered (300000, 5
//                                  min; whole seconds, 10 s to 1 h)
//   SA_BUILDER_TIMEOUT_MS          per builder step (14400000, 4 h): a backstop above the builder's
//                                  own step limits (fetch, image build, push, source build, the
//                                  code-runner's deadline), which clean up after themselves
//   SA_BUILDER_GRACE_MS            after SIGTERM, before SIGKILL (30000)
//   SA_MAX_CONCURRENT_BUILDS       builds run at once (1)
//   SA_MAX_QUEUED_BUILDS           builds waiting before POST /api/listings answers 429 (8)
//   SA_BUILD_BACKEND               local (default): the builder's command line, on this host | workflow: a run of
//                                  Verdikta's caller, signed in KMS (node P15; docs/builder-kms-signing.md). It takes
//                                  production trust only, and is refused on Base mainnet: its key is testnet-only
//
// With SA_BUILD_BACKEND=workflow:
//
//   SA_BUILD_WORKFLOW_REPO         the caller repository, owner/name
//   SA_BUILD_WORKFLOW_FILE         its workflow file (stake-attestation-site-build.yml); runs start from main
//   SA_BUILD_WORKFLOW_TOKEN        a token with Actions read and write on that repository. Read when used and never
//                                  kept here. Its real reach is in docs/builder-kms-signing.md
//   SA_BUILD_WORKFLOW_SITE         this site's prefix in a run's name (site): a server cancels only runs under its own
//   SA_GITHUB_API_URL              GitHub's API (https://api.github.com)
//   SA_BUILD_POLL_MS               between reads of a run (30000)
//   SA_BUILD_FIND_MS               how long a run may take to appear (300000)
//   SA_BUILD_RUN_DEADLINE_MS       a run's time not waiting for a reviewer, then it is cancelled (10800000, 3 h)
//   SA_BUILD_APPROVAL_DEADLINE_MS  a reviewer's time, then it is cancelled (259200000, 72 h)
//   SA_BUILD_SWEEP_MS              between sweeps for runs nothing follows (300000)
//   SA_BUILD_MAX_AWAITING          runs waiting for a reviewer before no new one starts (8)
//   SA_BUILD_LIMIT_PER_WALLET      a wallet's attempts in the window (3)
//   SA_BUILD_LIMIT_PER_REPO_OWNER  builds in the window per <host>/<owner> (5)
//   SA_BUILD_LIMIT_OVERALL         builds in the window (20)
//   SA_BUILD_LIMIT_WINDOW_MS       the window (86400000, 1 day)
//   SA_BUILD_ARTIFACT_MAX_BYTES    the largest artifact collected (67108864, 64 MiB)
//   SA_DATA_DIR                    holds the limits' counts (build-budget.json)
//
//   SA_ORACLE_MAX_FEE_WEI, SA_ORACLE_DISPUTE_MAX_FEE_WEI, SA_ORACLE_BASE_COST_WEI,
//   SA_ORACLE_ALPHA, SA_ORACLE_MAX_FEE_SCALING
//                                  the oracle parameters list() takes (design §10.8; the class is
//                                  common's code-standard, build plan A8)
//
// The chain side (node P4b1: indexer, keeper, feed, record mirror, badge) is on when a deployment
// is named; without SA_CONTRACT_ADDRESS the listing flow runs alone.
//
//   SA_CONTRACT_ADDRESS            the StakeAttestation deployment (onchain/deployments/<chainId>-*.json)
//   SA_FROM_BLOCK                  its deployment block, where the indexer starts ("deploymentBlock")
//   SA_RPC_URL                     the chain's JSON-RPC endpoint. Read when the provider is made and
//                                  never kept here: a provider's URL may carry its key in the path
//   SA_CONFIRMATIONS               blocks on top of a block before it is read (10)
//   SA_REORG_WINDOW_BLOCKS         how far below the cursor the indexer keeps block hashes to find a
//                                  fork point (512); a deeper reorg re-reads from SA_FROM_BLOCK
//   SA_LOG_CHUNK_BLOCKS            blocks per eth_getLogs, each committed with its cursor (2000)
//   SA_INDEXER_POLL_MS             between syncs (15000)
//   SA_DATA_DIR                    the indexer's and keeper's state, one writer at a time (server/data)
//   SA_MAX_STALENESS_SECONDS       an answer is stale once the last sync that reached the confirmed
//                                  head, or the cursor's block, is older than this; the badge then
//                                  says the record is unavailable rather than state a live stake (600)
//   SA_RECORD_LISTING_PAGE, SA_RECORD_ITEM_PAGE
//                                  recordPage's page sizes when a record is read (50, 200)
//   SA_IPFS_GATEWAYS               operator-preferred gateways for reading listing archives (the feed's
//                                  image and scope) and justifications (the record's claims that failed
//                                  integrity), tried before @verdikta/common's own list
//   SA_ARCHIVE_MAX_BYTES           the largest listing archive read (8388608)
//   SA_ARCHIVE_TIMEOUT_MS          per gateway request, for a justification too (30000)
//   SA_ARCHIVE_RETRY_MS            after a failed fetch, a justification's too, the first wait before the
//                                  next; it doubles per failure, up to 6 h (30000)
//   SA_ETH_USD_FEED                Chainlink's ETH/USD aggregator on the chain (Base mainnet:
//                                  0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70); under-staked needs it
//   SA_ETH_USD_MAX_AGE_SECONDS     an older answer is no price (3600)
//   SA_BADGE_FLOOR_WEI             PLACEHOLDER (record/labels.js): below it a stake is only "scanned"
//   SA_UNDER_STAKED_RATIO_BPS      PLACEHOLDER (record/labels.js): the share of a declared value at
//                                  risk below which a stake is "under-staked", in basis points
//   SA_KEEPER                      on (default) | off: call finalize and settle when due
//   SA_KEEPER_PRIVATE_KEY          the keeper's key. Read when the keeper starts, never kept here
//   SA_KEEPER_POLL_MS              between keeper cycles (30000)
//   SA_KEEPER_TX_TIMEOUT_MS        how long a cycle waits for a receipt (120000)
//   SA_KEEPER_REPLACE_AFTER_MS     a transaction still pending after this is re-sent at its nonce
//                                  with higher fees (180000)
//   SA_KEEPER_MAX_FEE_PER_GAS_WEI  the most the keeper pays per gas (10000000000, 10 gwei)
//   SA_KEEPER_EXPIRE               off (default) | on: also expire claims nobody can advance
//
// The control facts (node P8; src/control/, docs/control-proof.md):
//
//   SA_CONTROL_GIT_HOSTS           the git hosts the site reads a repository from, comma-separated
//                                  (github.com, gitlab.com, codeberg.org, bitbucket.org); a listing
//                                  on any other host is "no"
//   SA_CONTROL_CHECK_BIN           the check's command line (../builder/bin/verdikta-control-check.js)
//   SA_CONTROL_CHECK_TIMEOUT_MS    one repository's whole check (120000)
//   SA_CONTROL_CHECK_MAX_BYTES     what one check may fetch (268435456, 256 MiB)
//   SA_CONTROL_RETRY_MS            after a failed check, the first wait before the next; it doubles
//                                  per failure, up to 6 h (60000)
//   SA_CONTROL_RECHECK_MS          between checks of a listing that is live (86400000, 1 day): a
//                                  branch can be deleted and an owner can change
//   SA_CONTROL_RPC_TIMEOUT_MS      one deployment proof's reads on the listing's chain (10000)
//   SA_CONTROL_RPC_URL_<chain id>  the JSON-RPC endpoint of a listing's chain other than SA_CHAIN_ID.
//                                  Read when used and never kept here: it may carry a key. A contract
//                                  listing on a chain with none is "no"
//   SA_CONTROL_GIT_MIRROR_DIR      development only, refused in production: repositories are read from
//                                  <dir>/<host>/<path>.git instead of the network
//   SA_CONTROL_FORK_TIMEOUT_MS     one request to a host's API for the record's fork label (10000)
//   SA_GITHUB_TOKEN                optional: raises GitHub's rate limit for the fork label. Read when
//                                  used and never kept here; without it the label may say unknown
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
import { DEFAULT_GIT_HOSTS } from '@verdikta/stake-attestation-shared/control-proof';

import { codeReview } from './common.js';
import { BUILD_BUDGET_FILE } from './listing/buildBudget.js';
import { BACKENDS } from './pinning/index.js';
import { LABEL_PLACEHOLDERS } from './record/labels.js';

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

function onOff(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return fail(`${name} must be on or off`);
}

function address(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) fail(`${name} must be a 20-byte 0x address`);
  return getAddress(raw.toLowerCase());
}

/** A URL checked for shape only and never returned: the RPC endpoint may carry a key. */
function checkSecretUrl(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return;
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`${name} is not a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) fail(`${name} must be https (plain http only to a loopback address)`);
}

function gateways(env, name) {
  const raw = env[name];
  if (!raw) return [];
  const out = [];
  for (const entry of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    let u;
    try {
      u = new URL(entry);
    } catch {
      fail(`${name}: "${entry}" is not a URL`);
    }
    if (u.username || u.password || u.search) fail(`${name}: a gateway URL carries no credentials or query`);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) fail(`${name}: gateways are https (plain http only to a loopback address)`);
    out.push(entry.replace(/\/+$/, ''));
  }
  return [...new Set(out)];
}

const GIT_HOST = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

function controlConfig(env, production) {
  // another chain's endpoint is read when used and never kept; only its shape is checked here
  for (const name of Object.keys(env)) {
    if (name.startsWith('SA_CONTROL_RPC_URL_')) {
      if (!/^SA_CONTROL_RPC_URL_[1-9][0-9]{0,19}$/.test(name)) fail(`${name}: the suffix is the listing chain's id`);
      checkSecretUrl(env, name);
    }
  }
  const gitHosts = env.SA_CONTROL_GIT_HOSTS ? env.SA_CONTROL_GIT_HOSTS.split(',').map((x) => x.trim()).filter(Boolean) : [...DEFAULT_GIT_HOSTS];
  for (const h of gitHosts) if (!GIT_HOST.test(h) || /^[0-9.]+$/.test(h)) fail(`SA_CONTROL_GIT_HOSTS: "${h}" is not a lowercase host name`);
  const mirrorDir = env.SA_CONTROL_GIT_MIRROR_DIR ? path.resolve(env.SA_CONTROL_GIT_MIRROR_DIR) : null;
  if (mirrorDir && production) fail('SA_CONTROL_GIT_MIRROR_DIR is for development only: in production a repository is read from its host, so a local copy can say nothing');
  return Object.freeze({
    gitHosts: Object.freeze(gitHosts),
    bin: path.resolve(env.SA_CONTROL_CHECK_BIN || path.join(here, '..', '..', 'builder', 'bin', 'verdikta-control-check.js')),
    workDir: path.resolve(env.SA_BUILDER_WORK_DIR || os.tmpdir()),
    mirrorDir,
    timeoutMs: integer(env, 'SA_CONTROL_CHECK_TIMEOUT_MS', 120000, { min: 100 }),
    maxBytes: integer(env, 'SA_CONTROL_CHECK_MAX_BYTES', 256 * 1024 * 1024, { min: 1024 }),
    retryMs: integer(env, 'SA_CONTROL_RETRY_MS', 60000, { min: 1 }),
    recheckMs: integer(env, 'SA_CONTROL_RECHECK_MS', 86400000, { min: 1 }),
    rpcTimeoutMs: integer(env, 'SA_CONTROL_RPC_TIMEOUT_MS', 10000, { min: 1 }),
    forkTimeoutMs: integer(env, 'SA_CONTROL_FORK_TIMEOUT_MS', 10000, { min: 1 }),
  });
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;

function buildsConfig(env, trustMode, chainId) {
  const base = {
    maxConcurrent: integer(env, 'SA_MAX_CONCURRENT_BUILDS', 1, { min: 1, max: 16 }),
    maxQueued: integer(env, 'SA_MAX_QUEUED_BUILDS', 8, { min: 0, max: 1000 }),
  };
  const backend = env.SA_BUILD_BACKEND || 'local';
  if (!['local', 'workflow'].includes(backend)) fail('SA_BUILD_BACKEND must be local or workflow');
  if (backend === 'local') return Object.freeze({ ...base, backend, workflow: null, limits: null, maxAwaiting: null, stateFile: null });
  if (trustMode !== 'production') fail('SA_BUILD_BACKEND=workflow takes production trust only: the signing workflow signs with the production key');
  // Its key signs for anyone who passes the gates, so it is testnet-only (docs/builder-kms-signing.md): Base mainnet gets another key and another decision.
  if (chainId === null || chainId === MAINNET_CHAIN_ID) fail('SA_BUILD_BACKEND=workflow needs SA_CHAIN_ID, and is refused on Base mainnet: the key it signs with is testnet-only');
  const repo = env.SA_BUILD_WORKFLOW_REPO;
  if (typeof repo !== 'string' || !REPOSITORY.test(repo) || repo.split('/')[1].startsWith('.')) fail('SA_BUILD_WORKFLOW_REPO must name the caller repository, owner/name');
  const file = env.SA_BUILD_WORKFLOW_FILE || 'stake-attestation-site-build.yml';
  if (!WORKFLOW_FILE.test(file)) fail('SA_BUILD_WORKFLOW_FILE must be a workflow\'s file name');
  if (typeof env.SA_BUILD_WORKFLOW_TOKEN !== 'string' || !env.SA_BUILD_WORKFLOW_TOKEN.trim()) fail('SA_BUILD_BACKEND=workflow needs its token in SA_BUILD_WORKFLOW_TOKEN');
  const site = env.SA_BUILD_WORKFLOW_SITE || 'site';
  if (!/^[a-z0-9]{1,16}$/.test(site)) fail('SA_BUILD_WORKFLOW_SITE must be 1 to 16 lowercase letters and digits');
  return Object.freeze({
    ...base,
    backend,
    workflow: Object.freeze({
      apiUrl: serviceUrl(env, 'SA_GITHUB_API_URL', 'https://api.github.com'),
      repo,
      file,
      ref: 'main',
      tokenEnv: 'SA_BUILD_WORKFLOW_TOKEN',
      site,
      pollMs: integer(env, 'SA_BUILD_POLL_MS', 30000, { min: 1 }),
      findMs: integer(env, 'SA_BUILD_FIND_MS', 300000, { min: 1 }),
      runDeadlineMs: integer(env, 'SA_BUILD_RUN_DEADLINE_MS', 10800000, { min: 1 }),
      approvalDeadlineMs: integer(env, 'SA_BUILD_APPROVAL_DEADLINE_MS', 259200000, { min: 1 }),
      sweepMs: integer(env, 'SA_BUILD_SWEEP_MS', 300000, { min: 1 }),
      artifactMaxBytes: integer(env, 'SA_BUILD_ARTIFACT_MAX_BYTES', 64 * 1024 * 1024, { min: 1024 }),
    }),
    maxAwaiting: integer(env, 'SA_BUILD_MAX_AWAITING', 8, { min: 1, max: 1000 }),
    limits: Object.freeze({
      perWallet: integer(env, 'SA_BUILD_LIMIT_PER_WALLET', 3, { min: 1 }),
      perRepoOwner: integer(env, 'SA_BUILD_LIMIT_PER_REPO_OWNER', 5, { min: 1 }),
      overall: integer(env, 'SA_BUILD_LIMIT_OVERALL', 20, { min: 1 }),
      windowMs: integer(env, 'SA_BUILD_LIMIT_WINDOW_MS', 86400000, { min: 1 }),
    }),
    stateFile: path.join(path.resolve(env.SA_DATA_DIR || path.join(here, '..', 'data')), BUILD_BUDGET_FILE),
  });
}

function chainConfig(env, chainId) {
  const contract = address(env, 'SA_CONTRACT_ADDRESS');
  checkSecretUrl(env, 'SA_RPC_URL');
  if (!contract) return null;
  if (chainId === null) fail('SA_CHAIN_ID is required with SA_CONTRACT_ADDRESS: the indexer checks the provider is on that chain');
  if (env.SA_FROM_BLOCK === undefined || env.SA_FROM_BLOCK === '') fail('SA_FROM_BLOCK is required with SA_CONTRACT_ADDRESS: the deployment block, where the indexer starts');
  const reorgWindowBlocks = integer(env, 'SA_REORG_WINDOW_BLOCKS', 512, { min: 1, max: 100000 });
  const confirmations = integer(env, 'SA_CONFIRMATIONS', 10, { max: 100000 });
  if (confirmations > reorgWindowBlocks) fail('SA_CONFIRMATIONS must not exceed SA_REORG_WINDOW_BLOCKS');
  return Object.freeze({
    chainId,
    address: contract,
    fromBlock: integer(env, 'SA_FROM_BLOCK', 0),
    rpcUrlEnv: 'SA_RPC_URL',
    confirmations,
    reorgWindowBlocks,
    chunkBlocks: integer(env, 'SA_LOG_CHUNK_BLOCKS', 2000, { min: 1, max: 1000000 }),
    pollMs: integer(env, 'SA_INDEXER_POLL_MS', 15000, { min: 100 }),
    dataDir: path.resolve(env.SA_DATA_DIR || path.join(here, '..', 'data')),
    maxStalenessSeconds: integer(env, 'SA_MAX_STALENESS_SECONDS', 600, { min: 1 }),
    recordListingPage: integer(env, 'SA_RECORD_LISTING_PAGE', 50, { min: 1, max: 10000 }),
    recordItemPage: integer(env, 'SA_RECORD_ITEM_PAGE', 200, { min: 1, max: 10000 }),
  });
}

function labelsConfig(env) {
  const placeholders = [];
  const floor = env.SA_BADGE_FLOOR_WEI;
  if (floor === undefined || floor === '') placeholders.push('SA_BADGE_FLOOR_WEI');
  const ratio = env.SA_UNDER_STAKED_RATIO_BPS;
  if (ratio === undefined || ratio === '') placeholders.push('SA_UNDER_STAKED_RATIO_BPS');
  return Object.freeze({
    badgeFloorWei: wei(env, 'SA_BADGE_FLOOR_WEI', LABEL_PLACEHOLDERS.badgeFloorWei),
    underStakedRatioBps: integer(env, 'SA_UNDER_STAKED_RATIO_BPS', LABEL_PLACEHOLDERS.underStakedRatioBps, { max: 10000 }),
    placeholders: Object.freeze(placeholders),
    ethUsdFeed: address(env, 'SA_ETH_USD_FEED'),
    ethUsdMaxAgeSeconds: integer(env, 'SA_ETH_USD_MAX_AGE_SECONDS', 3600, { min: 1 }),
  });
}

function keeperConfig(env) {
  return Object.freeze({
    enabled: onOff(env, 'SA_KEEPER', true),
    keyEnv: 'SA_KEEPER_PRIVATE_KEY',
    pollMs: integer(env, 'SA_KEEPER_POLL_MS', 30000, { min: 100 }),
    txTimeoutMs: integer(env, 'SA_KEEPER_TX_TIMEOUT_MS', 120000, { min: 1 }),
    replaceAfterMs: integer(env, 'SA_KEEPER_REPLACE_AFTER_MS', 180000),
    maxFeePerGasWei: wei(env, 'SA_KEEPER_MAX_FEE_PER_GAS_WEI', '10000000000'),
    expire: onOff(env, 'SA_KEEPER_EXPIRE', false),
  });
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
  const challengeTtlMs = integer(env, 'SA_AUTH_CHALLENGE_TTL_MS', 300000, { min: 10000, max: 3600000 });
  if (challengeTtlMs % 1000) fail('SA_AUTH_CHALLENGE_TTL_MS must be whole seconds: the expiry is stated to the second in the message the wallet signs');
  const chain = chainConfig(env, chainId);
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
      scanEnv: Object.freeze(envNames(env, 'SA_BUILDER_SCAN_ENV')),
      scanAgent: onOff(env, 'SA_SCAN_AGENT', false),
      timeoutMs: integer(env, 'SA_BUILDER_TIMEOUT_MS', 14400000, { min: 1000 }),
      graceMs: integer(env, 'SA_BUILDER_GRACE_MS', 30000, { min: 100 }),
    }),
    auth: Object.freeze({ challengeTtlMs }),
    builds: buildsConfig(env, trustMode, chainId),
    chain,
    keeper: keeperConfig(env),
    labels: labelsConfig(env),
    control: controlConfig(env, production),
    archives: Object.freeze({
      gateways: Object.freeze(gateways(env, 'SA_IPFS_GATEWAYS')),
      maxBytes: integer(env, 'SA_ARCHIVE_MAX_BYTES', 8 * 1024 * 1024, { min: 1024 }),
      timeoutMs: integer(env, 'SA_ARCHIVE_TIMEOUT_MS', 30000, { min: 100 }),
      retryMs: integer(env, 'SA_ARCHIVE_RETRY_MS', 30000),
    }),
  });
}
