// A known issue's id in the browser (src/lib/knownIssues.js) is common's knownIssueId: common's
// validate.js hashes with Node's crypto, so the client hashes the same canonical JSON with the
// SHA-256 of common's browser-safe disclosure module. Checked here against common itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import common from '@verdikta/common';

import { knownIssueId, knownIssueEntry } from '../src/lib/knownIssues.js';

const SAMPLES = [
  { title: 'Rounding favours the vault on withdraw', class: 'LOW', paths: ['src/Vault.sol'], description: 'Share-to-asset conversion on withdraw rounds down by up to one wei; accepted.' },
  { title: 'Owner can pause deposits', class: 'MEDIUM', paths: ['src/Vault.sol', 'src/Pausable.sol'], description: 'The owner may pause deposits at any time; withdrawals stay open.' },
  { title: 'Ünïcode — “quotes” and \\ backslashes', class: 'CRITICAL', paths: ['src/ä/b.sol'], description: 'Line one\nline two\ttabbed, and an emoji-free 中文 description.' },
];

test('knownIssueId is common\'s id for the same body', () => {
  for (const s of SAMPLES) assert.equal(knownIssueId(s), common.codeReview.knownIssueId(s), s.title);
});

test('the id hashes only the body: key order and an existing id do not change it', () => {
  const [s] = SAMPLES;
  const reordered = { description: s.description, paths: s.paths, class: s.class, title: s.title, id: 'sha256:00' };
  assert.equal(knownIssueId(reordered), knownIssueId(s));
});

test('an editor row becomes a known_issues.json entry common validates', () => {
  const entry = knownIssueEntry({ title: ' Owner can pause deposits ', class: 'MEDIUM', paths: 'src/Vault.sol\n\n src/Pausable.sol \n', description: 'The owner may pause deposits at any time; withdrawals stay open.' });
  assert.deepEqual(Object.keys(entry), ['id', 'title', 'class', 'paths', 'description']);
  assert.equal(entry.title, 'Owner can pause deposits');
  assert.deepEqual(entry.paths, ['src/Vault.sol', 'src/Pausable.sol']);
  assert.equal(common.codeReview.validateKnownIssues([entry]).ok, true);
});
