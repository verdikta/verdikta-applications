// Listings use the bounty program's size classes (owner decision, 2026-11-24). This package keeps a
// copy (src/classPresets.js, ESM like the rest of it; the bounty's is CommonJS), and the two hold the
// same class data, value for value: a change to a class goes to both copies. Then the listing side:
// what a listing takes from a class, and the contract's jury check (ClaimLogic.setOracle, "bad jury").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  CLASS_PRESETS, DEFAULT_LISTING_CLASS, LISTING_CLASSES, juryProblem, listingOracleOf, presetByKey,
} from '../src/classPresets.js';
import { APP_DIR } from './repo/helpers.js';

const BOUNTY_FILE = path.join(APP_DIR, '..', 'example-bounty-program', 'shared', 'classPresets.js');
const bounty = createRequire(import.meta.url)(BOUNTY_FILE);
/** Plain data, frozen or not: what a JSON round trip keeps. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test('parity: the class data is the bounty program\'s, class by class and field by field', () => {
  assert.ok(Array.isArray(bounty.CLASS_PRESETS) && bounty.CLASS_PRESETS.length > 0, `${BOUNTY_FILE} exports CLASS_PRESETS`);
  assert.deepEqual(
    CLASS_PRESETS.map((c) => c.key),
    bounty.CLASS_PRESETS.map((c) => c.key),
    'the same classes in the same order: a class added or removed goes to both copies',
  );
  for (const [i, c] of CLASS_PRESETS.entries()) {
    assert.deepEqual(plain(c), plain(bounty.CLASS_PRESETS[i]), `class ${c.key}: a change to a class goes to both copies`);
  }
});

test('parity: presetByKey answers as the bounty program\'s does', () => {
  for (const c of bounty.CLASS_PRESETS) assert.deepEqual(plain(presetByKey(c.key)), plain(bounty.presetByKey(c.key)));
  assert.equal(presetByKey('nope'), null);
});

test('the copy is frozen, as the bounty program\'s is', () => {
  assert.ok(Object.isFrozen(CLASS_PRESETS));
  for (const c of CLASS_PRESETS) assert.ok(Object.isFrozen(c) && Object.isFrozen(c.jury), c.key);
});

test('a listing picks Small to Jumbo, Small by default', () => {
  assert.deepEqual(LISTING_CLASSES, ['small', 'medium', 'large', 'jumbo']);
  assert.equal(DEFAULT_LISTING_CLASS, 'small');
  assert.ok(LISTING_CLASSES.includes(DEFAULT_LISTING_CLASS));
});

test('a listing takes a class\'s jury and beacon flag, and nothing else', () => {
  assert.deepEqual(listingOracleOf('small'), { jury: { K: 6, M: 5, N: 4, P: 3, timeout: 300 }, withBeacons: false });
  assert.deepEqual(listingOracleOf('jumbo'), { jury: { K: 50, M: 38, N: 27, P: 17, timeout: 600 }, withBeacons: true });
  for (const key of LISTING_CLASSES) {
    const c = presetByKey(key);
    const o = listingOracleOf(key);
    assert.deepEqual(o, { jury: { ...c.jury }, withBeacons: c.withBeacons }, key);
    o.jury.K = 0; // a copy: the preset stays as it is
    assert.notEqual(presetByKey(key).jury.K, 0);
  }
  assert.throws(() => listingOracleOf('bondless-small'), /unknown listing class/);
  assert.throws(() => listingOracleOf('huge'), /unknown listing class/);
});

test('every class\'s jury passes the contract\'s check', () => {
  for (const c of CLASS_PRESETS) assert.equal(juryProblem(c.jury), null, c.key);
});

test('juryProblem refuses what ClaimLogic.setOracle refuses as "bad jury", and what the ABI cannot hold', () => {
  const ok = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
  assert.equal(juryProblem({ K: 1, M: 1, N: 1, P: 1, timeout: 1 }), null, 'N = 1 with P = 1');
  assert.equal(juryProblem({ K: 255, M: 40, N: 40, P: 2, timeout: 3600 }), null);
  const bad = [
    [{ ...ok, P: 0 }, /K >= M >= N >= P >= 1/],
    [{ ...ok, P: 5 }, /K >= M >= N >= P >= 1/],
    [{ ...ok, N: 6 }, /K >= M >= N >= P >= 1/],
    [{ ...ok, M: 7 }, /K >= M >= N >= P >= 1/],
    [{ K: 50, M: 45, N: 41, P: 3, timeout: 300 }, /N is at most 40/],
    [{ ...ok, P: 1 }, /P is at least 2 unless N is 1/],
    [{ ...ok, timeout: 0 }, /timeout/],
    [{ ...ok, timeout: 2 ** 40 }, /timeout/],
    [{ ...ok, K: 256 }, /K is a whole number/],
    [{ ...ok, K: 6.5 }, /K is a whole number/],
    [{ ...ok, M: '5' }, /M is a whole number/],
    [null, /a jury is/],
  ];
  for (const [j, why] of bad) assert.match(juryProblem(j) ?? '', why, JSON.stringify(j));
});

test('it can be imported on its own, with nothing of node in it (the client bundles it)', async () => {
  const m = await import('@verdikta/stake-attestation-shared/class-presets');
  assert.equal(m.CLASS_PRESETS, CLASS_PRESETS);
});
