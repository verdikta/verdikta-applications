// The attestation app is a separate site (design §20 decision 18): its changes stay in
// stake-attestation/ and its own workflow, and the bounty program's escrow is never modified.
// A change that needs another path adds it to ALLOWED_OUTSIDE in the same PR, where review sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from './helpers.js';

const ALLOWED_OUTSIDE = ['.github/workflows/stake-attestation.yml'];
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

function changedPaths() {
  const base = git('merge-base', baseRef(), 'HEAD');
  const committed = git('diff', '--name-only', base).split('\n');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
  return [...new Set([...committed, ...untracked].filter(Boolean))];
}

test('changes stay inside stake-attestation/ and its workflow', () => {
  const outside = changedPaths().filter(
    (p) => !p.startsWith('stake-attestation/') && !ALLOWED_OUTSIDE.includes(p)
  );
  assert.deepEqual(outside, []);
});

test('BountyEscrow is untouched', () => {
  const touched = changedPaths().filter((p) => UNTOUCHABLE.includes(p));
  assert.deepEqual(touched, []);
});
