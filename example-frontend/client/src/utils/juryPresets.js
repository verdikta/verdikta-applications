// src/utils/juryPresets.js
//
// The jury a request asks for. The v2 aggregator has no jury size of its own: every request
// carries Jury {K, M, N, P, timeout} as its last argument (K drawn, M promoted, N counted,
// P clustered, and the round timeout in seconds, counted from the draw). One aggregator
// serves every size.
//
// These are the class presets of example-bounty-program/shared/classPresets.js (the jury
// and the beacon flag only; Bondless Small has Small's jury). A copy, because
// create-react-app does not import from outside src/: keep the two in step.
//
// The aggregator refuses a request with BadJury unless K >= M >= N >= P >= 1, N <= 40,
// P >= 2 (unless N = 1), K <= maxJury() and the keeper's shortlist, and
// tPlus() < timeout <= maxTimeout(). With fewer than K eligible arbiters the draw repeats
// arbiters; it fails (refunded) only when none is eligible.

export const JURY_PRESETS = Object.freeze([
  Object.freeze({ key: 'small', name: 'Small', jury: Object.freeze({ K: 6, M: 5, N: 4, P: 3, timeout: 300 }), withBeacons: false }),
  Object.freeze({ key: 'medium', name: 'Medium', jury: Object.freeze({ K: 8, M: 5, N: 4, P: 3, timeout: 300 }), withBeacons: false }),
  Object.freeze({ key: 'large', name: 'Large', jury: Object.freeze({ K: 21, M: 16, N: 13, P: 10, timeout: 300 }), withBeacons: false }),
  Object.freeze({ key: 'jumbo', name: 'Jumbo', jury: Object.freeze({ K: 50, M: 38, N: 27, P: 17, timeout: 600 }), withBeacons: true }),
]);

export const DEFAULT_JURY_PRESET_KEY = 'small';

export function juryPresetByKey(key) {
  return JURY_PRESETS.find((p) => p.key === key) || JURY_PRESETS.find((p) => p.key === DEFAULT_JURY_PRESET_KEY);
}

/** "6/5/4/3, 300 s" */
export function formatJury(jury) {
  if (!jury) return '';
  return `${jury.K}/${jury.M}/${jury.N}/${jury.P}, ${jury.timeout} s`;
}

/**
 * The rules the aggregator checks that need no chain read (the ordering, N <= 40, P >= 2
 * unless N = 1). Returns null when they hold, else the reason. maxJury, the keeper's
 * shortlist and the timeout bounds are checked on-chain.
 */
export function juryShapeError(jury) {
  if (!jury) return 'no jury';
  const { K, M, N, P } = jury;
  if (![K, M, N, P].every((v) => Number.isInteger(v) && v >= 1 && v <= 255)) return 'K, M, N and P must be integers from 1 to 255';
  if (!(K >= M && M >= N && N >= P)) return 'need K >= M >= N >= P >= 1';
  if (N > 40) return 'N may be at most 40';
  if (P < 2 && N !== 1) return 'P must be at least 2 unless N = 1';
  if (!Number.isInteger(jury.timeout) || jury.timeout <= 0) return 'timeout must be a positive number of seconds';
  return null;
}
