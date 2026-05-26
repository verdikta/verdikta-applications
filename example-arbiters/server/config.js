/**
 * Server configuration for example-arbiters.
 *
 * Read-only blockchain access for arbiter/oracle analytics. No bounty,
 * wallet, or IPFS concerns — the only contract addresses needed are the
 * Verdikta aggregator per network (the ReputationKeeper address is derived
 * on-chain from the aggregator).
 *
 * Both supported networks ship public RPC endpoints, so no secrets are
 * required. An operator may still override the RPC via RPC_URL /
 * INFURA_API_KEY env vars if a private endpoint is preferred.
 */

// Network definitions. Keys use hyphenated form ('base-sepolia') to match the
// peer example-bounty-program server. The client toggle uses example-frontend's
// underscored form ('base_sepolia'); normalizeNetwork() bridges the two.
const networks = {
  // RPC note: the official sepolia.base.org / mainnet.base.org endpoints
  // rate-limit hard and cannot sustain enumerating every registered oracle
  // (mainnet repeatedly dropped ~30% of calls). PublicNode handles the full
  // parallel load reliably (all oracles, sub-second) and needs no API key.
  // Override with RPC_URL / INFURA_API_KEY for a private endpoint if desired.
  'base-sepolia': {
    key: 'base-sepolia',
    chainId: 84532,
    name: 'Base Sepolia',
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.basescan.org',
    verdiktaAggregatorAddress: '0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089',
    linkTokenAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
    // Aggregator deployment block (found via archive eth_getCode binary search).
    // Lower bound for the BonusPayment event scan behind the owners analytics.
    aggregatorFromBlock: 30404839,
    // Archive RPC for historical eth_getLogs. The PublicNode endpoint above
    // prunes log history ("pruned history unavailable"), so the bonus scan uses
    // a full-archive endpoint. Override with ARCHIVE_RPC_URL if preferred.
    archiveRpcUrl: 'https://base-sepolia.gateway.tenderly.co',
  },
  'base': {
    key: 'base',
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    verdiktaAggregatorAddress: '0x2f7a02298D4478213057edA5e5bEB07F20c4c054',
    linkTokenAddress: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
    // Aggregator deployment block (see base-sepolia note above).
    aggregatorFromBlock: 35124408,
    archiveRpcUrl: 'https://base.gateway.tenderly.co',
  },
};

const DEFAULT_NETWORK = networks[process.env.NETWORK] ? process.env.NETWORK : 'base-sepolia';

/**
 * Normalize a network key from any caller (client toggle, query param, env)
 * to a canonical key present in `networks`. Accepts the underscored form used
 * by example-frontend ('base_sepolia') and falls back to the default.
 */
function normalizeNetwork(key) {
  if (!key) return DEFAULT_NETWORK;
  const canonical = String(key).replace(/_/g, '-').toLowerCase();
  return networks[canonical] ? canonical : DEFAULT_NETWORK;
}

/**
 * Resolve the RPC URL for a network. Prefers an explicit private endpoint if
 * configured via env, otherwise uses the network's public RPC.
 */
function getRpcUrl(networkKey) {
  const net = networks[normalizeNetwork(networkKey)];
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (process.env.RPC_PROVIDER_URL) return process.env.RPC_PROVIDER_URL;
  if (process.env.INFURA_API_KEY) {
    const infuraNetwork = net.key === 'base' ? 'base-mainnet' : 'base-sepolia';
    return `https://${infuraNetwork}.infura.io/v3/${process.env.INFURA_API_KEY}`;
  }
  return net.rpcUrl;
}

/**
 * Resolve the archive RPC URL (full log history) for a network's event scans.
 * Falls back to the regular RPC if no archive endpoint is configured.
 */
function getArchiveRpcUrl(networkKey) {
  const net = networks[normalizeNetwork(networkKey)];
  if (process.env.ARCHIVE_RPC_URL) return process.env.ARCHIVE_RPC_URL;
  return net.archiveRpcUrl || getRpcUrl(networkKey);
}

module.exports = { networks, DEFAULT_NETWORK, normalizeNetwork, getRpcUrl, getArchiveRpcUrl };
