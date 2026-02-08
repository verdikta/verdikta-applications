#!/usr/bin/env node
import './_env.js';
import { Wallet } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

import { defaultSecretsDir, ensureDir } from './_paths.js';

const outArg = arg('out', `${defaultSecretsDir()}/verdikta-wallet.json`);
const password = process.env.VERDIKTA_WALLET_PASSWORD;
if (!password) {
  console.error('Missing VERDIKTA_WALLET_PASSWORD');
  process.exit(1);
}

const wallet = Wallet.createRandom();
const json = await wallet.encrypt(password);

// Resolve out path relative to this script's directory to avoid CWD confusion
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const out = path.isAbsolute(outArg) ? outArg : path.resolve(scriptDir, outArg);

await ensureDir(path.dirname(out));
await fs.writeFile(out, json, { mode: 0o600 });

console.log('Bot wallet created');
console.log('Address:', wallet.address);
console.log('Keystore:', out);
console.log('Next: fund this address with ETH on Base, then swap some ETH→LINK.');
