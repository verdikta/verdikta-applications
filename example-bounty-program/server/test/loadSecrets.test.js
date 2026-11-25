// The shared secrets file also holds the contracts' deploy (owner) keys; the web server must never load them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSecrets } = require('../utils/loadSecrets');

const NAMES = ['PRIVATE_KEY', 'PRIVATE_KEY_2', 'MNEMONIC', 'KEEPER_PRIVATE_KEY', 'INFURA_API_KEY', 'IPFS_PINNING_KEY'];

describe('loadSecrets', () => {
  let dir, file, saved;
  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
    NAMES.forEach((k) => delete process.env[k]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    file = path.join(dir, '.env.secrets');
    fs.writeFileSync(file, 'PRIVATE_KEY=0xowner\nPRIVATE_KEY_2=0xowner2\nMNEMONIC="a b c"\nKEEPER_PRIVATE_KEY=0xkeeper\nINFURA_API_KEY=inf\nIPFS_PINNING_KEY=pin\n');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('loads the service keys and never the deploy keys', () => {
    const r = loadSecrets(file, { override: true });
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.parsed)).toHaveLength(6);
    expect(process.env.KEEPER_PRIVATE_KEY).toBe('0xkeeper');
    expect(process.env.INFURA_API_KEY).toBe('inf');
    expect(process.env.PRIVATE_KEY).toBeUndefined();
    expect(process.env.PRIVATE_KEY_2).toBeUndefined();
    expect(process.env.MNEMONIC).toBeUndefined();
    expect(r.dropped.sort()).toEqual(['MNEMONIC', 'PRIVATE_KEY', 'PRIVATE_KEY_2']);
  });

  test('also drops a deploy key that came from elsewhere, and honours override', () => {
    process.env.PRIVATE_KEY = '0xfromdotenv';
    process.env.INFURA_API_KEY = 'local';
    loadSecrets(file, { override: false });
    expect(process.env.PRIVATE_KEY).toBeUndefined();
    expect(process.env.INFURA_API_KEY).toBe('local');
    loadSecrets(file, { override: true });
    expect(process.env.INFURA_API_KEY).toBe('inf');
  });

  test('a missing file is an error, as dotenv.config reports it', () => {
    const r = loadSecrets(path.join(dir, 'nope'));
    expect(r.error).toBeTruthy();
    expect(r.error.code).toBe('ENOENT');
  });

  test('server.js loads the secrets file through it, not dotenv.config', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).not.toMatch(/dotenv'\)\.config\(\{\s*path:\s*secretsPath/);
    expect(src).toMatch(/loadSecrets\(secretsPath/);
  });
});
