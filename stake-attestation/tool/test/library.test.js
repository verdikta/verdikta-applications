// Acceptance 5: a library API the CLI wraps. The CLI holds no flow of its own: each verb is the library's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the package exports the library, and createHunter has every verb', async () => {
  assert.equal(manifest.exports['.'], './src/index.js');
  const lib = await import('../src/index.js');
  const hunter = lib.createHunter({ provider: {}, contract: `0x${'11'.repeat(20)}` });
  for (const name of ['check', 'commit', 'reveal', 'status', 'finalize', 'settle', 'withdraw', 'claim', 'readListing']) {
    assert.equal(typeof hunter[name], 'function', name);
  }
  for (const name of ['createHunter', 'createPinner', 'ToolError', 'buildClaimArchive', 'COMMIT_STEPS', 'REVEAL_STEPS', 'lintObservable', 'commitNotice', 'rawCid', 'scrubber']) {
    assert.notEqual(lib[name], undefined, name);
  }
});

test('the CLI goes through createHunter: it starts no transaction of its own', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(src, /createHunter/);
  assert.doesNotMatch(src, /signTransaction|broadcastTransaction|sendTransaction/);
});

test('a verb that needs a wallet says so when none was given', async () => {
  const { createHunter } = await import('../src/index.js');
  const hunter = createHunter({ provider: {}, contract: `0x${'11'.repeat(20)}` });
  await assert.rejects(hunter.withdraw(), (e) => e.code === 'WALLET_KEY_MISSING');
});

test('pinner credentials are read when a pin is made, and an unknown backend is refused', async () => {
  const { createPinner } = await import('../src/index.js');
  assert.throws(() => createPinner({ backend: 'carrier-pigeon', url: 'http://x' }), (e) => e.code === 'PIN_CONFIG');
  const p = createPinner({ backend: 'pinata', url: 'http://127.0.0.1:1', token: null });
  await assert.rejects(p.pin(Buffer.from('x')), (e) => e.code === 'PIN_CONFIG');
});
