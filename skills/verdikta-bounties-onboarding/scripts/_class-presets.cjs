// VENDORED from example-bounty-program/shared/classPresets.js (the create page and /api/jobs/create presets).
// Every line below this header is that file, byte for byte: test/class-presets.test.js fails when they differ.
// Change the shared module first, then copy it here with: node sync_contract_assets.js
// ---- end of vendored header ----
'use strict';

/**
 * Bounty size classes (verdikta-dispatcher TODO item 15): the jury, decision rule and money a bounty
 * of each size should use. The escrow stores whatever the creator sets; these are the website's and
 * the API's presets (owner decision, 2026-11-23: presets live in the site and API, not on-chain).
 *
 * Every class assumes the v2 aggregator's two-phase draw, M+ / T+ promotion and item 12's Q-of-N rule
 * with re-runs (up to 6 rounds). Figures are from item 15's model (300 eligible arbiters, 15%
 * colluding, ETH at $2,287): "offeredUpToUsd" is the bounty a class is sold for, and "maxBountyUsd" is
 * the model's break-even, with no safety margin.
 *
 * jury: the bounty's own jury, sent with every request to the one v2 aggregator (item 15): K drawn,
 * M promoted, N counted, P clustered, and the round timeout in seconds (counted from the draw). The
 * aggregator checks it per request (K <= its maxJury and the keeper's shortlist, T+ < timeout <=
 * maxTimeout); the escrow checks the ordering at createBounty. Stake-attestation listings use the
 * same presets (a synced copy, stake-attestation/shared/classPresets.js, held equal by a parity test).
 *
 * Money is in USD; toBountyParams converts at a given ETH price. The fee is a fee floor
 * (minOracleFee): every juror (and beacon) is paid at least that, so an attempt costs at least
 * K x floor (K + 2 with beacons). Small uses today's posted fee, so it sets no floor.
 *
 * Plain CommonJS with no dependencies: the server requires it and the client imports it.
 */

const CLASS_PRESETS = Object.freeze([
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

const MAX_ROUNDS = 6;               // BountyEscrow.MAX_ROUNDS
const RERUN_WINDOW_SECONDS = 7200;  // BountyEscrow.RERUN_WINDOW

function presetByKey(key) {
  return CLASS_PRESETS.find((c) => c.key === key) || null;
}

/** The smallest class offered for a bounty of `bountyUsd` (or the largest, above every offer). */
function presetForBounty(bountyUsd) {
  const usd = Number(bountyUsd);
  if (!Number.isFinite(usd) || usd < 0) return null;
  return CLASS_PRESETS.find((c) => usd <= c.offeredUpToUsd) || CLASS_PRESETS[CLASS_PRESETS.length - 1];
}

/** USD to wei at `ethUsd` dollars per ETH, rounded to the nearest wei. */
function usdToWei(usd, ethUsd) {
  const price = Number(ethUsd);
  const amount = Number(usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error('ethUsd must be a positive number');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('usd must be a non-negative number');
  if (amount === 0) return 0n;
  // micro-dollars and micro-dollars per ETH keep the division exact enough without floats
  const micro = BigInt(Math.round(amount * 1e6));
  const microPrice = BigInt(Math.round(price * 1e6));
  return (micro * 10n ** 18n + microPrice / 2n) / microPrice;
}

/**
 * The createBounty fields a class sets, in wei at `ethUsd`: { jury: {K, M, N, P, timeout}, quota, forfeitLine, bond,
 * minOracleFee, withBeacons } (bond and minOracleFee as decimal strings, BigInt-safe in JSON).
 * `overrides` replaces any of them (the creator's choice); values are not validated here — the
 * escrow checks R <= Q <= N and the rest at createBounty.
 */
function toBountyParams(key, ethUsd, overrides = {}) {
  const c = presetByKey(key);
  if (!c) throw new Error(`unknown bounty class: ${key}`);
  const out = {
    jury: { ...c.jury },
    quota: c.quota,
    forfeitLine: c.forfeitLine,
    bond: usdToWei(c.bondUsd, ethUsd).toString(),
    minOracleFee: usdToWei(c.feeFloorUsd, ethUsd).toString(),
    withBeacons: c.withBeacons,
  };
  for (const k of Object.keys(out)) if (overrides[k] !== undefined && overrides[k] !== null) out[k] = overrides[k];
  if (typeof out.bond === 'bigint') out.bond = out.bond.toString();
  if (typeof out.minOracleFee === 'bigint') out.minOracleFee = out.minOracleFee.toString();
  return out;
}

/**
 * The least an attempt (one round) costs in fees at a fee floor of `minOracleFeeWei`: K x floor, plus
 * the 2 beacon values with beacons. The escrow quote (requiredPrepay) is higher: it reserves the
 * bonuses and rewards too, and returns what is not spent.
 */
function minAttemptCostWei(key, minOracleFeeWei) {
  const c = presetByKey(key);
  if (!c) throw new Error(`unknown bounty class: ${key}`);
  const floor = BigInt(minOracleFeeWei || 0);
  return floor * BigInt(c.jury.K + (c.withBeacons ? 2 : 0));
}

module.exports = {
  CLASS_PRESETS,
  MAX_ROUNDS,
  RERUN_WINDOW_SECONDS,
  presetByKey,
  presetForBounty,
  usdToWei,
  toBountyParams,
  minAttemptCostWei,
};
