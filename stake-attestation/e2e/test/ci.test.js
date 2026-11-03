// "Runs in CI or as one documented command", and the pin: both, read from the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(E2E, '..', '..');
const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'stake-attestation.yml'), 'utf8');
const readme = fs.readFileSync(path.join(E2E, '..', 'README.md'), 'utf8');
const job = /\n {2}e2e:\n([\s\S]*?)(?=\n {2}[a-z0-9-]+:\n|\n*$)/.exec(workflow)?.[1] ?? '';

test('verdikta-arbiter is pinned to a whole commit, fetched by id from its public repository', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(E2E, 'arbiter.pin.json'), 'utf8'));
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.repository, 'https://github.com/verdikta/verdikta-arbiter.git');
  const setup = fs.readFileSync(path.join(E2E, 'src', 'setup.js'), 'utf8');
  assert.match(setup, /PIN\.repository, PIN\.commit/);
});

test('CI has a job for the round, on the class platform, with no secret', () => {
  assert.ok(job, 'no e2e job in the workflow');
  assert.match(job, /runs-on: ubuntu-24\.04/);
  assert.match(job, /working-directory: stake-attestation\/e2e/);
  assert.match(job, /npm ci --ignore-scripts/);
  assert.match(job, /npm test/);
  assert.match(job, /SA_E2E_REQUIRE_CLASS_PLATFORM: '1'/);
  assert.match(job, /timeout-minutes: \d+/);
  assert.doesNotMatch(job, /secrets\./);
});

test('CI checks that nothing was left behind, and keeps the logs of a failed run', () => {
  assert.match(job, /No container left behind/);
  assert.match(job, /if: always\(\)/);
  assert.match(job, /upload-artifact@[0-9a-f]{40}/);
});

test('the README documents the one command, what each platform covers, and what G2 must prove', () => {
  assert.match(readme, /## The local round/);
  assert.match(readme, /cd stake-attestation\/e2e && npm ci && npm test/);
  assert.match(readme, /npm run round/);
  assert.match(readme, /### The mock bridge/);
  assert.match(readme, /### What G2 must prove/);
  assert.match(readme, /linux\/amd64/);
});

test('nothing in the round can reach a live chain, a provider or a pin service by configuration', () => {
  const src = fs.readdirSync(path.join(E2E, 'src')).map((f) => fs.readFileSync(path.join(E2E, 'src', f), 'utf8')).join('\n');
  for (const live of ['sepolia.base.org', 'mainnet.base.org', 'api.pinata.cloud', 'rpc.filebase.io', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) assert.ok(!src.includes(live), live);
  // Every service is started with its own environment, never this shell's.
  assert.doesNotMatch(src, /\.\.\.process\.env/);
});
