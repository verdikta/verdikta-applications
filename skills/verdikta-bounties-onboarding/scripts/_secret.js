// The keystore password is never stored by this skill. In order, it comes from:
//   1) VERDIKTA_WALLET_PASSWORD in the process environment (a secret store; OpenClaw injects it from a SecretRef on
//      skills.entries.verdikta-bounties-onboarding.apiKey, but that does not reach Codex-harness shells),
//   2) VERDIKTA_WALLET_PASSWORD_FILE, only when the operator sets it: a mode-600 file they own, outside the skill and
//      separate from the configuration .env (the file a file SecretRef would point at),
//   3) a no-echo prompt in a human-controlled terminal.
// There is no implicit file fallback, and the configuration .env is never a password source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const PASSWORD_ENV = 'VERDIKTA_WALLET_PASSWORD';
export const PASSWORD_FILE_ENV = 'VERDIKTA_WALLET_PASSWORD_FILE';
export const PASSWORD_GUIDANCE =
  `${PASSWORD_ENV} is not set. Provide it from a secret store, set ${PASSWORD_FILE_ENV} to a mode-600 password file you ` +
  'keep outside this skill, or run this in a terminal to type it (references/onboarding.md#wallet-password). ' +
  'It is never read from the configuration .env.';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Reads the operator-named password file, refusing anything that would widen who can read or replace it.
export function readPasswordFile(configured, { home = os.homedir(), uid = process.getuid?.() } = {}) {
  const raw = String(configured).trim();
  if (!raw.startsWith('/') && !raw.startsWith('~/')) throw new Error(`${PASSWORD_FILE_ENV} must be an absolute path or ~/...`);
  const file = path.resolve(raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
  if (file.startsWith(SKILL_DIR + path.sep)) throw new Error(`${PASSWORD_FILE_ENV} must point outside the skill directory`);
  if (path.basename(file) === '.env' || path.basename(file).startsWith('.env.')) throw new Error(`${PASSWORD_FILE_ENV} must not be a .env file`);
  let st;
  try { st = fs.lstatSync(file); } catch { throw new Error(`${PASSWORD_FILE_ENV} names a file that does not exist: ${file}`); }
  if (!st.isFile()) throw new Error(`${PASSWORD_FILE_ENV} must name a regular file, not a link or directory: ${file}`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${PASSWORD_FILE_ENV} must be owned by the user running the scripts: ${file}`);
  if (st.mode & 0o077) throw new Error(`${PASSWORD_FILE_ENV} must not be readable or writable by group or others (chmod 600): ${file}`);
  if (st.size > 1024) throw new Error(`${PASSWORD_FILE_ENV} is larger than a password file should be: ${file}`);
  const password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!password) throw new Error(`${PASSWORD_FILE_ENV} is empty: ${file}`);
  return password;
}

// A readline interface whose output can be muted, so typed secrets are not echoed (public APIs only).
export function createPrompt({ input = process.stdin, output = process.stdout } = {}) {
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  const rl = readline.createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
  return {
    rl,
    question: q => rl.question(q),
    async hidden(q) {
      output.write(q);
      muted = true;
      try { return (await rl.question('')).trim(); } finally { muted = false; output.write('\n'); }
    },
    close: () => rl.close(),
  };
}

export async function walletPassword({ prompt, purpose = 'unlock the bot wallet', confirm = false, env = process.env, input = process.stdin } = {}) {
  if (env[PASSWORD_ENV]) return env[PASSWORD_ENV];
  if (env[PASSWORD_FILE_ENV]) return readPasswordFile(env[PASSWORD_FILE_ENV]);
  if (!input.isTTY) throw new Error(PASSWORD_GUIDANCE);
  const ask = prompt || createPrompt({ input });
  try {
    const password = await ask.hidden(`Wallet password (to ${purpose}; not stored): `);
    if (!password) throw new Error('Empty wallet password');
    if (confirm && (await ask.hidden('Repeat the wallet password: ')) !== password) throw new Error('Passwords do not match');
    return password;
  } finally {
    if (!prompt) ask.close();
  }
}

// Remove every assignment of `key` (plain or `export KEY=`) from .env text, keeping all other lines as they are.
export function removeEnvKey(text, key) {
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  return String(text).split(/\r?\n/).filter(line => !assignment.test(line)).join('\n');
}
