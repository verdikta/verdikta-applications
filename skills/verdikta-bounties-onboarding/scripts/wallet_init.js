#!/usr/bin/env node
import './_env.js';
import { Wallet } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { arg, resolvePath } from './_lib.js';
import { defaultSecretsDir, ensureDir } from './_paths.js';

const outArg = arg('out', `${defaultSecretsDir()}/verdikta-wallet.json`);
const password = process.env.VERDIKTA_WALLET_PASSWORD;
if (!password) {
  console.error('Missing VERDIKTA_WALLET_PASSWORD');
  process.exit(1);
}

const wallet = Wallet.createRandom();
const json = await wallet.encrypt(password);

// Resolve out path: handles ~ expansion and resolves relative paths against scripts dir
const out = resolvePath(outArg);

await ensureDir(path.dirname(out));
await fs.writeFile(out, json, { mode: 0o600 });

console.log('Bot wallet created');
console.log('Address:', wallet.address);
console.log('Keystore:', out);
console.log('Next: fund this address with ETH on Base, then swap some ETH→LINK.');
