// Display helpers.
import { formatEther } from 'ethers';
import { STRINGS, fill } from '../strings.js';

/** A chain time (seconds) as ISO 8601 UTC, without milliseconds. */
export function formatTime(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Wei as ETH without a trailing ".0". */
export function formatEth(wei) {
  return formatEther(BigInt(wei)).replace(/\.0$/, '');
}

/** A short form of a transaction hash for status lines. */
export function shortHash(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** An error from a wallet or a contract call, as one readable line. */
export function errorReason(err) {
  return err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || String(err);
}

/** A whole number (bigint, number or decimal string) with thousands separators: 1250000 -> 1,250,000. */
export function formatWhole(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A listing's jury (getListing's oracle, or list()'s oracle argument) as one terms line: K drawn, M promoted,
 * N counted, P clustered, the round timeout from the draw, and the beacon flag. Its fields may be numbers,
 * bigints or decimal strings, as ethers or the server's JSON give them.
 * @param {{ jury: { K, M, N, P, timeout }, withBeacons?: boolean }} oracle
 */
export function juryLine(oracle) {
  const j = oracle.jury;
  const n = (v) => String(Number(v));
  return fill(STRINGS.chain.jury, { K: n(j.K), M: n(j.M), N: n(j.N), P: n(j.P), timeout: n(j.timeout), beacons: oracle.withBeacons ? STRINGS.chain.juryBeacons : '' });
}
