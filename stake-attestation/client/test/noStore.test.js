// The private disclosure key is never written to a persistent store: the client's source uses no
// browser storage at all (the Playwright test checks the stores after a whole session as well).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STORES = /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|serviceWorker|BroadcastChannel|postMessage)\b/;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('no source file under src/ touches a browser store or another window', () => {
  const hits = [];
  for (const f of files(SRC).filter((p) => /\.(jsx?|mjs)$/.test(p))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (STORES.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
