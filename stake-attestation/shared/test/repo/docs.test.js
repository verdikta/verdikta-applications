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

// Node P21 (owner, 2026-11-11): the site's origin is decided, and the section names it and no other domain for
// the site. The one other name it holds is the bounty program's, which this site never adds to.
test('README\'s "A separate site" names https://verifiers.verdikta.org as the site\'s origin, and no other domain for it', () => {
  const text = fs.readFileSync(README, 'utf8');
  const start = text.indexOf('\n## A separate site\n');
  assert.ok(start >= 0, 'README: ## A separate site');
  const section = text.slice(start, text.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.match(section, /https:\/\/verifiers\.verdikta\.org\b/);
  assert.match(section, /\borigin\b/);
  assert.doesNotMatch(section, /its own domain/);
  const hosts = [...section.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase())
    .filter((h) => !/\.(?:js|json|md|sol|yml)$/.test(h));
  assert.deepEqual([...new Set(hosts)].sort(), ['bounties.verdikta.org', 'verifiers.verdikta.org']);
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

// Node P19 (owner, 2026-11-10, Q73 #5): the README's listing section says what a known issue does. The listing
// documents field is node P20's and is not named yet.
test('README\'s listing section: a listed root cause settles DUPLICATE whatever the entry says; no bug at all is NatSpec, not a known issue', () => {
  const text = fs.readFileSync(README, 'utf8');
  const start = text.indexOf('\n## The listing API\n');
  assert.ok(start >= 0);
  const listing = text.slice(start, text.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.match(listing, /A claim whose root cause is a listed known issue settles DUPLICATE/);
  assert.match(listing, /whatever the entry says about why/);
  assert.match(listing, /To mark a behaviour as no bug at all, leave it off known issues and document it as intended in the code \(NatSpec\)/);
  assert.match(listing, /a claim about it then falls under INVALID/);
  assert.doesNotMatch(listing, /documents field/i);
});
