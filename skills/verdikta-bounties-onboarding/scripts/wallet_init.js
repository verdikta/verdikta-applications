#!/usr/bin/env node
import { Wallet } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const out = arg('out', 'secrets/verdikta-wallet.json');
const password = process.env.VERDIKTA_WALLET_PASSWORD;
if (!password) {
  console.error('Missing VERDIKTA_WALLET_PASSWORD');
  process.exit(1);
}

const wallet = Wallet.createRandom();
const json = await wallet.encrypt(password);

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, json, { mode: 0o600 });

console.log('Bot wallet created');
console.log('Address:', wallet.address);
console.log('Keystore:', out);
console.log('Next: fund this address with ETH on Base, then swap some ETH→LINK.');
