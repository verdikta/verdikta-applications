// Loads environment variables for the Verdikta Bounties skill.
//
// Load order:
//   1) already-exported process environment variables
//   2) ~/.config/verdikta-bounties/.env — stable path, survives skill updates
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
  dotenv.config({ path: stableEnvPath });
}

if (localExists) {
  console.warn(
    `\nNOTICE: Ignoring scripts/.env for security.\n` +
    `Move Verdikta config to ${stableEnvPath} or export variables in the shell.\n`
  );
}
