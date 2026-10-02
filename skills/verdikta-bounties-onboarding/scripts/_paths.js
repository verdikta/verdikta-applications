import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export function defaultSecretsDir() {
  // Prefer XDG-ish location; keeps secrets out of the repo. A configured `~/...` (as .env files often hold) is
  // expanded here: left literal it would name a "~" directory under the working directory.
  const configured = process.env.VERDIKTA_SECRETS_DIR;
  if (!configured) return path.join(os.homedir(), '.config', 'verdikta-bounties');
  return configured === '~' || configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(1)) : path.resolve(configured);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
