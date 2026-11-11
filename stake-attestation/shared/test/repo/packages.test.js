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

// Node P21: every package that reads @verdikta/common reads one release of it, the one the arbiters at the pin run
// (e2e/test/requestSize.test.js holds e2e's to the arbiter's), pinned exactly and locked to the registry's tarball
// with its integrity hash. Moving it is one change to all six, with the arbiter pin (README, "Moving the arbiter pin").
const COMMON = '@verdikta/common';
const COMMON_RELEASE = '1.9.0-attest.5';
// the registry's own (npm view @verdikta/common@1.9.0-attest.5 dist.integrity): it moves with the release
const COMMON_INTEGRITY = 'sha512-AQjH2x/tr7WwaJpPdbvJB077fbUQCom2skEFgJ2L2owbaQUvy9TsMeCgLhtk47dPB0LrN/QwtRP/aT+6V66DuA==';
const COMMON_READERS = ['onchain', 'server', 'client', 'tool', 'builder', 'e2e'];

test(`the packages that read ${COMMON} pin exactly ${COMMON_RELEASE}, locked to the registry with an integrity hash`, () => {
  const readers = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(APP_DIR, pkg);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const pinned = manifest.dependencies?.[COMMON] ?? manifest.devDependencies?.[COMMON];
    if (pinned === undefined) continue;
    readers.push(pkg);
    assert.equal(pinned, COMMON_RELEASE, `${pkg}/package.json pins ${COMMON} ${pinned}`);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    const locked = lock.packages[`node_modules/${COMMON}`];
    assert.ok(locked, `${pkg}/package-lock.json locks ${COMMON}`);
    assert.equal(locked.version, COMMON_RELEASE, `${pkg}/package-lock.json`);
    assert.equal(locked.resolved, `https://registry.npmjs.org/${COMMON}/-/common-${COMMON_RELEASE}.tgz`, `${pkg}/package-lock.json`);
    assert.equal(locked.integrity, COMMON_INTEGRITY, `${pkg}/package-lock.json`);
    // one copy: nothing in the tree brings a release of its own
    const others = Object.keys(lock.packages).filter((k) => k !== `node_modules/${COMMON}` && k.endsWith(`node_modules/${COMMON}`));
    assert.deepEqual(others, [], `${pkg}/package-lock.json`);
  }
  assert.deepEqual(readers.sort(), [...COMMON_READERS].sort());
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
