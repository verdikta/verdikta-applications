/**
 * Server configuration for example-arbiters.
 *
 * Read-only blockchain access for arbiter/oracle analytics. No bounty,
 * wallet, or IPFS concerns — the only contract addresses needed are the
 * Verdikta v2 aggregator per network (the ReputationKeeper address is derived
 * on-chain from the aggregator's keeper()).
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
    // v2 ReputationAggregator. TODO(v2 deploy): not deployed / not known yet —
    // fill in the address and its deploy block (and the keeper's deploy block)
    // once the v2 contracts are live on this network. Until then the server
    // answers every chain read with "aggregator not configured". The env vars
    // AGGREGATOR_ADDRESS_BASE_SEPOLIA / AGGREGATOR_FROM_BLOCK_BASE_SEPOLIA /
    // KEEPER_FROM_BLOCK_BASE_SEPOLIA override these without a code change.
    // (The v1 aggregator 0xe8a3…80e4 and its keeper are not readable by this
    // version: v2 is a redeploy with a different ABI.)
    verdiktaAggregatorAddress: null, // PLACEHOLDER: v2 aggregator address
    aggregatorFromBlock: null,       // PLACEHOLDER: v2 aggregator deploy block (event-scan floor)
    // The ReputationKeeper address is read on-chain (aggregator.keeper()); the
    // registry is rebuilt from its ArbiterRegistered / ArbiterRemoved logs, so
    // the scan must start at or before the keeper's deploy block (the keeper is
    // deployed, and arbiters may register, before the aggregator).
    keeperFromBlock: null,           // PLACEHOLDER: v2 keeper deploy block
    // Chainlink transport token for the 0-juel request rail (the v2 aggregator
    // is still a ChainlinkClient). Not a payment token: arbiters are paid in ETH.
    // Kept for the legacy-LINK claim path and the Contracts page.
    linkTokenAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
    // Archive RPC for historical eth_getLogs. The PublicNode endpoint above
    // prunes log history ("pruned history unavailable"), so the bonus scan uses
    // a full-archive endpoint. Override with ARCHIVE_RPC_URL if preferred.
    archiveRpcUrl: 'https://base-sepolia.gateway.tenderly.co',
    // Largest eth_getLogs range this gateway serves without an access key.
    // Sepolia still allows the old ~100k; mainnet has been cut to 1k (see below).
    publicLogMaxRange: 90_000,
  },
  'base': {
    key: 'base',
    chainId: 8453,
    name: 'Base Mainnet',
    rpcUrl: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    // v2 ReputationAggregator: see the base-sepolia note above. TODO(v2 deploy).
    // Env overrides: AGGREGATOR_ADDRESS_BASE / AGGREGATOR_FROM_BLOCK_BASE / KEEPER_FROM_BLOCK_BASE.
    verdiktaAggregatorAddress: null, // PLACEHOLDER: v2 aggregator address
    aggregatorFromBlock: null,       // PLACEHOLDER: v2 aggregator deploy block
    keeperFromBlock: null,           // PLACEHOLDER: v2 keeper deploy block
    // Chainlink transport token (0-juel rail); not a payment token. See note above.
    linkTokenAddress: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
    archiveRpcUrl: 'https://base.gateway.tenderly.co',
    // Measured 2026-09-06: the keyless mainnet gateway now rejects anything over
    // 1,000 blocks ("Block range too large for public access ... or use an access
    // key for larger ranges") — it used to serve ~100k. At this size a 14-day
    // scan is 600+ calls, so getLogScanRpc() prefers a keyed endpoint when one is
    // configured and only falls back here (slowly) if none is.
    publicLogMaxRange: 1_000,
  },
};

const DEFAULT_NETWORK = networks[process.env.NETWORK] ? process.env.NETWORK : 'base-sepolia';

/**
 * v2 contract coordinates for a network: the aggregator address and the event-
 * scan floors, each overridable by env (suffix = network key upper-cased with
 * '_' for '-', e.g. AGGREGATOR_ADDRESS_BASE_SEPOLIA). The address is null while
 * the v2 deployment is unknown (see the placeholders above); callers must treat
 * that as "not configured" rather than reading a v1 contract.
 * @returns {{ aggregatorAddress: string|null, aggregatorFromBlock: number, keeperFromBlock: number }}
 */
function getContractsConfig(networkKey) {
  const net = networks[normalizeNetwork(networkKey)];
  const suffix = net.key.replace(/-/g, '_').toUpperCase();
  const envNum = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : null);
  const aggregatorAddress = process.env[`AGGREGATOR_ADDRESS_${suffix}`] || net.verdiktaAggregatorAddress || null;
  const aggregatorFromBlock = envNum(`AGGREGATOR_FROM_BLOCK_${suffix}`) ?? net.aggregatorFromBlock ?? 0;
  // The keeper predates the aggregator, so its floor defaults to the aggregator's
  // only as a last resort (registrations before it would then be missed).
  const keeperFromBlock = envNum(`KEEPER_FROM_BLOCK_${suffix}`) ?? net.keeperFromBlock ?? aggregatorFromBlock;
  return { aggregatorAddress, aggregatorFromBlock, keeperFromBlock };
}

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

/**
 * Resolve the endpoint used for historical `eth_getLogs` event scans, together
 * with the largest block range it will serve in one query.
 *
 * Providers cap `eth_getLogs` ranges, and the caps differ by an order of
 * magnitude, so the URL and the chunk size have to be chosen together — a chunk
 * larger than the cap makes EVERY query fail, which reads downstream as "no
 * activity" rather than as an error. Preference order:
 *
 *   1. LOG_RPC_URL              — explicit override for the scans specifically.
 *   2. ARCHIVE_RPC_URL          — a keyed archive endpoint; keyed access lifts
 *                                 the public range cap, so allow large chunks.
 *   3. A configured private read RPC (Infura by default here) — verified to
 *      serve these scans to exactly 10k blocks, with the history the analytics
 *      windows need. This is the normal path.
 *   4. The keyless public archive gateway, at that network's measured cap.
 *
 * LOG_CHUNK_SIZE overrides the range for any of them.
 */
const KEYED_LOG_MAX_RANGE = 90_000;   // keyed archive gateways
const SAFE_LOG_MAX_RANGE = 10_000;    // Infura's cap; honoured by most providers

function getLogScanRpc(networkKey) {
  const net = networks[normalizeNetwork(networkKey)];
  const envChunk = Number(process.env.LOG_CHUNK_SIZE) > 0 ? Number(process.env.LOG_CHUNK_SIZE) : 0;
  if (process.env.LOG_RPC_URL) {
    return { url: process.env.LOG_RPC_URL, maxChunk: envChunk || SAFE_LOG_MAX_RANGE };
  }
  if (process.env.ARCHIVE_RPC_URL) {
    return { url: process.env.ARCHIVE_RPC_URL, maxChunk: envChunk || KEYED_LOG_MAX_RANGE };
  }
  if (process.env.RPC_URL || process.env.RPC_PROVIDER_URL || process.env.INFURA_API_KEY) {
    return { url: getRpcUrl(networkKey), maxChunk: envChunk || SAFE_LOG_MAX_RANGE };
  }
  return {
    url: net.archiveRpcUrl || net.rpcUrl,
    maxChunk: envChunk || net.publicLogMaxRange || SAFE_LOG_MAX_RANGE,
  };
}

/**
 * Resolve the RPC URL for per-transaction receipt fetches (the gas-tracking
 * scan reads `gasUsed` / `effectiveGasPrice` off receipts). Defaults to the
 * ARCHIVE endpoint (Tenderly): empirically, Base's Infura and PublicNode
 * endpoints return NULL for historical `getTransactionReceipt` (even hours-old
 * txs) — only the archive node reliably has them. Override with RECEIPT_RPC_URL
 * to point receipts at a dedicated/paid archive endpoint, e.g. if Tenderly
 * rate-limits the initial backfill.
 */
function getReceiptRpcUrl(networkKey) {
  if (process.env.RECEIPT_RPC_URL) return process.env.RECEIPT_RPC_URL;
  return getArchiveRpcUrl(networkKey);
}

/**
 * Arbiter ETH-funding estimate parameters. An arbiter's node pays gas (in ETH)
 * from its operator's authorized-sender keys to submit commit+reveal responses.
 * `gasPerQuery` is the assumed gas for one arbiter response (commit + reveal,
 * ~2 txs) — an estimate, calibratable; the runway estimate also uses the live
 * gas price. "Low" funding is flagged when EITHER the estimated remaining
 * queries OR the absolute ETH falls below its threshold.
 */
const funding = {
  gasPerQuery: parseInt(process.env.GAS_PER_QUERY, 10) || 400000,
  lowQueriesThreshold: parseInt(process.env.LOW_QUERIES_THRESHOLD, 10) || 200,
  lowEthThreshold: process.env.LOW_ETH_THRESHOLD || '0.01', // ETH (string)
};

module.exports = { networks, DEFAULT_NETWORK, normalizeNetwork, getContractsConfig, getRpcUrl, getArchiveRpcUrl, getLogScanRpc, getReceiptRpcUrl, funding };
