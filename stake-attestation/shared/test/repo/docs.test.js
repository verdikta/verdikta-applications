// The app README states the wording rule without writing the words, and docs/BUILD_PLAN.md is
// the task's build plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { findForbiddenWords } from '../../src/index.js';
import { APP_DIR } from './helpers.js';

const README = path.join(APP_DIR, 'README.md');
const PLAN = path.join(APP_DIR, 'docs', 'BUILD_PLAN.md');

test('README states the wording rule, points at the helper and CI, and spells neither word', () => {
  const text = fs.readFileSync(README, 'utf8');
  assert.match(text, /^## Wording rule$/m);
  assert.match(text, /shared\/src\/forbiddenWords\.js/);
  assert.match(text, /check-forbidden-words/);
  assert.deepEqual(findForbiddenWords(text), []);
});

test('README says this is a separate site and the bounty program is untouched', () => {
  const text = fs.readFileSync(README, 'utf8');
  assert.match(text, /BountyEscrow/);
  assert.match(text, /decision 18/);
});

test('docs/BUILD_PLAN.md is the build plan', () => {
  const text = fs.readFileSync(PLAN, 'utf8');
  assert.match(text, /^# Stake attestation MVP — build plan$/m);
  for (const heading of ['## Nodes', '## Design errata this build applies', '## Assumptions the build makes', '## Decisions for the owner']) {
    assert.ok(text.includes(heading), heading);
  }
  assert.match(text, /^\| P1 \| Scaffold the stake-attestation app with its own CI \|/m);
});

// The task folder's copy is outside the repository; compare when it is available.
test('docs/BUILD_PLAN.md is byte-identical to the task copy', { skip: !process.env.SA_TASK_BUILD_PLAN }, () => {
  assert.ok(fs.readFileSync(PLAN).equals(fs.readFileSync(process.env.SA_TASK_BUILD_PLAN)));
});
