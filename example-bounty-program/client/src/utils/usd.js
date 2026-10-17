// USD display for ETH amounts, shared by the bounty list and the bounty page.

// Format a positive USD amount as "$1,234.50" (prefixed "~" when approximate).
// Amounts under a cent read "<$0.01" rather than "$0.00". Returns null for
// non-positive/invalid values so callers can hide the USD note.
export const formatUsd = (value, { approx = false } = {}) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return '<$0.01';
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${approx ? '~' : ''}$${text}`;
};

// Recent ETH/USD price from the server proxy (Coinbase, CoinGecko fallback;
// the server caches it for a minute). Shared across pages so moving between
// the list and a bounty doesn't refetch; resolves to 0 when unavailable so
// callers fall back to ETH-only.
const PRICE_TTL_MS = 60 * 1000;
let cached = { usd: 0, at: 0, pending: null };

export async function fetchEthUsdPrice() {
  if (cached.usd > 0 && Date.now() - cached.at < PRICE_TTL_MS) return cached.usd;
  if (!cached.pending) {
    cached.pending = (async () => {
      try {
        const response = await fetch('/api/jobs/eth-price');
        const data = await response.json();
        if (data?.usd > 0) cached = { usd: data.usd, at: Date.now(), pending: null };
      } catch (err) {
        console.warn('Failed to fetch ETH price:', err);
      } finally {
        cached.pending = null;
      }
      return cached.usd;
    })();
  }
  return cached.pending;
}
