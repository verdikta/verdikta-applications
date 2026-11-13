// The production build carries /agents.txt and /llms.txt (node P27): Vite copies public/ to the build's root, and the
// deploy kit serves the build's root as the site's (deploy/nginx, `root`). This builds the client into a folder of its
// own, as `npm run build` does with vite.config.js, and reads both files there, byte for byte.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-client-build-'));
after(() => fs.rmSync(outDir, { recursive: true, force: true }));

test('vite build puts agents.txt and llms.txt at the root of the build, as they are in public/', async () => {
  await build({ root: CLIENT, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'the build ran');
  for (const name of ['agents.txt', 'llms.txt']) {
    const built = path.join(outDir, name);
    assert.ok(fs.existsSync(built), `${name} is in the build`);
    assert.ok(fs.readFileSync(built).equals(fs.readFileSync(path.join(CLIENT, 'public', name))), `${name} is the public file, byte for byte`);
  }
});
