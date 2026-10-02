#!/usr/bin/env node
// One-command onboarding for Verdikta Bounties bots.
// Human involvement: choose network + owner/sweep addresses + fund wallet.
// Everything else (env setup, wallet creation, waiting for funding, bot registration) is automated.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, formatEther } from 'ethers';
import dotenv from 'dotenv';

import './_env.js';
import { providerFor, loadWallet, resolvePath, arg, hasFlag, reviewedApiOrigin } from './_lib.js';
import { defaultSecretsDir, ensureDir } from './_paths.js';
import { createPrompt, walletPassword, removeEnvKey, PASSWORD_ENV, PASSWORD_FILE_ENV } from './_secret.js';

function envNum(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envStr(name, def) {
  const v = process.env[name];
  return (v == null || String(v).trim() === '') ? def : String(v);
}

function isAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadOrInitEnvFile(envPath) {
  if (await fileExists(envPath)) return;
  const examplePath = path.join(path.dirname(envPath), '.env.example');
  if (await fileExists(examplePath)) {
    const ex = await fs.readFile(examplePath, 'utf8');
    await fs.writeFile(envPath, ex, { mode: 0o600 });
    await fs.chmod(envPath, 0o600);
    return;
  }
  // Minimal fallback
  await fs.writeFile(envPath, '', { mode: 0o600 });
  await fs.chmod(envPath, 0o600);
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2];
    // strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function upsertEnv(text, patch) {
  const lines = String(text).split(/\r?\n/);
  const keys = new Set(Object.keys(patch));
  const seen = new Set();

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) return line;
    const k = m[1];
    if (!keys.has(k)) return line;
    seen.add(k);
    const v = patch[k];
    return `${k}=${v}`;
  });

  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }

  return out.join(os.EOL).replace(/\s+$/,'') + os.EOL;
}

function isPrivateKey(s) {
  const hex = String(s || '').trim().replace(/^0x/, '');
  return /^[a-fA-F0-9]{64}$/.test(hex);
}

async function ensureWalletKeystore({ keystorePath, password, prompt }) {
  const rl = prompt?.rl;
  const abs = resolvePath(keystorePath);
  if (await fileExists(abs)) {
    try {
      const wallet = await loadWallet({ password });
      return { wallet, abs, created: false, imported: false };
    } catch (err) {
      // Password/keystore mismatch (common after re-onboarding or migration)
      if (!rl) throw err;
      console.log(`\nExisting keystore found at ${abs} but decryption failed.`);
      console.log(`(${err.message})\n`);
      console.log('This usually means the password changed since the keystore was created.');
      console.log('  1) Enter the correct password for the existing keystore');
      console.log('  2) Create a new wallet (overwrites the existing keystore)');
      console.log('  3) Import a different private key (overwrites the existing keystore)');
      const choice = (await rl.question('Choose [1]: ')).trim();

      if (!choice || choice === '1') {
        const oldPw = await prompt.hidden('Password for the existing keystore (not echoed): ');
        const rawJson = await fs.readFile(abs, 'utf8');
        const wallet = await Wallet.fromEncryptedJson(rawJson, oldPw);
        // Re-encrypt with the password supplied for this run so later runs use one credential
        const reEncrypted = await wallet.encrypt(password);
        await fs.writeFile(abs, reEncrypted, { mode: 0o600 });
        await fs.chmod(abs, 0o600);
        console.log('  Keystore re-encrypted with current password.');
        return { wallet, abs, created: false, imported: false };
      }

      if (choice === '3') {
        const key = await prompt.hidden('Paste private key (hex, with or without 0x; not echoed): ');
        if (!isPrivateKey(key)) throw new Error('Invalid private key format (expected 64 hex chars).');
        const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`);
        const json = await wallet.encrypt(password);
        await fs.writeFile(abs, json, { mode: 0o600 });
        await fs.chmod(abs, 0o600);
        console.log('  Imported and encrypted. Old keystore overwritten.');
        return { wallet, abs, created: true, imported: true };
      }

      // choice === '2': fall through to create new wallet below
      console.log('  Creating new wallet (old keystore will be overwritten)...');
    }
  }

  await ensureDir(path.dirname(abs));

  // Offer to import an existing wallet instead of generating a new one
  if (rl && !(await fileExists(abs))) {
    console.log('\nWallet setup:');
    console.log('  1) Create a new wallet (default)');
    console.log('  2) Import an existing private key');
    console.log('  3) Import an existing keystore file');
    const walletChoice = (await rl.question('Choose [1]: ')).trim();

    if (walletChoice === '2') {
      const key = await prompt.hidden('Paste private key (hex, with or without 0x; not echoed): ');
      if (!isPrivateKey(key)) throw new Error('Invalid private key format (expected 64 hex chars).');
      const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`);
      const json = await wallet.encrypt(password);
      await fs.writeFile(abs, json, { mode: 0o600 });
      await fs.chmod(abs, 0o600);
      console.log('  Imported and encrypted to keystore. Raw key was NOT saved.');
      return { wallet, abs, created: true, imported: true };
    }

    if (walletChoice === '3') {
      const srcPath = (await rl.question('Path to existing keystore JSON: ')).trim();
      const srcAbs = resolvePath(srcPath);
      if (!(await fileExists(srcAbs))) throw new Error(`Keystore file not found: ${srcAbs}`);
      const srcJson = await fs.readFile(srcAbs, 'utf8');
      const srcPw = await prompt.hidden('Password for the existing keystore (not echoed): ');
      const wallet = await Wallet.fromEncryptedJson(srcJson, srcPw);
      // Re-encrypt with the password supplied for this run so all scripts use one credential
      const reEncrypted = await wallet.encrypt(password);
      await fs.writeFile(abs, reEncrypted, { mode: 0o600 });
      await fs.chmod(abs, 0o600);
      console.log('  Imported and re-encrypted to skill keystore.');
      return { wallet, abs, created: true, imported: true };
    }
  }

  const wallet = Wallet.createRandom();
  const json = await wallet.encrypt(password);
  await fs.writeFile(abs, json, { mode: 0o600 });
  await fs.chmod(abs, 0o600);
  return { wallet, abs, created: true, imported: false };
}

async function waitForFunding({ network, address, minEth, pollSeconds }) {
  const provider = providerFor(network);
  while (true) {
    const eth = Number(formatEther(await provider.getBalance(address)));
    console.log(`Funding status (${network}): ${eth} ETH; configured minimum ${minEth} ETH. Live prepay and gas are checked at execution.`);
    if (eth >= minEth) return { eth };
    await new Promise(r => setTimeout(r, pollSeconds * 1000));
  }
}

async function registerBot({ baseUrl, name, ownerAddress, description }) {
  const res = await fetch(`${baseUrl}/api/bots/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ownerAddress, description })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bot registration failed: HTTP ${res.status} - ${text}`);
  const data = JSON.parse(text);
  const apiKey = data?.apiKey || data?.api_key || data?.bot?.apiKey || data?.bot?.api_key;
  if (!apiKey) throw new Error('Bot registration response missing apiKey');
  return { data, apiKey };
}

async function main() {
  const prompt = createPrompt();
  const rl = prompt.rl;
  try {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const secretsDir = defaultSecretsDir();
    const stableEnvPath = path.join(secretsDir, '.env');
    const localEnvPath = path.join(scriptsDir, '.env');

    // Read existing config from both locations (stable path takes priority)
    await ensureDir(secretsDir);
    const stableEnvText = await fs.readFile(stableEnvPath, 'utf8').catch(() => '');
    const localEnvText = await fs.readFile(localEnvPath, 'utf8').catch(() => '');
    const stableVars = parseEnv(stableEnvText);
    const localVars = parseEnv(localEnvText);

    // Merge: stable wins over local (matches _env.js load order)
    const current = { ...localVars, ...stableVars };
    const currentEnvText = stableEnvText || localEnvText;

    // Migration notice
    const migrating = !stableEnvText && localEnvText;
    if (migrating) {
      console.log(`\nMigrating config from scripts/.env to ${stableEnvPath}`);
      console.log('(The stable path survives skill updates and ClawHub reinstalls.)\n');
    }

    // Write target is always the stable path
    const envPath = stableEnvPath;

    if (hasFlag('migrate-password')) return await migratePassword({ envPath, envText: stableEnvText, secretsDir, prompt });
    if (localVars[PASSWORD_ENV]) console.log(`\nNote: ${localEnvPath} still holds ${PASSWORD_ENV}. It is ignored and not copied; delete that line yourself.`);

    console.log('Verdikta Bounties — one-command onboarding');

    const priorNetwork = (current.VERDIKTA_NETWORK || '').toLowerCase();

    // 1) Critical decision: network
    const networks = ['base-sepolia', 'base'];
    const networkDefault = current.VERDIKTA_NETWORK || process.env.VERDIKTA_NETWORK || 'base-sepolia';
    const defaultIdx = networks.indexOf(networkDefault) >= 0 ? networks.indexOf(networkDefault) : 0;

    console.log('\nSelect network:');
    networks.forEach((n, i) => {
      const marker = i === defaultIdx ? ' (default)' : '';
      console.log(`  ${i + 1}) ${n}${marker}`);
    });

    const networkAns = (await rl.question(`Choose [${defaultIdx + 1}]: `)).trim();
    let network;
    if (!networkAns) {
      network = networks[defaultIdx];
    } else if (networkAns === '1' || networkAns === '2') {
      network = networks[parseInt(networkAns, 10) - 1];
    } else if (networks.includes(networkAns.toLowerCase())) {
      network = networkAns.toLowerCase();
    } else {
      throw new Error('Invalid network. Enter 1, 2, base-sepolia, or base.');
    }
    console.log(`→ ${network}`);

    // 2) Bounties API origin: always the reviewed origin for the chosen network (deployments.json).
    // The bot API key is never sent anywhere else, so a different URL left in an older .env is replaced.
    const baseUrl = reviewedApiOrigin(network);
    const existingBaseUrl = (current.VERDIKTA_BOUNTIES_BASE_URL || process.env.VERDIKTA_BOUNTIES_BASE_URL || '').replace(/\/+$/, '');
    const networkChanged = priorNetwork && priorNetwork !== network;
    if (existingBaseUrl && existingBaseUrl !== baseUrl) console.log(`Replacing Bounties URL ${existingBaseUrl} with the reviewed origin for ${network}.`);
    console.log(`Bounties URL: ${baseUrl}`);

    // 3) Owner/sweep
    const ownerDefault = current.OFFBOT_ADDRESS && isAddress(current.OFFBOT_ADDRESS) ? current.OFFBOT_ADDRESS : '';
    let ownerAddress = (await rl.question('Owner address (human EOA) 0x…: ')).trim();
    if (!isAddress(ownerAddress)) throw new Error('Invalid owner address.');

    let sweepAddress = (await rl.question(`Sweep address 0x… [${ownerDefault || ownerAddress}]: `)).trim();
    if (!sweepAddress) sweepAddress = ownerDefault || ownerAddress;
    if (!isAddress(sweepAddress)) throw new Error('Invalid sweep address.');

    // 4) Keystore path default in secrets dir
    const keystoreDefault = current.VERDIKTA_KEYSTORE_PATH || process.env.VERDIKTA_KEYSTORE_PATH || `${secretsDir}/verdikta-wallet.json`;

    // 5) Wallet password: never written to disk. From VERDIKTA_WALLET_PASSWORD (a secret store) or typed here.
    const keystoreExisted = await fileExists(resolvePath(keystoreDefault));
    const password = await walletPassword({
      prompt,
      purpose: keystoreExisted ? 'unlock the existing bot wallet' : 'encrypt the new bot wallet',
      confirm: !keystoreExisted,
    });

    // Apply env patch (idempotent)
    const patched = upsertEnv(removeEnvKey(currentEnvText, PASSWORD_ENV), {
      VERDIKTA_NETWORK: network,
      VERDIKTA_BOUNTIES_BASE_URL: baseUrl,
      VERDIKTA_SECRETS_DIR: secretsDir,
      VERDIKTA_KEYSTORE_PATH: keystoreDefault,
      OFFBOT_ADDRESS: sweepAddress,
    });
    await fs.writeFile(envPath, patched, { mode: 0o600 });
    await fs.chmod(envPath, 0o600);

    console.log(`\nSaved config: ${envPath} (survives skill updates)`);
    console.log('Secrets dir:', secretsDir);

    // Reload env into process (dotenv was loaded before; but our helper reads process.env, not file)
    process.env.VERDIKTA_NETWORK = network;
    process.env.VERDIKTA_BOUNTIES_BASE_URL = baseUrl;
    process.env.VERDIKTA_SECRETS_DIR = secretsDir;
    process.env.VERDIKTA_KEYSTORE_PATH = keystoreDefault;

    // 6) Wallet — reuse the same keystore regardless of network.
    // EVM addresses are network-agnostic; only the configuration and funding differ.
    const keystoreAbsPath = resolvePath(keystoreDefault);
    const keystoreAlreadyExists = await fileExists(keystoreAbsPath);

    if (keystoreAlreadyExists && priorNetwork && priorNetwork !== network) {
      console.log(`\nNetwork changed: ${priorNetwork} → ${network}`);
      console.log(`Reusing existing wallet at: ${keystoreAbsPath}`);
      console.log('(The same address works on any EVM network — only funding differs.)');
    }

    const { wallet, abs: keystoreAbs, created, imported } = await ensureWalletKeystore({
      keystorePath: keystoreDefault,
      password,
      prompt,
    });

    const statusLabel = imported ? ' (imported)' : created ? ' (created)' : '';
    console.log(`\nBot wallet: ${wallet.address}`);
    console.log(`Keystore:  ${keystoreAbs}${statusLabel}`);

    // 7) Funding (human action)
    const minEth = envNum('MIN_ETH', network === 'base-sepolia' ? 0.01 : 0.005);

    const pollSeconds = envNum('FUNDING_POLL_SECONDS', 15);

    console.log('\nHuman action required: fund the bot wallet');
    if (networkChanged) {
      console.log(`\n  NOTE: You switched from ${priorNetwork} to ${network}.`);
      console.log('  Your wallet address is the same, but funds on one network');
      console.log('  are NOT visible on the other. You need to send new funds');
      console.log(`  on the ${network} network to the address below.\n`);
    }
    console.log(`- Send ETH on ${network} to: ${wallet.address}`);

    console.log(`Target: ≥ ${minEth} ETH; no LINK is required.`);

    if (!hasFlag('no-wait')) {
      await waitForFunding({ network, address: wallet.address, minEth, pollSeconds });
    } else {
      console.log('(Skipping funding wait due to --no-wait)');
    }

    // 8) Register bot + save API key
    const botNameDefault = arg('name', current.BOT_NAME || 'MyBot');
    const botDescDefault = arg('description', current.BOT_DESCRIPTION || 'Verdikta bounty worker');

    await ensureDir(secretsDir);
    const botOut = path.join(secretsDir, 'verdikta-bounties-bot.json');

    // Reuse existing bot api key if present (non-clean install)
    let apiKey = null;
    if (await fileExists(botOut)) {
      try {
        const existing = JSON.parse(await fs.readFile(botOut, 'utf8'));
        apiKey = existing?.apiKey || existing?.api_key || existing?.bot?.apiKey || existing?.bot?.api_key || null;
      } catch {}

      if (apiKey) {
        if (networkChanged) {
          console.log(`\nFound existing bot API key, but network changed (${priorNetwork} → ${network}).`);
          console.log('The existing key was registered on a different server and will not work.');
          const reuse = (await rl.question('Register a new bot on the new network? (Y/n) ')).trim().toLowerCase();
          apiKey = (reuse === 'n' || reuse === 'no') ? apiKey : null;
        } else {
          const reuse = (await rl.question(`\nFound existing bot API key file. Reuse it? (Y/n) `)).trim().toLowerCase();
          if (reuse === 'n' || reuse === 'no') {
            apiKey = null;
          }
        }
      }
    }

    if (!apiKey) {
      const botName = (await rl.question(`\nBot name [${botNameDefault}]: `)).trim() || botNameDefault;
      const botDescription = (await rl.question(`Bot description [${botDescDefault}]: `)).trim() || botDescDefault;

      const reg = await registerBot({ baseUrl, name: botName, ownerAddress, description: botDescription });
      apiKey = reg.apiKey;
      await fs.writeFile(botOut, JSON.stringify(reg.data, null, 2), { mode: 0o600 });
      await fs.chmod(botOut, 0o600);

      console.log(`\n✅ Registered bot. Saved: ${botOut}`);
      console.log('API key: saved to file (not reprinted here).');
    } else {
      console.log(`\n✅ Reusing existing bot API key file: ${botOut}`);
    }

    // 9) Smoke test: list jobs
    const jobsRes = await fetch(`${baseUrl}/api/jobs?status=OPEN&minHoursLeft=0`, {
      headers: { 'X-Bot-API-Key': apiKey }
    });
    const jobsText = await jobsRes.text();
    if (!jobsRes.ok) {
      throw new Error(`Smoke test failed: /api/jobs HTTP ${jobsRes.status} - ${jobsText}`);
    }
    const jobsJson = JSON.parse(jobsText);
    const count = Array.isArray(jobsJson.jobs) ? jobsJson.jobs.length : 0;

    console.log(`\n✅ Smoke test OK: can list jobs (OPEN jobs returned: ${count})`);

    // 10) Optional read-only check, left to the operator: onboarding starts no child process.
    console.log(`\nTo list open bounties (read-only): VERDIKTA_BOT_FILE=${botOut} node ${fileURLToPath(new URL('./bounty_worker_min.js', import.meta.url))}`);

    console.log('\nKeystore:');
    console.log(`- Path: ${keystoreAbs}`);
    console.log('- Private keys are never exported or printed. Keys are decrypted in-memory only when signing.');
    console.log(`- The wallet password was not stored. For unattended runs, supply ${PASSWORD_ENV} from a secret store`);
    console.log('  (OpenClaw: a SecretRef on skills.entries.verdikta-bounties-onboarding.apiKey; see references/onboarding.md#wallet-password).');

  } finally {
    prompt.close();
  }
}

// Removes a pre-1.6.0 plaintext password from the stable .env, but only once it is safe: the stored password must
// unlock the keystore, and the operator must hold it elsewhere (typed back or exported), or have it moved to a file
// they named for a file SecretRef. Nothing is removed if either check fails.
async function migratePassword({ envPath, envText, secretsDir, prompt }) {
  const vars = dotenv.parse(envText); // the same parsing the scripts used when they still loaded it
  const stored = vars[PASSWORD_ENV];
  if (!stored) {
    console.log(`${envPath} holds no ${PASSWORD_ENV}; nothing to migrate.`);
    return;
  }
  const keystore = resolvePath(vars.VERDIKTA_KEYSTORE_PATH || `${secretsDir}/verdikta-wallet.json`);
  const wallet = await Wallet.fromEncryptedJson(await fs.readFile(keystore, 'utf8'), stored).catch(() => null);
  if (!wallet) throw new Error(`The password in ${envPath} does not unlock ${keystore}; nothing was changed.`);

  const target = arg('to-file');
  if (target) {
    if (!target.startsWith('/') && !target.startsWith('~/')) throw new Error('--to-file needs an absolute path or ~/...');
    const dest = path.resolve(resolvePath(target));
    const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (dest === path.resolve(envPath) || dest.startsWith(skillDir + path.sep)) throw new Error('Keep the password file outside the skill directory and separate from the .env');
    if (await fileExists(dest)) {
      if ((await fs.readFile(dest, 'utf8')).replace(/\r?\n$/, '') !== stored) throw new Error(`${dest} already exists with other content; choose another path`);
    } else {
      await ensureDir(path.dirname(dest));
      await fs.writeFile(dest, stored, { mode: 0o600, flag: 'wx' });
    }
    await fs.chmod(dest, 0o600);
    console.log(`Wrote the wallet password to ${dest} (mode 600).`);
  } else {
    const held = process.env[PASSWORD_ENV] || await walletPassword({ prompt, purpose: 'confirm you keep it elsewhere' });
    if (held !== stored) throw new Error('That does not match the stored password; nothing was changed. Store it in your secret manager first, or use --to-file.');
  }

  let nextEnv = removeEnvKey(envText, PASSWORD_ENV).replace(/\s+$/, '') + os.EOL;
  // A named file is also recorded as the scripts' password source; the path is not a secret.
  if (target) nextEnv = upsertEnv(nextEnv, { [PASSWORD_FILE_ENV]: path.resolve(resolvePath(target)) });
  await fs.writeFile(envPath, nextEnv, { mode: 0o600 });
  await fs.chmod(envPath, 0o600);
  console.log(`Removed ${PASSWORD_ENV} from ${envPath}. Wallet ${wallet.address} is unchanged.`);
  if (target) console.log(`Recorded ${PASSWORD_FILE_ENV}=${path.resolve(resolvePath(target))} in ${envPath}; the scripts read the password from that file.`);
  console.log(`\nFor OpenClaw runtimes that inject skill secrets (not Codex-harness shells), you can also bind ${PASSWORD_ENV}:`);
  if (target) {
    console.log(`  secrets.providers.verdikta_wallet = { source: "file", path: "${path.resolve(resolvePath(target))}", mode: "singleValue" }`);
    console.log('  skills.entries.verdikta-bounties-onboarding.apiKey = { source: "file", provider: "verdikta_wallet", id: "value" }');
  } else {
    console.log('  skills.entries.verdikta-bounties-onboarding.apiKey = a SecretRef to your secret store (references/onboarding.md#wallet-password)');
  }
  console.log('Run `openclaw secrets audit --check` afterwards, and delete any backup copies of the old .env.');
}

main().catch((e) => {
  console.error('Onboarding failed:', e?.message || e);
  process.exit(1);
});
