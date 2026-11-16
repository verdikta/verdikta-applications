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

// Node P19 (owner, 2026-11-10, Q73 #5): the README's listing section says what a known issue does. Node P20: a
// listing document is the second place, after NatSpec, to state a behaviour as intended.
test('README\'s listing section: a listed root cause settles DUPLICATE whatever the entry says; no bug at all is NatSpec or a listing document, not a known issue', () => {
  const text = fs.readFileSync(README, 'utf8');
  const start = text.indexOf('\n## The listing API\n');
  assert.ok(start >= 0);
  const listing = text.slice(start, text.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.match(listing, /A claim whose root cause is a listed known issue settles DUPLICATE/);
  assert.match(listing, /whatever the entry says about why/);
  assert.match(listing, /To mark a behaviour as no bug at all, leave it off known issues and document it as intended in the code \(NatSpec\)/);
  assert.match(listing, /document it as intended in the code \(NatSpec\) or in a listing document/);
  assert.match(listing, /a claim about it then falls under INVALID/);
});

// Node P20 (owner decision Q61 (a); Q73 #5): the field is offered, and described where a maker and a hunter read.
const SKIP_DIRS = new Set(['node_modules', '.git', '.round', '.arbiter', 'test-results', 'artifacts', 'cache', 'dist', 'playwright-report']);
function appFiles(dir = APP_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) appFiles(path.join(dir, e.name), out);
    } else if (/\.(?:js|jsx|mjs|cjs|json|md|yml|sol|sh)$/.test(e.name) && !/-lock\.json$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}
const sectionOf = (text, heading) => {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const level = heading.split(' ')[0];
  const next = text.slice(start + heading.length + 2).search(new RegExp(`\\n#{1,${level.length}} `));
  return text.slice(start, next < 0 ? undefined : start + heading.length + 2 + next).replace(/\s+/g, ' ');
};

test('P21\'s refusal is gone: no file of the app names its code', () => {
  const code = ['STAKE_DOCUMENTS', 'NOT_OFFERED'].join('_');
  const named = appFiles().filter((f) => fs.readFileSync(f, 'utf8').includes(code)).map((f) => path.relative(APP_DIR, f));
  assert.deepEqual(named, []);
});

test('README: the listing API, the builder and the hunter tool describe stake.documents; the field never widens the scope', () => {
  const text = fs.readFileSync(README, 'utf8');
  const listing = sectionOf(text, '## The listing API');
  assert.match(listing, /`stake\.documents`/);
  assert.match(listing, /up to 16/);
  assert.match(listing, /documentGlobProblem/);
  assert.match(listing, /never widen the scope/);
  const builder = sectionOf(text, '## The environment builder');
  assert.match(builder, /selectDocuments/);
  assert.match(builder, /git ls-tree -r/);
  assert.match(builder, /DOCUMENTS_MATCH_TOO_COSTLY/);
  assert.match(builder, /`sign` repeats/);
  const tool = sectionOf(text, '## The hunter tool');
  assert.match(tool, /documents tier/);
  assert.match(tool, /## Requirement/);
  assert.match(tool, /listing document/);
});

test('no text of the app says documents widen the scope or change the query: every sentence about widening says never', () => {
  const sources = appFiles().filter((f) => /(?:README\.md|\/docs\/[^/]+\.md|\/src\/[^/]+\.jsx?)$/.test(f));
  const bad = [];
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ');
    for (const sentence of text.split(/(?<=[.:;])\s/)) {
      if (/document/i.test(sentence) && /\bwiden/i.test(sentence) && !/\bnever\b|\bnot\b|n't\b|\bno\b/i.test(sentence)) bad.push(`${path.relative(APP_DIR, f)}: ${sentence.slice(0, 160)}`);
    }
  }
  assert.deepEqual(bad, []);
});
