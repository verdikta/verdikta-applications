import './_env.js';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { defaultSecretsDir } from './_paths.js';

// Generated escrow + lens ABI and reviewed deployment snapshots.
import { abi, deployments } from './_transaction-guards.js';
export { reviewedApiOrigin } from './_transaction-guards.js';
import { walletPassword } from './_secret.js';
import { execute, loadSpendPolicy } from './_executor.js';
export { preflightDeployment, loadSpendPolicy } from './_executor.js';
export const ESCROW = Object.fromEntries(Object.entries(deployments).map(([n,d]) => [n,d.address]));
export const CHAIN_IDS = Object.fromEntries(Object.entries(deployments).map(([n,d]) => [n,d.chainId]));
export const BOUNTY_ESCROW_ABI = abi;

/**
 * Return a connected BountyEscrow Contract instance.
 * @param {string} network  - 'base' or 'base-sepolia'
 * @param {import('ethers').Signer|import('ethers').Provider} signerOrProvider
 */
export function escrowContract(network, signerOrProvider) {
  const addr = ESCROW[network];
  if (!addr) throw new Error(`No escrow address for network ${network}`);
  return new Contract(addr, BOUNTY_ESCROW_ABI, signerOrProvider);
}

/**
 * Redact an API key for safe logging (shows first 4 + last 4 chars).
 * @param {string} key
 * @returns {string}
 */
export function redactApiKey(key) {
  if (!key || key.length < 12) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function getNetwork() {
  const network = process.env.VERDIKTA_NETWORK;
  if (!CHAIN_IDS[network]) throw new Error('Explicit VERDIKTA_NETWORK base or base-sepolia required');
  return network;
}

export function expectedChainId(network = getNetwork()) {
  const id = CHAIN_IDS[network];
  if (!id) throw new Error(`Unsupported VERDIKTA_NETWORK: ${network}`);
  return id;
}

export function getRpcUrl(network) {
  if (network === 'base') return process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
}

export function resolvePath(p) {
  if (!p) return p;
  let s = String(p);
  // Expand ~ to home for convenience in .env files
  if (s.startsWith('~/')) {
    s = path.join(process.env.HOME || '', s.slice(2));
  }
  // Resolve relative paths against the scripts directory (not the caller's CWD).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.isAbsolute(s) ? s : path.resolve(here, s);
}

export async function loadWallet({ password } = {}) {
  const keystorePathRaw = process.env.VERDIKTA_KEYSTORE_PATH;
  if (!keystorePathRaw) {
    throw new Error('Set VERDIKTA_KEYSTORE_PATH (node onboard.js writes it). To import an existing wallet, run: node wallet_init.js --import');
  }
  const keystorePath = resolvePath(keystorePathRaw);
  const json = await fs.readFile(keystorePath, 'utf-8');
  // The password comes from the environment (a secret store) or a terminal prompt; never from a file.
  return Wallet.fromEncryptedJson(json, password ?? await walletPassword());
}

export function providerFor(network) {
  return new JsonRpcProvider(getRpcUrl(network));
}

export function parseEth(s) {
  return parseEther(String(s));
}

// ---- CLI argument helpers ----

export function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function argAll(name) {
  const vals = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) {
      vals.push(process.argv[i + 1]);
    }
  }
  return vals;
}

// ---- API key loading ----

export async function loadApiKey() {
  const botFile = process.env.VERDIKTA_BOT_FILE || `${defaultSecretsDir()}/verdikta-bounties-bot.json`;
  const abs = resolvePath(botFile);
  const raw = await fs.readFile(abs, 'utf8');
  const j = JSON.parse(raw);
  return j.apiKey || j.api_key || j.bot?.apiKey || j.bot?.api_key;
}

// ---- Spending confirmation helpers ----

export function hasSpendConfirmationFlag() {
  return hasFlag('yes') || hasFlag('confirm-spend');
}

export async function confirmSpendOrExit(summary, { requiredText = 'YES' } = {}) {
  console.log('\nSPEND REVIEW');
  for (const line of summary) console.log(`  ${line}`);

  if (hasSpendConfirmationFlag()) return;
  if (!process.stdin.isTTY) {
    console.error(`\nRefusing to continue without explicit spend authorization. Re-run with --yes or --confirm-spend after reviewing the operation.`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Type ${requiredText} to sign/broadcast transactions: `)).trim();
    if (answer !== requiredText) {
      console.error('Spend not confirmed. Aborting before signing.');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

export function isDryRun() {
  return hasFlag('dry-run') || hasFlag('dryRun');
}

// ---- Class models (supported jury nodes) ----

export function normalizeProvider(p) {
  return String(p || '').trim().toLowerCase();
}

export function juryKey(provider, model) {
  return `${normalizeProvider(provider)}/${String(model || '').trim()}`;
}

/**
 * Fetch supported models for a Verdikta class.
 * Uses X-Bot-API-Key auth.
 */
export async function getSupportedModelsForClass(baseUrl, apiKey, classId) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/classes/${classId}/models`;
  const res = await fetch(url, { headers: { 'X-Bot-API-Key': apiKey } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to fetch supported models for class ${classId}: HTTP ${res.status} ${text}`);
  }
  const data = await res.json();
  const models = data.models || [];
  return models.map(m => ({ provider: normalizeProvider(m.provider), model: String(m.model) }));
}

/**
 * Strictly validate juryNodes against the supported model list for the class.
 * Returns a normalized juryNodes array (providers lowercased).
 * Throws on any unsupported node.
 */
export function validateAndNormalizeJuryNodes({ classId, juryNodes, supported }) {
  if (!Array.isArray(juryNodes) || !juryNodes.length || juryNodes.some(n =>
    !n || typeof n.provider !== 'string' || typeof n.model !== 'string' ||
    !Number.isInteger(n.runs) || n.runs < 1 || n.runs > 10 ||
    typeof n.weight !== 'number' || !Number.isFinite(n.weight) || n.weight < 0 || n.weight > 1) ||
    Math.abs(juryNodes.reduce((sum, n) => sum + n.weight, 0) - 1) > 0.001) {
    throw new Error('Invalid jury nodes: providers/models, runs 1–10 and normalized weights required');
  }
  const allowed = new Set(supported.map(m => juryKey(m.provider, m.model)));
  const normalized = (juryNodes || []).map(n => ({ ...n, provider: normalizeProvider(n.provider) }));

  const invalid = normalized
    .map(n => ({ key: juryKey(n.provider, n.model), provider: n.provider, model: n.model }))
    .filter(x => !allowed.has(x.key));

  if (invalid.length) {
    const examples = supported
      .slice(0, 12)
      .map(m => `- ${juryKey(m.provider, m.model)}`)
      .join('\n');

    const bad = invalid.map(x => `- ${x.key}`).join('\n');
    throw new Error(
      `Unsupported jury model(s) for class ${classId}:\n${bad}\n\nSupported examples (query /api/classes/${classId}/models):\n${examples}`
    );
  }

  return normalized;
}

// Every bounty write requires independently encoded arguments and owner policy.
export async function sendTx(signer, label, txObj, opts = {}) {
  return execute(signer, label, txObj, {
    ...opts, policy: opts.policy || await loadSpendPolicy(),
    dryRun: isDryRun(), confirm: confirmSpendOrExit,
  });
}
