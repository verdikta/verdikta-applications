import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Wallet, encryptKeystoreJsonSync } from 'ethers';
import { walletPassword, removeEnvKey, readPasswordFile } from '../_secret.js';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const synthetic = new Wallet('0x' + '22'.repeat(32)); // Synthetic offline key, never funded.
const keystore = password => encryptKeystoreJsonSync({ address: synthetic.address, privateKey: synthetic.privateKey }, password, { scrypt: { N: 1024 } });

async function home(t, envLines, keystorePassword) {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-pw-test-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = `${dir}/.config/verdikta-bounties`;
  await mkdir(config, { recursive: true });
  if (keystorePassword) await writeFile(`${config}/verdikta-wallet.json`, keystore(keystorePassword));
  await writeFile(`${config}/.env`, [`VERDIKTA_NETWORK=base-sepolia`, `VERDIKTA_KEYSTORE_PATH=${config}/verdikta-wallet.json`, ...envLines].join('\n') + '\n', { mode: 0o600 });
  return { dir, config };
}
const run = (dir, args, extraEnv = {}) => spawnSync(process.execPath, args, { cwd: scripts, encoding: 'utf8', timeout: 20000, input: '', env: { HOME: dir, PATH: process.env.PATH, ...extraEnv } });

test('the wallet password comes from the environment, an operator-named file, or a terminal; never the .env', async t => {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-pwfile-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = `${dir}/wallet-password`; await writeFile(file, 'from-file\n', { mode: 0o600 });
  assert.equal(await walletPassword({ env: { VERDIKTA_WALLET_PASSWORD: 'from-secret-store', VERDIKTA_WALLET_PASSWORD_FILE: file } }), 'from-secret-store');
  assert.equal(await walletPassword({ env: { VERDIKTA_WALLET_PASSWORD_FILE: file }, input: { isTTY: false } }), 'from-file');
  await assert.rejects(walletPassword({ env: {}, input: { isTTY: false } }), /never read from the configuration \.env/);
});

test('a password file must be private, real, and outside the skill and the .env', async t => {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-pwfile-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const good = `${dir}/pw`; await writeFile(good, 'secret', { mode: 0o600 });
  assert.equal(readPasswordFile(good), 'secret');
  const open = `${dir}/open`; await writeFile(open, 'secret'); await chmod(open, 0o644);
  assert.throws(() => readPasswordFile(open), /chmod 600/);
  const link = `${dir}/link`; await symlink(good, link);
  assert.throws(() => readPasswordFile(link), /regular file/);
  const env = `${dir}/.env`; await writeFile(env, 'secret', { mode: 0o600 });
  assert.throws(() => readPasswordFile(env), /must not be a \.env file/);
  assert.throws(() => readPasswordFile('relative/pw'), /absolute path/);
  assert.throws(() => readPasswordFile(`${scripts}package.json`), /outside the skill directory/);
  assert.throws(() => readPasswordFile(`${dir}/missing`), /does not exist/);
  assert.throws(() => readPasswordFile(good, { uid: 123456 }), /owned by the user/);
});

test('removeEnvKey drops only that assignment', () => {
  const text = 'A=1\nVERDIKTA_WALLET_PASSWORD=x\nexport VERDIKTA_WALLET_PASSWORD=y\nVERDIKTA_WALLET_PASSWORD_HINT=keep\n# VERDIKTA_WALLET_PASSWORD=comment';
  assert.equal(removeEnvKey(text, 'VERDIKTA_WALLET_PASSWORD'), 'A=1\nVERDIKTA_WALLET_PASSWORD_HINT=keep\n# VERDIKTA_WALLET_PASSWORD=comment');
});

test('scripts refuse to run while the stable .env stores the password, and never load it', async t => {
  const probe = `await import(${JSON.stringify(new URL('../_env.js', import.meta.url).href)}); console.log(JSON.stringify({ pw: process.env.VERDIKTA_WALLET_PASSWORD ?? null, network: process.env.VERDIKTA_NETWORK }))`;
  const stored = await home(t, ['VERDIKTA_WALLET_PASSWORD=plaintext']);
  const refused = run(stored.dir, ['--input-type=module', '-e', probe]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to run: .* stores VERDIKTA_WALLET_PASSWORD/);
  assert.match(refused.stderr, /onboard\.js --migrate-password/);
  const clean = await home(t, []);
  const ok = run(clean.dir, ['--input-type=module', '-e', probe]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { pw: null, network: 'base-sepolia' });
});

test('migration moves a password that unlocks the keystore to an operator-named file and removes it from .env', async t => {
  const { dir, config } = await home(t, ['VERDIKTA_WALLET_PASSWORD="pw-123" # quoted, as dotenv reads it', 'OFFBOT_ADDRESS=0x0000000000000000000000000000000000000001'], 'pw-123');
  const dest = `${dir}/secrets/verdikta-wallet-password`;
  const r = run(dir, ['onboard.js', '--migrate-password', '--to-file', dest]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(dest, 'utf8'), 'pw-123');
  assert.equal((await stat(dest)).mode & 0o777, 0o600);
  const env = await readFile(`${config}/.env`, 'utf8');
  assert.doesNotMatch(env, /^VERDIKTA_WALLET_PASSWORD=/m);
  assert.match(env, /VERDIKTA_NETWORK=base-sepolia/);
  assert.match(env, /OFFBOT_ADDRESS=0x0+1/);
  assert.ok(env.includes(`VERDIKTA_WALLET_PASSWORD_FILE=${dest}`));
  assert.match(r.stdout, /source: "file", provider: "verdikta_wallet", id: "value"/);
  assert.match(r.stdout, new RegExp(synthetic.address));
});

test('migration changes nothing when the stored password does not unlock the keystore or is not held elsewhere', async t => {
  const wrong = await home(t, ['VERDIKTA_WALLET_PASSWORD=stale'], 'actual');
  const before = await readFile(`${wrong.config}/.env`, 'utf8');
  const r = run(wrong.dir, ['onboard.js', '--migrate-password', '--to-file', `${wrong.dir}/pw`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not unlock/);
  assert.equal(await readFile(`${wrong.config}/.env`, 'utf8'), before);

  const unheld = await home(t, ['VERDIKTA_WALLET_PASSWORD=pw-123'], 'pw-123');
  const before2 = await readFile(`${unheld.config}/.env`, 'utf8');
  const r2 = run(unheld.dir, ['onboard.js', '--migrate-password'], { VERDIKTA_WALLET_PASSWORD: 'something-else' });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /does not match the stored password/);
  assert.equal(await readFile(`${unheld.config}/.env`, 'utf8'), before2);

  const inside = await home(t, ['VERDIKTA_WALLET_PASSWORD=pw-123'], 'pw-123');
  const r3 = run(inside.dir, ['onboard.js', '--migrate-password', '--to-file', `${scripts}/pw.txt`]);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /outside the skill directory/);
});

test('a configured secrets directory with ~ resolves under the home directory', async () => {
  const { defaultSecretsDir } = await import('../_paths.js');
  const saved = process.env.VERDIKTA_SECRETS_DIR;
  try {
    process.env.VERDIKTA_SECRETS_DIR = '~/.config/verdikta-bounties';
    assert.equal(defaultSecretsDir(), `${(await import('node:os')).homedir()}/.config/verdikta-bounties`);
  } finally {
    if (saved === undefined) delete process.env.VERDIKTA_SECRETS_DIR; else process.env.VERDIKTA_SECRETS_DIR = saved;
  }
});

test('migration finds the stable .env when VERDIKTA_SECRETS_DIR is written with ~', async t => {
  const { dir, config } = await home(t, ['VERDIKTA_SECRETS_DIR=~/.config/verdikta-bounties', 'VERDIKTA_WALLET_PASSWORD=pw-123'], 'pw-123');
  const r = run(dir, ['onboard.js', '--migrate-password', '--to-file', `${dir}/secrets/pw`]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(await readFile(`${config}/.env`, 'utf8'), /^VERDIKTA_WALLET_PASSWORD=/m);
});
