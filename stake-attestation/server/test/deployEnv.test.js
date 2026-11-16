// The deploy kit's environment template (node P23; deploy/server.env.example, README "Running the site") against the
// server's own configuration: it names every variable the server reads, sets the Base Sepolia launch with production
// trust, the workflow backend and a real pinning backend, holds no secret, and loadConfig takes it once the operator's
// blanks are filled (and refuses it while a required one is not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvFile } from '@verdikta/stake-attestation-shared/deploy-kit';

import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..');
const TEMPLATE_FILE = path.resolve(SERVER, '..', 'deploy', 'server.env.example');
const text = fs.readFileSync(TEMPLATE_FILE, 'utf8');
const template = parseEnvFile(text);
const lines = text.split('\n');

// Every variable the server's source reads: SA_*, and PORT, HOST and NODE_ENV (src/config.js, src/index.js). The
// per-chain SA_CONTROL_RPC_URL_<chain id> is a family; the template names it by its pattern.
function variablesTheServerReads() {
  const names = new Set(['PORT', 'HOST', 'NODE_ENV']);
  const files = fs.readdirSync(path.join(SERVER, 'src'), { recursive: true }).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(SERVER, 'src', f), 'utf8').matchAll(/\bSA_[A-Z0-9_]*[A-Z0-9]\b|\bSA_CONTROL_RPC_URL_/g)) names.add(m[0]);
  }
  return [...names].sort();
}

const named = (name) => lines.some((l) => new RegExp(`^(?:# ?)?${name}(?:=|\\b)`).test(l.trim()) || l.includes(`${name}<`));

test('the template names every variable the server reads: as a setting, or as a commented default or exclusion', () => {
  const missing = variablesTheServerReads().filter((n) => !named(n));
  assert.deepEqual(missing, []);
  // nothing in the template the server does not read, but the scan's DOCKER_HOST (passed by name, SA_BUILDER_SCAN_ENV)
  const extra = [...template.keys()].filter((n) => n !== 'DOCKER_HOST' && !variablesTheServerReads().includes(n));
  assert.deepEqual(extra, []);
});

test('the deployment\'s fixed values: Base Sepolia, loopback on 5009, production trust, the workflow backend, a real pinning backend', () => {
  const v = (n) => template.get(n);
  assert.equal(v('NODE_ENV'), 'production');
  assert.equal(v('HOST'), '127.0.0.1');
  assert.equal(v('PORT'), '5009');
  assert.equal(v('SA_CHAIN_ID'), '84532');
  assert.equal(v('SA_ATTESTATION_TRUST'), 'production');
  assert.equal(v('SA_BUILD_BACKEND'), 'workflow');
  assert.ok(['kubo', 'filebase', 'pinata'].includes(v('SA_PINNING')), v('SA_PINNING'));
  // the scan reaches the service user's rootless Docker by its socket, passed by name
  assert.equal(v('SA_BUILDER_SCAN_ENV'), 'DOCKER_HOST');
  assert.equal(v('DOCKER_HOST'), '', 'unix:///run/user/<the service user\'s uid>/docker.sock, per host');
  for (const n of ['SA_DATA_DIR', 'SA_BUILDER_CONFIG', 'SA_BUILDER_WORK_DIR']) assert.match(v(n), /^\/(?:var|etc)\//, n);
});

test('the testnet launch values (owner decision Q76) and Chainlink\'s ETH/USD on Base Sepolia', () => {
  assert.equal(template.get('SA_BADGE_FLOOR_WEI'), '10000000000000000');
  assert.equal(template.get('SA_UNDER_STAKED_RATIO_BPS'), '1000');
  // Chainlink's data feeds documentation, Base Sepolia, ETH / USD (the proxy)
  assert.equal(template.get('SA_ETH_USD_FEED'), '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1');
  assert.match(text, /testnet launch values \(owner decision\)[^\n]*\n(?:#[^\n]*\n)*?#[^\n]*before mainnet/i);
});

// The secrets and the per-deployment values: empty, each with a comment above it saying where it comes from.
const BLANK = ['SA_RPC_URL', 'SA_KEEPER_PRIVATE_KEY', 'SA_BUILD_WORKFLOW_TOKEN', 'SA_BUILD_WORKFLOW_REPO', 'SA_CONTRACT_ADDRESS', 'SA_FROM_BLOCK', 'DOCKER_HOST'];
const credentialOf = { pinata: 'SA_PINATA_JWT', filebase: 'SA_FILEBASE_TOKEN', kubo: null };

test('every secret and per-deployment value is an empty setting with a comment above it', () => {
  const blank = [...BLANK, credentialOf[template.get('SA_PINNING')]].filter(Boolean);
  for (const n of blank) {
    assert.equal(template.get(n), '', `${n} is empty`);
    const i = lines.findIndex((l) => l.startsWith(`${n}=`));
    assert.match(lines[i - 1] ?? '', /^#\s*\S/, `${n}: a comment above it says where it comes from`);
  }
});

test('no value in the template is a secret', () => {
  for (const [n, value] of template) {
    if (!value) continue;
    assert.doesNotMatch(value, /^0x[0-9a-fA-F]{64}$/, `${n}: a private key`);
    assert.doesNotMatch(value, /eyJ|gh[pousr]_|github_pat_|-----BEGIN/, `${n}: a token`);
    assert.doesNotMatch(value, /:\/\/[^/]*@|[?&](?:key|token|apikey)=/i, `${n}: a credential in a URL`);
    if (/KEY|TOKEN|JWT|SECRET|PASSWORD|RPC_URL/.test(n)) assert.fail(`${n} has a value`);
  }
  // a commented example is not a place for a secret either
  for (const l of lines.filter((x) => x.startsWith('#'))) assert.doesNotMatch(l, /\b0x[0-9a-fA-F]{64}\b|eyJ[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}/, l);
});

// What the operator fills in, as stand-ins: none is real.
const FILLED = {
  SA_RPC_URL: 'https://rpc.invalid/',
  SA_KEEPER_PRIVATE_KEY: 'filled-in-on-the-host',
  SA_BUILD_WORKFLOW_TOKEN: 'filled-in-on-the-host',
  SA_BUILD_WORKFLOW_REPO: 'verdikta/caller',
  SA_CONTRACT_ADDRESS: '0x000000000000000000000000000000000000dEaD',
  SA_FROM_BLOCK: '123',
  SA_PINATA_JWT: 'filled-in-on-the-host',
  SA_FILEBASE_TOKEN: 'filled-in-on-the-host',
  DOCKER_HOST: 'unix:///run/user/999/docker.sock',
};

test('loadConfig takes the template once the blanks are filled: the launch as the README describes it', () => {
  const env = Object.fromEntries([...template].map(([k, v]) => [k, v === '' && FILLED[k] !== undefined ? FILLED[k] : v]));
  const c = loadConfig(env);
  assert.equal(c.production, true);
  assert.equal(c.chainId, 84532);
  assert.equal(c.trust.mode, 'production');
  assert.equal(c.builds.backend, 'workflow');
  assert.equal(c.builds.workflow.site, template.get('SA_BUILD_WORKFLOW_SITE') || 'site');
  assert.equal(c.pinning.backend, template.get('SA_PINNING'));
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 5009);
  assert.equal(c.chain.address, FILLED.SA_CONTRACT_ADDRESS);
  assert.equal(c.chain.dataDir, template.get('SA_DATA_DIR'));
  assert.deepEqual(c.labels.placeholders, [], 'the launch values, not the placeholders');
  assert.equal(c.labels.ethUsdFeed, template.get('SA_ETH_USD_FEED'));
  assert.deepEqual(c.builder.scanEnv, ['DOCKER_HOST']);
  assert.equal(c.builder.config, template.get('SA_BUILDER_CONFIG'));
  assert.equal(c.control.mirrorDir, null);
  assert.equal(c.keeper.enabled, true);
});

test('loadConfig refuses the template as it stands: the workflow token and the pinning credential are the operator\'s', () => {
  assert.throws(() => loadConfig(Object.fromEntries(template)), /CONFIG_INVALID/);
});
