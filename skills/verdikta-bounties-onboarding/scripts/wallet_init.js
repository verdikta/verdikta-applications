#!/usr/bin/env node
import './_env.js';
import { Wallet } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { arg, hasFlag, resolvePath } from './_lib.js';
import { defaultSecretsDir, ensureDir } from './_paths.js';
import { createPrompt, walletPassword } from './_secret.js';

const importMode = hasFlag('import');
const outArg = arg('out', `${defaultSecretsDir()}/verdikta-wallet.json`);
// The password encrypts the keystore and is not stored: keep it in your secret store (references/onboarding.md).
const prompt = createPrompt();
let password;
try {
  password = await walletPassword({ prompt, purpose: 'encrypt the new keystore', confirm: true });
} catch (err) {
  prompt.close();
  console.error(err.message);
  process.exit(1);
}

let wallet;

if (importMode) {
  try {
    const key = await prompt.hidden('Paste private key (hex, with or without 0x; not echoed): ');
    const hex = key.replace(/^0x/, '');
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
      console.error('Invalid private key format (expected 64 hex chars).');
      process.exit(1);
    }
    wallet = new Wallet(`0x${hex}`);
  } finally {
    prompt.close();
  }
} else {
  prompt.close();
  wallet = Wallet.createRandom();
}

const json = await wallet.encrypt(password);
const out = resolvePath(outArg);

await ensureDir(path.dirname(out));
await fs.writeFile(out, json, { mode: 0o600 });
await fs.chmod(out, 0o600);

console.log(importMode ? 'Wallet imported and encrypted' : 'Bot wallet created');
console.log('Address:', wallet.address);
console.log('Keystore:', out);
console.log('Next: explicitly select Base or Base Sepolia and fund only this wallet with ETH for the approved work and fees.');
