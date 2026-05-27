/**
 * Shared helpers for the node-funding (sending-key ETH) views.
 * Used by both My Arbiters (interactive fund panel) and Owner Details
 * (read-only breakdown) so the estimated-query math stays identical.
 *
 * The funding metadata object `f` comes from the backend
 * (_fundingForClient in server/utils/verdiktaService.js) and carries
 * `gasPerQuery` and live `gasPriceGwei`.
 */

// Estimated number of oracle queries a given ETH balance covers, derived from
// the funding metadata. Returns null when gas price is unavailable.
export const estQueriesFor = (balanceEth, f) => {
  if (!f || f.gasPriceGwei == null) return null;
  const costPerQueryEth = f.gasPerQuery * Number(f.gasPriceGwei) * 1e-9;
  if (!(costPerQueryEth > 0)) return null;
  return Math.floor(Number(balanceEth) / costPerQueryEth);
};

export const fmtQueries = (n) => (n == null ? '—' : n.toLocaleString());
