// The create page's size-class helpers (src/utils/bountyClass.js) over shared/classPresets.js,
// which the bounty server's POST /api/jobs/create uses too.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_PRESETS, presetForBounty, classDefaults, validateDecision, decisionFromForm, exceedsClass, formatUsd, weiToEthString, toBountyParams,
} from '../../src/utils/bountyClass.js';

test('the page re-exports the shared presets', () => {
  assert.deepEqual(CLASS_PRESETS.map((c) => c.key), ['bondless-small', 'small', 'medium', 'large', 'jumbo']);
  assert.equal(presetForBounty(20).key, 'bondless-small');
  assert.equal(presetForBounty(500).key, 'medium');
  assert.equal(presetForBounty(10_000_000).key, 'jumbo');
});

test('classDefaults converts the USD figures at the ETH price, like toBountyParams', () => {
  const d = classDefaults('medium', 2500);
  assert.equal(d.quota, '3');
  assert.equal(d.forfeitLine, '2');
  assert.equal(d.withBeacons, false);
  const p = toBountyParams('medium', 2500);
  assert.equal(d.bondEth, weiToEthString(p.bond));
  assert.equal(d.feeFloorEth, weiToEthString(p.minOracleFee));
  assert.equal(d.bondEth, '0.02');           // $50 at $2,500
  assert.equal(classDefaults('small', 2500).feeFloorEth, '0');
  // no price: non-zero USD figures are left to the server
  assert.equal(classDefaults('large', 0).bondEth, '');
  assert.equal(classDefaults('bondless-small', 0).bondEth, '0');
  assert.equal(classDefaults('nope', 2500), null);
});

test('validateDecision enforces 1 <= Q <= N and 0 <= R <= Q', () => {
  const ok = { quota: '3', forfeitLine: '1', bondEth: '0.001', feeFloorEth: '' };
  assert.equal(validateDecision(ok, 'small'), null);
  assert.match(validateDecision({ ...ok, quota: '0' }, 'small'), /Quota/);
  assert.match(validateDecision({ ...ok, quota: '5' }, 'small'), /N\)/);           // small N = 4
  assert.equal(validateDecision({ ...ok, quota: '13', forfeitLine: '8' }, 'large'), null);
  assert.match(validateDecision({ ...ok, forfeitLine: '4' }, 'small'), /Forfeit line/);
  assert.match(validateDecision({ ...ok, forfeitLine: '1.5' }, 'small'), /Forfeit line/);
  assert.match(validateDecision({ ...ok, bondEth: 'abc' }, 'small'), /Bond/);
  assert.match(validateDecision({ ...ok, feeFloorEth: '-1' }, 'small'), /Fee floor/);
  assert.match(validateDecision(ok, 'nope'), /class/);
});

test('decisionFromForm gives the create fields (wei strings; empty money left to the server)', () => {
  const d = decisionFromForm({ quota: '17', forfeitLine: '12', bondEth: '0.1', feeFloorEth: '', withBeacons: true }, 'jumbo');
  assert.deepEqual(d, {
    bountyClass: 'jumbo', jury: { K: 50, M: 38, N: 27, P: 17, timeout: 600 }, quota: 17, forfeitLine: 12, bond: '100000000000000000', minOracleFee: undefined, withBeacons: true,
  });
  assert.throws(() => decisionFromForm({}, 'nope'), /unknown bounty class/);
});

test('exceedsClass and formatUsd', () => {
  assert.equal(exceedsClass(100, 'small'), false);
  assert.equal(exceedsClass(100.01, 'small'), true);
  assert.equal(exceedsClass(NaN, 'small'), false);
  assert.equal(formatUsd(0.83), '$0.83');
  assert.equal(formatUsd(100000), '$100,000');
});
