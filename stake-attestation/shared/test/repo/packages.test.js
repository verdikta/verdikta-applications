// Every package of the app installs reproducibly (package.json + lockfile) and has a test script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { APP_DIR, PACKAGES } from './helpers.js';

test('the app folder holds exactly the known packages', () => {
  const found = fs
    .readdirSync(APP_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(APP_DIR, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
  assert.deepEqual(found, [...PACKAGES].sort());
});

for (const pkg of PACKAGES) {
  test(`${pkg}: package.json, a v3 lockfile that matches it, a test script`, () => {
    const dir = path.join(APP_DIR, pkg);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.equal(manifest.private, true, 'packages are private');
    assert.match(manifest.name, /^@verdikta\/stake-attestation-/);
    assert.equal(lock.name, manifest.name);
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[''].dependencies ?? {}, manifest.dependencies ?? {});
    assert.deepEqual(lock.packages[''].devDependencies ?? {}, manifest.devDependencies ?? {});
    assert.equal(typeof manifest.scripts?.test, 'string');
    assert.ok(manifest.scripts.test.length > 0);
  });
}
