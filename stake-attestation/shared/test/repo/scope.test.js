// The attestation app is a separate site (design §20 decision 18): its changes stay in
// stake-attestation/ and its own workflow, and the bounty program's escrow is never modified.
// A change that needs another path adds it to ALLOWED_OUTSIDE (any change) or ALLOWED_COMMITS (one
// commit) in the same PR, where review sees it. On a PR (CI, or SA_BASE_REF) the whole diff is held to
// it; off one, on a branch that carries other projects' work too, each commit that touches stake-attestation/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from './helpers.js';

// The reusable builder workflow (P3b) lives beside it: GitHub runs a called workflow only from .github/workflows.
// The repository's own proof file (P25) is at its root, where a listing of the repository looks for it.
// Buyer skills' runner pin to ubuntu-24.04 (P28) goes to main too: ubuntu-latest is 26.04, where the bounty client's locked Playwright can't install Chromium.
const ALLOWED_OUTSIDE = ['.github/workflows/stake-attestation.yml', '.github/workflows/stake-attestation-builder.yml', '.github/workflows/stake-attestation-builder-sign.yml', '.verdikta/stake-control.json', '.github/workflows/buyer-skills.yml'];
const UNTOUCHABLE = ['example-bounty-program/onchain/contracts/BountyEscrow.sol'];

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolves(ref) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

// SA_BASE_REF overrides; in a pull request CI uses the PR's base; locally the integration branch.
function baseRef() {
  const candidates = [
    process.env.SA_BASE_REF,
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    'origin/claude/stake-attestation',
    'origin/main',
  ].filter(Boolean);
  const ref = candidates.find(resolves);
  assert.ok(ref, `none of ${candidates.join(', ')} resolves; fetch the base branch or set SA_BASE_REF`);
  return ref;
}

// One change of the base's, compared as a whole: the PR's diff (CI, or SA_BASE_REF), or, on an
// integration branch that also carries other projects' work, each commit since the base that touches
// stake-attestation/, plus what is not committed yet.
const WHOLE_DIFF = Boolean(process.env.SA_BASE_REF || process.env.GITHUB_BASE_REF);

// Commits that had to reach outside, each with its reason and every path it touched outside. A
// reviewed exception is added here in the same change, where review sees it.
const ALLOWED_COMMITS = {
  // The mock aggregator is one source in both projects (onchain/test/MockVerdiktaAggregator.test.js
  // holds the copies byte-identical), so its fix changed both, with the escrow's tests of it.
  '835b11db2444961ea5e203a7c42bb1106437cd0d': [
    'example-bounty-program/onchain/contracts/mocks/MockVerdiktaAggregator.sol',
    'example-bounty-program/onchain/test/BountyEscrow.v2.test.js',
  ],
};

const lines = (out) => out.split('\n').filter(Boolean);

function untracked() {
  return lines(git('ls-files', '--others', '--exclude-standard'));
}

/** Changed paths, grouped as they were changed: [{ id, paths }] (id null for the working tree). */
function changes() {
  const base = git('merge-base', baseRef(), 'HEAD');
  if (WHOLE_DIFF) return [{ id: null, paths: [...new Set([...lines(git('diff', '--name-only', base)), ...untracked()])] }];
  const commits = lines(git('rev-list', '--no-merges', `${base}..HEAD`)).map((id) => ({ id, paths: lines(git('show', '--name-only', '--format=', id)) }));
  const working = [...new Set([...lines(git('diff', '--name-only', 'HEAD')), ...untracked()])];
  return [...commits, { id: null, paths: working }];
}

/** The changes that touch stake-attestation/: the only ones these rules are about off a PR. */
function ours() {
  return changes().filter(({ paths }) => WHOLE_DIFF || paths.some((p) => p.startsWith('stake-attestation/')));
}

test('changes stay inside stake-attestation/ and its workflow', () => {
  const outside = ours().flatMap(({ id, paths }) => paths
    .filter((p) => !p.startsWith('stake-attestation/') && !ALLOWED_OUTSIDE.includes(p) && !(ALLOWED_COMMITS[id] || []).includes(p))
    .map((p) => (id ? `${id.slice(0, 7)}: ${p}` : p)));
  assert.deepEqual(outside, []);
});

test('BountyEscrow is untouched', () => {
  const touched = ours().flatMap(({ id, paths }) => paths.filter((p) => UNTOUCHABLE.includes(p)).map((p) => (id ? `${id.slice(0, 7)}: ${p}` : p)));
  assert.deepEqual(touched, []);
});

test('an allowed commit names only what it touched outside', () => {
  // An exception is for one commit's own paths: a stale entry, or one that lists more, is refused.
  for (const [id, allowed] of Object.entries(ALLOWED_COMMITS)) {
    let paths;
    try { paths = lines(git('show', '--name-only', '--format=', id)); } catch { continue; } // not in this clone's history
    assert.deepEqual(allowed.filter((p) => !paths.includes(p)), [], `${id.slice(0, 7)} lists paths it did not touch`);
    assert.ok(allowed.every((p) => !UNTOUCHABLE.includes(p)), `${id.slice(0, 7)} may not touch BountyEscrow`);
  }
});
