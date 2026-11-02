// The record's labels (design §4.1, §4.2), computed off-chain as the contract leaves them to the
// site: a listing is
//
//   scanned       its top award (CRITICAL) is below the badge floor: no badge wording beyond this
//   staked        at or above the floor
//   under-staked  at or above the floor, with a declared value at risk, and the top award, priced
//                 in USD by Chainlink's ETH/USD feed, below a program-set share of that value
//   invited       it has an allowlist: only invited hunters may claim (§14), a weaker attestation
//
// `stake` is one of the first three; `invited` qualifies it. A listing with a declared value at
// risk and no usable price gets no stake label at all (stake: null) rather than a guess.
//
// The floor and the share are config (SA_BADGE_FLOOR_WEI, SA_UNDER_STAKED_RATIO_BPS). Their launch
// values are the owner's to set at G1 (design §20, open questions); the defaults below are
// PLACEHOLDERS, and the config lists which of them are in use.
import { SEVERITY_CLASSES } from '../chain/abi.js';
import { assertWording } from '../wording.js';

export const LABEL_PLACEHOLDERS = Object.freeze({
  // PLACEHOLDER: about $100 at $2,420/ETH (the design's "≈ $100 at launch"); the owner sets it at G1.
  badgeFloorWei: '40000000000000000',
  // PLACEHOLDER: 10% of the declared value at risk; the owner sets it at G1.
  underStakedRatioBps: 1000,
});

export const STAKE_LABELS = Object.freeze(['scanned', 'staked', 'under-staked'].map(assertWording));

/** Whole dollars of `wei` at a feed answer with `decimals` (rounded down). */
export function weiToUsd(wei, price) {
  return (BigInt(wei) * BigInt(price.answer)) / (10n ** 18n * 10n ** BigInt(price.decimals));
}

/**
 * @param {object} listing - a ListingRecord of the record mirror (decimal strings, enum names)
 * @param {object} o
 * @param {{ answer: string, decimals: number }|null} o.price - ETH/USD, or null when unavailable
 * @param {string} o.badgeFloorWei
 * @param {number} o.underStakedRatioBps
 */
export function listingLabels(listing, { price, badgeFloorWei, underStakedRatioBps }) {
  const topAwardWei = BigInt(listing.awards[SEVERITY_CLASSES.length - 1]);
  const valueAtRiskUsd = BigInt(listing.valueAtRiskUsd);
  let stake;
  let stakeUsd = null;
  let error = null;
  if (price) stakeUsd = weiToUsd(topAwardWei, price);
  if (topAwardWei < BigInt(badgeFloorWei)) {
    stake = 'scanned';
  } else if (valueAtRiskUsd === 0n) {
    stake = 'staked';
  } else if (!price) {
    stake = null;
    error = 'ETH_USD_UNAVAILABLE';
  } else {
    // below the share: topAward * answer / 10^(18 + decimals) < VaR * bps / 10000, in integers
    const lhs = topAwardWei * BigInt(price.answer) * 10000n;
    const rhs = valueAtRiskUsd * BigInt(underStakedRatioBps) * 10n ** 18n * 10n ** BigInt(price.decimals);
    stake = lhs < rhs ? 'under-staked' : 'staked';
  }
  return {
    stake,
    invited: Boolean(listing.invited),
    lapsed: Boolean(listing.lapsed),
    live: listing.state === 'Open' && !listing.lapsed,
    topAwardWei: topAwardWei.toString(),
    valueAtRiskUsd: valueAtRiskUsd.toString(),
    stakeUsd: stakeUsd === null ? null : stakeUsd.toString(),
    error,
  };
}
