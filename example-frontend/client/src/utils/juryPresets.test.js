import { JURY_PRESETS, DEFAULT_JURY_PRESET_KEY, juryPresetByKey, juryShapeError, formatJury } from './juryPresets';

// The copy must match the class presets it was taken from (create-react-app cannot import them).
// eslint-disable-next-line import/no-relative-packages
const { CLASS_PRESETS } = require('../../../../example-bounty-program/shared/classPresets');

test('the jury presets match example-bounty-program/shared/classPresets.js', () => {
  for (const preset of JURY_PRESETS) {
    const source = CLASS_PRESETS.find((c) => c.key === preset.key);
    expect(source).toBeDefined();
    expect({ ...preset.jury }).toEqual({ ...source.jury });
    expect(preset.withBeacons).toBe(source.withBeacons);
  }
  expect(JURY_PRESETS.map((p) => p.key)).toEqual(['small', 'medium', 'large', 'jumbo']);
});

test('the default is Small, 6/5/4/3, 300 s; an unknown key falls back to it', () => {
  expect(DEFAULT_JURY_PRESET_KEY).toBe('small');
  expect(formatJury(juryPresetByKey('nope').jury)).toBe('6/5/4/3, 300 s');
  expect(juryPresetByKey('jumbo').withBeacons).toBe(true);
});

test("juryShapeError applies the aggregator's ordering, N and P rules", () => {
  for (const p of JURY_PRESETS) expect(juryShapeError(p.jury)).toBeNull();
  expect(juryShapeError({ K: 4, M: 5, N: 4, P: 3, timeout: 300 })).toMatch(/K >= M/);
  expect(juryShapeError({ K: 50, M: 45, N: 41, P: 20, timeout: 300 })).toMatch(/N may be at most 40/);
  expect(juryShapeError({ K: 3, M: 3, N: 2, P: 1, timeout: 300 })).toMatch(/P must be at least 2/);
  expect(juryShapeError({ K: 1, M: 1, N: 1, P: 1, timeout: 300 })).toBeNull();
});
