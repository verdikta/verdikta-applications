// The shared secrets file also holds the contracts' deploy (owner) keys; the web server must never load them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSecrets } = require('../utils/loadSecrets');

test('loads the service keys and never the deploy keys; keeps values already set', () => {
  const names = ['PRIVATE_KEY', 'PRIVATE_KEY_2', 'INFURA_API_KEY', 'ARB_TEST_LOCAL'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  names.forEach((k) => delete process.env[k]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  const file = path.join(dir, '.env.secrets');
  try {
    fs.writeFileSync(file, 'PRIVATE_KEY=0xowner\nPRIVATE_KEY_2=0xowner2\nINFURA_API_KEY=inf\nARB_TEST_LOCAL=fromfile\n');
    process.env.ARB_TEST_LOCAL = 'local';
    const r = loadSecrets(file);
    assert.strictEqual(process.env.INFURA_API_KEY, 'inf');
    assert.strictEqual(process.env.ARB_TEST_LOCAL, 'local');   // the arbiters server never overrides .env
    assert.strictEqual(process.env.PRIVATE_KEY, undefined);
    assert.strictEqual(process.env.PRIVATE_KEY_2, undefined);
    assert.deepStrictEqual(r.dropped.sort(), ['PRIVATE_KEY', 'PRIVATE_KEY_2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('server.js loads the secrets file through it, not dotenv.config', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /dotenv'\)\.config\(\{ path: process\.env\.VERDIKTA_SECRETS_FILE/);
  assert.match(src, /loadSecrets\(process\.env\.VERDIKTA_SECRETS_FILE/);
});
