// Display helpers.
import { formatEther } from 'ethers';

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
