// Bounty size classes (v2, TODO item 15): the jury, decision rule (Q-of-N, item 12) and money a
// bounty of each size uses. The presets live in shared/classPresets.js (plain CommonJS), which the
// bounty server's POST /api/jobs/create also uses, so the create page and the API default alike.
// vite.config.js serves the shared module to the browser as an ES module.
import { ethers } from 'ethers';
import {
  CLASS_PRESETS,
  MAX_ROUNDS,
  RERUN_WINDOW_SECONDS,
  presetByKey,
  presetForBounty,
  usdToWei,
  toBountyParams,
} from '../../../shared/classPresets.js';

export { CLASS_PRESETS, MAX_ROUNDS, RERUN_WINDOW_SECONDS, presetByKey, presetForBounty, usdToWei, toBountyParams };

/** Format a USD figure: "$0.83", "$1,000", "$100,000". */
export function formatUsd(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '—';
  return n < 10 && n % 1 !== 0
    ? `$${n.toFixed(2)}`
    : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** A wei amount as a short decimal-ETH string ("0" for zero). */
export function weiToEthString(wei) {
  const v = BigInt(wei || 0);
  if (v === 0n) return '0';
  const s = ethers.formatEther(v);
  // trim to 8 significant decimals for display
  const [i, d = ''] = s.split('.');
  const trimmed = d.slice(0, 8).replace(/0+$/, '');
  return trimmed ? `${i}.${trimmed}` : i;
}

/**
 * The class's createBounty fields, in ETH for the form: { quota, forfeitLine, bondEth,
 * feeFloorEth, withBeacons }. Without an ETH price the USD amounts can't be converted, so
 * bondEth / feeFloorEth are '' when they are non-zero (the server then converts with its feed).
 */
export function classDefaults(key, ethUsd) {
  const c = presetByKey(key);
  if (!c) return null;
  const priced = Number(ethUsd) > 0;
  const toEth = (usd) => (usd === 0 ? '0' : priced ? weiToEthString(usdToWei(usd, ethUsd)) : '');
  return {
    quota: String(c.quota),
    forfeitLine: String(c.forfeitLine),
    bondEth: toEth(c.bondUsd),
    feeFloorEth: toEth(c.feeFloorUsd),
    withBeacons: c.withBeacons,
  };
}

/**
 * Check the decision overrides of the form against the class: 1 <= Q <= N, 0 <= R <= Q, bond and
 * fee floor non-negative decimal ETH. Returns an error string or null.
 * `f` is { quota, forfeitLine, bondEth, feeFloorEth } (strings from the form).
 */
export function validateDecision(f, key) {
  const c = presetByKey(key);
  if (!c) return 'Pick a bounty size class';
  const q = Number(f.quota);
  const r = Number(f.forfeitLine);
  if (!Number.isInteger(q) || q < 1 || q > c.N) return `Quota (Q) must be a whole number from 1 to ${c.N} (the ${c.name} jury's N)`;
  if (!Number.isInteger(r) || r < 0 || r > q) return `Forfeit line (R) must be a whole number from 0 to Q (${q})`;
  for (const [label, v] of [['Bond', f.bondEth], ['Fee floor', f.feeFloorEth]]) {
    const s = String(v ?? '').trim();
    if (s === '') continue;   // the server converts the class's USD figure
    let wei;
    try { wei = ethers.parseEther(s); } catch { return `${label} must be a decimal ETH amount (e.g. 0.002)`; }
    if (wei < 0n) return `${label} must be >= 0`;
  }
  return null;
}

/**
 * The decision fields for POST /api/jobs/create and createBounty from the form: { bountyClass,
 * jury, quota, forfeitLine, bond (wei string | undefined), minOracleFee (wei string | undefined),
 * withBeacons }. An empty bond / fee floor is left out (the server converts the class's USD
 * figure at its ETH price).
 */
export function decisionFromForm(f, key) {
  const c = presetByKey(key);
  if (!c) throw new Error(`unknown bounty class: ${key}`);
  const wei = (v) => {
    const s = String(v ?? '').trim();
    return s === '' ? undefined : ethers.parseEther(s).toString();
  };
  return {
    bountyClass: c.key,
    jury: c.jury,
    quota: Number(f.quota),
    forfeitLine: Number(f.forfeitLine),
    bond: wei(f.bondEth),
    minOracleFee: wei(f.feeFloorEth),
    withBeacons: Boolean(f.withBeacons),
  };
}

/** Does a payout of `usd` exceed what the class is offered for? */
export function exceedsClass(usd, key) {
  const c = presetByKey(key);
  const n = Number(usd);
  return Boolean(c) && Number.isFinite(n) && n > c.offeredUpToUsd;
}
