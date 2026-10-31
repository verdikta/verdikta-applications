// The two banned words are never written in this repository, tests included: the tests build
// their samples from the helper's own output, so this file passes the check it tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { FORBIDDEN_WORDS, findForbiddenWords, scanPaths } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'check-forbidden-words.js');
const [participle, noun] = FORBIDDEN_WORDS;

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-words-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

test('builds exactly the two banned words from parts', () => {
  assert.equal(FORBIDDEN_WORDS.length, 2);
  assert.ok(Object.isFrozen(FORBIDDEN_WORDS));
  assert.equal(participle.slice(0, 4), 'cert');
  assert.equal(noun.slice(0, 4), 'cert');
  assert.ok(participle.endsWith('ied'));
  assert.ok(noun.endsWith('ication'));
  // The helper's source holds neither word whole.
  const source = fs.readFileSync(path.join(here, '..', 'src', 'forbiddenWords.js'), 'utf8').toLowerCase();
  for (const word of FORBIDDEN_WORDS) assert.equal(source.includes(word), false, 'helper source spells a banned word');
});

test('finds either word in any case, inside longer words, with line and column', () => {
  const text = `fine line\nA ${participle.toUpperCase()} badge\nno-${noun}s here`;
  const hits = findForbiddenWords(text);
  assert.deepEqual(
    hits.map(({ word, line, column }) => ({ word, line, column })),
    [
      { word: participle, line: 2, column: 3 },
      { word: noun, line: 3, column: 4 },
    ]
  );
  assert.deepEqual(findForbiddenWords('certify, certificate and cert are allowed'), []);
});

test('scanPaths walks source, UI strings and docs, skipping dependencies and build output', () => {
  const root = tmpTree({
    'package.json': '{}',
    'src/App.jsx': `<h1>${noun}</h1>`,
    'src/cache/notes.md': participle,
    'pkg/node_modules/dep/index.js': participle,
    'src/strings.js': 'export const title = "Stake attestation";',
    'docs/guide.md': `A ${participle} record`,
    'node_modules/pkg/index.js': participle,
    'dist/assets/app.js': participle,
    'artifacts/x.json': participle,
    'cache/y.json': participle,
    'coverage/index.html': participle,
    'playwright-report/index.html': participle,
    'test-results/r.txt': participle,
    'package-lock.json': JSON.stringify({ name: participle }),
    'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  });
  const result = scanPaths([root]);
  const files = result.hits.map((h) => path.relative(root, h.file)).sort();
  // Output folder names are skipped only beside a package.json; src/cache is source.
  assert.deepEqual(files, ['docs/guide.md', 'src/App.jsx', 'src/cache/notes.md']);
  assert.ok(result.filesScanned >= 3);
});

test('the CLI exits 1 and names file:line:column on a hit, 0 when clean', () => {
  const dirty = tmpTree({ 'README.md': `# Title\n\nNot ${participle}.\n` });
  const bad = spawnSync(process.execPath, [cli, dirty], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /README\.md:3:5/);

  const clean = tmpTree({ 'README.md': '# Title\n\nA statement of stake and judgement.\n' });
  const ok = spawnSync(process.execPath, [cli, clean], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /no banned words/);
});

test('the CLI refuses a path that does not exist instead of passing silently', () => {
  const missing = path.join(os.tmpdir(), 'sa-words-missing-' + Date.now());
  const res = spawnSync(process.execPath, [cli, missing], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});
