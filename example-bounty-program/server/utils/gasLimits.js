/**
 * Gas limits for the v2 calls, measured against the real v2 contracts (2026-11-23, in-process
 * network): drawJury 2.0M (K = 6), 3.7M (K = 12), 13.5M (K = 50 with beacons); closeFailedRound up
 * to 2.38M (K = 50); startPreparedSubmission up to 3.35M when the request settles two due 50-juror
 * rounds first.
 */

// Per-transaction gas cap (2^24 = 16,777,216, EIP-7825), less headroom. A limit above it is
// refused by the node, so every margin is clamped here.
const TX_GAS_CAP = 16_500_000n;
// drawJury when its cost can't be estimated: enough for a 50-juror beacon draw.
const DRAW_GAS_LIMIT_FALLBACK = TX_GAS_CAP;
// startPreparedSubmission: the request may settle up to 2 due rounds first.
const START_GAS_LIMIT = 6_000_000n;
const capGas = (g) => (g > TX_GAS_CAP ? TX_GAS_CAP : g);

module.exports = { TX_GAS_CAP, DRAW_GAS_LIMIT_FALLBACK, START_GAS_LIMIT, capGas };
