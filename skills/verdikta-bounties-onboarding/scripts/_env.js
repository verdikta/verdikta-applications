// Loads environment variables for the Verdikta Bounties skill.
//
// Load order (dotenv does NOT overwrite already-set vars, so first wins):
//   1) ~/.config/verdikta-bounties/.env   — stable path, survives skill updates
//   2) scripts/.env (next to this file)   — dev convenience / local override
//
// If only scripts/.env exists (pre-migration), a one-time notice is printed
// directing the user to run onboard.js to migrate.

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
  dotenv.config({ path: stableEnvPath });
}

if (localExists) {
  dotenv.config({ path: localEnvPath });
}

if (localExists && !stableExists) {
  console.warn(
    `\n⚠  NOTICE: Your config is in scripts/.env which will be lost on skill updates.\n` +
    `   Run 'node onboard.js' to migrate to ${stableEnvPath}\n`
  );
}
