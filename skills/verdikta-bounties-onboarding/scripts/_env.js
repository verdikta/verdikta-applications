// Loads environment variables for the Verdikta Bounties skill.
//
// Load order:
//   1) already-exported process environment variables
//   2) ~/.config/verdikta-bounties/.env — stable path, survives skill updates (configuration only)
//
// The wallet password is never read from this .env (see _secret.js for its sources). If the stable .env still holds VERDIKTA_WALLET_PASSWORD
// (installations before 1.6.0), every script refuses to run until `node onboard.js --migrate-password` removes it.
//
// scripts/.env is intentionally ignored. Keeping credentials or endpoint
// overrides in the skill directory broadens secret lookup scope and can be
// overwritten or shipped accidentally.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stableEnvPath = path.join(os.homedir(), '.config', 'verdikta-bounties', '.env');
const localEnvPath = path.resolve(__dirname, '.env');

const stableExists = fs.existsSync(stableEnvPath);
const localExists = fs.existsSync(localEnvPath);

if (stableExists) {
  const values = dotenv.parse(fs.readFileSync(stableEnvPath));
  const migrating = process.argv.includes('--migrate-password') && path.basename(process.argv[1] || '') === 'onboard.js';
  if ('VERDIKTA_WALLET_PASSWORD' in values && !migrating) {
    console.error(
      `\nRefusing to run: ${stableEnvPath} stores VERDIKTA_WALLET_PASSWORD in plaintext.\n` +
      'Since 1.6.0 the wallet password is never kept on disk by this skill. Move it to a secret store, then run:\n' +
      '  node onboard.js --migrate-password            (you keep the password elsewhere)\n' +
      '  node onboard.js --migrate-password --to-file <path>   (for a file SecretRef outside this config)\n' +
      'See references/migration-1.6.0.md.\n'
    );
    process.exit(1);
  }
  // Same precedence as dotenv: an exported variable wins. The password is never taken from the file.
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'VERDIKTA_WALLET_PASSWORD' && process.env[key] === undefined) process.env[key] = value;
  }
}

if (localExists) {
  console.warn(
    `\nNOTICE: Ignoring scripts/.env for security.\n` +
    `Move Verdikta config to ${stableEnvPath} or export variables in the shell.\n`
  );
}
