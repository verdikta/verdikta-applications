// The app's CI: triggered by PRs into main and the integration branch that touch the app, runs
// every package's install and tests, the contract tests, the Playwright smoke test and the
// banned-words check, and uses no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { PACKAGES, REPO_ROOT } from './helpers.js';

const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'stake-attestation.yml');
const text = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';
const wf = text ? parse(text) : {};

// Every `run` with its effective working directory, across all jobs.
function runs() {
  const out = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    const matrix = job.strategy?.matrix ?? {};
    const expand = (s) => {
      if (typeof s !== 'string') return [s];
      const m = s.match(/\$\{\{\s*matrix\.(\w+)\s*\}\}/);
      if (!m) return [s];
      return (matrix[m[1]] ?? []).map((v) => s.replaceAll(m[0], v));
    };
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      const dirs = step['working-directory']
        ? expand(step['working-directory'])
        : expand(job.defaults?.run?.['working-directory'] ?? '.');
      for (const dir of dirs) {
        for (const run of expand(step.run)) out.push({ dir, run, job });
      }
    }
  }
  return out;
}

test('the workflow file exists', () => {
  assert.ok(text, `${path.relative(REPO_ROOT, WORKFLOW)} is missing`);
});

test('runs on pull requests into main and claude/stake-attestation that touch the app', () => {
  const pr = wf.on?.pull_request;
  assert.ok(pr, 'pull_request trigger');
  assert.deepEqual([...pr.branches].sort(), ['claude/stake-attestation', 'main']);
  assert.ok(pr.paths.includes('stake-attestation/**'));
  assert.ok(pr.paths.includes('.github/workflows/stake-attestation.yml'));
});

test('needs no secrets and only reads the repository', () => {
  assert.equal(/secrets\./.test(text), false, 'the workflow references a secret');
  assert.deepEqual(wf.permissions, { contents: 'read' });
});

test('every package gets npm ci and its tests', () => {
  const all = runs();
  for (const pkg of PACKAGES) {
    const dir = `stake-attestation/${pkg}`;
    const here = all.filter((r) => r.dir === dir);
    assert.ok(here.some((r) => /\bnpm ci\b/.test(r.run)), `${pkg}: npm ci`);
    const testCmd = pkg === 'onchain' ? /\bnpx hardhat test\b/ : /\bnpm test\b/;
    assert.ok(here.some((r) => testCmd.test(r.run)), `${pkg}: tests`);
  }
});

test('runs the Playwright smoke test in the client', () => {
  const client = runs().filter((r) => r.dir === 'stake-attestation/client');
  assert.ok(client.some((r) => /npx playwright install\b.*chromium/.test(r.run)), 'browser install');
  assert.ok(client.some((r) => /\bnpx playwright test\b/.test(r.run)), 'playwright test');
});

test('checks the whole app and this workflow for the banned words', () => {
  const check = runs().find((r) => /check-forbidden-words\.js/.test(r.run));
  assert.ok(check, 'banned-words step');
  assert.match(check.run, /\bstake-attestation\b(?!\/)/, 'scans the app folder');
  assert.match(check.run, /\.github\/workflows\/stake-attestation\.yml/, 'scans the workflow');
});

test('the scope test can see the base branch (full history checkout)', () => {
  const job = runs().find((r) => /\bnpm test\b/.test(r.run) && r.dir === 'stake-attestation/shared').job;
  const checkout = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.['fetch-depth'], 0);
});

test('third-party actions are pinned to a commit', () => {
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}\b/, step.uses);
    }
  }
});
