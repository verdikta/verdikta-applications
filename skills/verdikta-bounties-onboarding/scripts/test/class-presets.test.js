// The size-class presets must be the site's and API's own (example-bounty-program/shared/classPresets.js), vendored
// byte for byte; the comparison needs the repository (an installed skill copy skips it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { presets } from '../_transaction-guards.js';

const shared = new URL('../../../../example-bounty-program/shared/classPresets.js', import.meta.url);
const skip = existsSync(shared) ? false : 'website source not beside this skill (installed copy)';

test('vendored class presets are the shared module byte for byte (node sync_contract_assets.js)', { skip }, () => {
  const copy = readFileSync(new URL('../_class-presets.cjs', import.meta.url), 'utf8');
  const marker = '// ---- end of vendored header ----\n';
  assert.ok(copy.includes(marker));
  assert.equal(copy.slice(copy.indexOf(marker) + marker.length), readFileSync(shared, 'utf8'));
});

test('the presets the skill defaults to: Bondless Small needs no ETH price, the escrow limits match', () => {
  assert.deepEqual(presets.CLASS_PRESETS.map((c) => c.key), ['bondless-small', 'small', 'medium', 'large', 'jumbo']);
  const b = presets.presetByKey('bondless-small');
  assert.deepEqual([b.jury, b.quota, b.forfeitLine, b.bondUsd, b.feeFloorUsd, b.withBeacons], [0, 3, 1, 0, 0, false]);
  assert.equal(presets.MAX_ROUNDS, 6); assert.equal(presets.RERUN_WINDOW_SECONDS, 7200);
});
