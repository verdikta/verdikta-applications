/**
 * Size classes (verdikta-dispatcher TODO item 15), a synced copy of the bounty program's
 * (example-bounty-program/shared/classPresets.js; test/classPresets.test.js fails when the two
 * hold different class data). Owner decision, 2026-11-24: listings use the same presets.
 *
 * jury: the listing's own jury (StakeAttestation.OracleParams.jury), sent with every request of the
 * listing, claim round and dispute panel alike, to the one v2 aggregator: K drawn, M promoted, N
 * counted, P clustered, and the round timeout in seconds (counted from the draw). ClaimLogic.setOracle
 * checks it at list (checkJury below, the same rules); the aggregator checks its live limits per
 * request (K <= maxJury and the keeper's shortlist, T+ < timeout <= maxTimeout).
 *
 * What a listing takes from a class: the jury and withBeacons (listingOracleOf). The other fields
 * are the bounty program's and stay here only so the copies are equal: quota and forfeitLine are
 * BountyEscrow's Q-of-N rule (a listing settles one round's result), bondUsd and offeredUpToUsd are a
 * bounty's (a listing's hunter bond is the maker's, in the signed spec), and feeFloorUsd is a USD
 * figure that the site's fee floor (SA_ORACLE_MIN_FEE_WEI, in wei) does not convert.
 *
 * ESM, like the rest of this package; the class data is the bounty file's, value for value.
 */

export const CLASS_PRESETS = Object.freeze([
  Object.freeze({
    key: 'bondless-small', name: 'Bondless Small',
    jury: Object.freeze({ K: 6, M: 5, N: 4, P: 3, timeout: 300 }),
    quota: 3, forfeitLine: 1, withBeacons: false,
    feeFloorUsd: 0, bondUsd: 0, costPerRoundUsd: 0.83, offeredUpToUsd: 25, maxBountyUsd: 29,
  }),
  Object.freeze({
    key: 'small', name: 'Small',
    jury: Object.freeze({ K: 6, M: 5, N: 4, P: 3, timeout: 300 }),
    quota: 3, forfeitLine: 1, withBeacons: false,
    feeFloorUsd: 0, bondUsd: 5, costPerRoundUsd: 0.83, offeredUpToUsd: 100, maxBountyUsd: 101,
  }),
  Object.freeze({
    key: 'medium', name: 'Medium',
    jury: Object.freeze({ K: 8, M: 5, N: 4, P: 3, timeout: 300 }),
    quota: 3, forfeitLine: 2, withBeacons: false,
    feeFloorUsd: 0.25, bondUsd: 50, costPerRoundUsd: 4.6, offeredUpToUsd: 1000, maxBountyUsd: 1005,
  }),
  Object.freeze({
    key: 'large', name: 'Large',
    jury: Object.freeze({ K: 21, M: 16, N: 13, P: 10, timeout: 300 }),
    quota: 10, forfeitLine: 8, withBeacons: false,
    feeFloorUsd: 0.25, bondUsd: 100, costPerRoundUsd: 13.19, offeredUpToUsd: 10000, maxBountyUsd: 18600,
  }),
  Object.freeze({
    key: 'jumbo', name: 'Jumbo',
    jury: Object.freeze({ K: 50, M: 38, N: 27, P: 17, timeout: 600 }),
    quota: 17, forfeitLine: 12, withBeacons: true,
    feeFloorUsd: 0.25, bondUsd: 200, costPerRoundUsd: 26.39, offeredUpToUsd: 100000, maxBountyUsd: 165000,
  }),
]);

/**
 * The classes a listing may pick, smallest first. Bondless Small is left out: its jury is Small's,
 * and "bondless" is a bounty's term (a listing's bond is the maker's, in the spec).
 */
export const LISTING_CLASSES = Object.freeze(CLASS_PRESETS.filter((c) => c.key !== 'bondless-small').map((c) => c.key));

/** The class a listing gets when its request names none. */
export const DEFAULT_LISTING_CLASS = 'small';

/** The largest N the contract takes (ClaimLogic.setOracle, as the aggregator's AggregatorLib.checkJury). */
export const MAX_COUNTED = 40;

export function presetByKey(key) {
  return CLASS_PRESETS.find((c) => c.key === key) || null;
}

/**
 * What a listing of class `key` sets in its oracle settings: { jury: { K, M, N, P, timeout }, withBeacons }.
 * @throws {Error} for a class listings do not offer
 */
export function listingOracleOf(key) {
  if (!LISTING_CLASSES.includes(key)) throw new Error(`unknown listing class: ${key}`);
  const c = presetByKey(key);
  return { jury: { ...c.jury }, withBeacons: c.withBeacons };
}

/**
 * What ClaimLogic.setOracle refuses as "bad jury" (K >= M >= N >= P >= 1, N <= 40, P >= 2 unless N = 1, a
 * timeout above 0), and what the ABI cannot hold (each count a uint8, the timeout a uint40): a sentence, or
 * null for a jury the contract takes. The aggregator's live limits (maxJury, the keeper's shortlist,
 * T+ < timeout <= maxTimeout) are checked by each request, not here.
 * @param {{ K: number, M: number, N: number, P: number, timeout: number }} j
 * @returns {string|null}
 */
export function juryProblem(j) {
  if (!j || typeof j !== 'object') return 'a jury is { K, M, N, P, timeout }';
  for (const k of ['K', 'M', 'N', 'P']) {
    if (!Number.isSafeInteger(j[k]) || j[k] < 0 || j[k] > 255) return `${k} is a whole number from 1 to 255`;
  }
  if (!Number.isSafeInteger(j.timeout) || j.timeout < 1 || j.timeout > 2 ** 40 - 1) return 'the timeout is a whole number of seconds above 0';
  if (!(j.P >= 1 && j.P <= j.N && j.N <= j.M && j.M <= j.K)) return 'the jury must have K >= M >= N >= P >= 1';
  if (j.N > MAX_COUNTED) return `N is at most ${MAX_COUNTED}`;
  if (j.P === 1 && j.N !== 1) return 'P is at least 2 unless N is 1';
  return null;
}
