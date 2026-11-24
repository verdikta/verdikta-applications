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
  assert.deepEqual([b.jury, b.quota, b.forfeitLine, b.bondUsd, b.feeFloorUsd, b.withBeacons], [{ K: 6, M: 5, N: 4, P: 3, timeout: 300 }, 3, 1, 0, 0, false]);
  assert.equal(presets.JURIES, undefined);
  // Every preset's jury passes the escrow's createBounty rule (K >= M >= N >= P >= 1, N <= 40, P >= 2 unless N = 1;
  // R <= Q <= N), and its timeout is within the aggregator's defaults (T+ 155 < timeout <= maxTimeout 3600, K <= maxJury 50).
  for (const c of presets.CLASS_PRESETS) {
    const { K, M, N, P, timeout } = c.jury;
    assert.ok(P >= 1 && P <= N && N <= M && M <= K && N <= 40 && (P !== 1 || N === 1), c.key);
    assert.ok(c.forfeitLine <= c.quota && c.quota >= 1 && c.quota <= N, c.key);
    assert.ok(K <= 50 && timeout > 155 && timeout <= 3600, c.key);
  }
  // toBountyParams hands back a copy of the preset's jury, and takes the creator's own over it.
  const p = presets.toBountyParams('jumbo', 2500);
  assert.deepEqual(p.jury, { K: 50, M: 38, N: 27, P: 17, timeout: 600 });
  p.jury.K = 1; assert.equal(presets.presetByKey('jumbo').jury.K, 50);
  assert.deepEqual(presets.toBountyParams('small', 2500, { jury: { K: 7, M: 5, N: 4, P: 3, timeout: 300 } }).jury.K, 7);
  assert.equal(presets.MAX_ROUNDS, 6); assert.equal(presets.RERUN_WINDOW_SECONDS, 7200);
});
