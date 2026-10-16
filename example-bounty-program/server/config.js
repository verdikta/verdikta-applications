/**
 * Server configuration
 * Network-specific values are selected based on NETWORK env var.
 * Contract addresses must be set in .env file via the network-specific
 * variables BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA and BOUNTY_ESCROW_ADDRESS_BASE.
 */

// Network definitions
const networks = {
  'base-sepolia': {
    chainId: 84532,
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    // ETH-funded ReputationAggregator (LINK rail retired)
    verdiktaAggregatorAddress: '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4',
    verdiktaAggregatorDeployBlock: 42_598_251, // lower bound for event scans
  },
  'base': {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    // ETH-funded ReputationAggregator (LINK rail retired)
    verdiktaAggregatorAddress: '0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a',
    verdiktaAggregatorDeployBlock: 47_087_827, // lower bound for event scans
  },
};

// Determine current network from environment
const networkKey = process.env.NETWORK || 'base-sepolia';
const networkDefaults = networks[networkKey] || networks['base-sepolia'];

// Build RPC URL - prefer explicit RPC_URL, then Infura if key available, then public RPC
function getRpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (process.env.RPC_PROVIDER_URL) return process.env.RPC_PROVIDER_URL;

  // Use Infura if API key is available
  if (process.env.INFURA_API_KEY) {
    const infuraNetwork = networkKey === 'base' ? 'base-mainnet' : 'base-sepolia';
    return `https://${infuraNetwork}.infura.io/v3/${process.env.INFURA_API_KEY}`;
  }

  return networkDefaults.rpcUrl;
}

// RPC for Verdikta aggregator reads (status view + wide getLogs scans for
// agg-history). Defaults to the main RPC (Infura/RPC_URL when configured), but
// can be pointed independently at an archive/higher-limit endpoint via
// VERDIKTA_RPC_URL — keyless public RPCs (base.org, PublicNode, llama/drpc/1rpc)
// are either flaky or block datacenter IPs for this workload.
function getVerdiktaRpcUrl() {
  return process.env.VERDIKTA_RPC_URL || getRpcUrl();
}

// Select BountyEscrow address based on network
const bountyEscrowAddresses = {
  'base-sepolia': process.env.BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA || '',
  'base': process.env.BOUNTY_ESCROW_ADDRESS_BASE || '',
};

// Export configuration with env overrides
// "a, b/" or a list -> trimmed, slash-stripped, de-duplicated gateway URLs.
function readGateways(env, fallback) {
  const list = env ? env.split(',') : fallback;
  return [...new Set(list.map((g) => String(g || '').trim().replace(/\/+$/, '')).filter(Boolean))];
}

const config = {
  // Network info
  network: networkKey,
  networkName: networkDefaults.name,

  // Chain configuration (from network, with env override)
  chainId: parseInt(process.env.CHAIN_ID) || networkDefaults.chainId,
  rpcUrl: getRpcUrl(),
  explorer: networkDefaults.explorer,

  // Contract addresses
  // BountyEscrow address selected based on NETWORK
  bountyEscrowAddress: bountyEscrowAddresses[networkKey] || '',
  // Verdikta aggregator from network config (determined by NETWORK)
  verdiktaAggregatorAddress: networkDefaults.verdiktaAggregatorAddress,
  verdiktaAggregatorDeployBlock: networkDefaults.verdiktaAggregatorDeployBlock || 0,
  verdiktaRpcUrl: getVerdiktaRpcUrl(),

  // Server settings
  port: parseInt(process.env.PORT) || 5005,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Blockchain sync settings
  useBlockchainSync: process.env.USE_BLOCKCHAIN_SYNC === 'true',
  syncIntervalSeconds: parseInt(process.env.SYNC_INTERVAL_SECONDS) || 20,

  // IPFS settings
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
  ipfsPinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
  ipfsPinningKey: process.env.IPFS_PINNING_KEY || '',
  pinataGateway: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
  // Gateways every server-side IPFS read tries, in order. IPFS_READ_GATEWAYS
  // (comma-separated) replaces the default. Filebase leads because, as of
  // 2026-10-16, gateway.pinata.cloud (Cloudflare 1015), ipfs.io, dweb.link and
  // w3s.link all answer this server with 429, and cloudflare-ipfs.com is gone.
  ipfsReadGateways: readGateways(process.env.IPFS_READ_GATEWAYS, [
    'https://ipfs.filebase.io',
    process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
    process.env.IPFS_GATEWAY || 'https://ipfs.io',
    'https://dweb.link',
  ]),
  pinTimeout: parseInt(process.env.PIN_TIMEOUT_MS) || 20000,

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  // Anonymous single-bounty reads (GET /api/jobs/:id and /:id/onchain-status, no key):
  // per-client-IP budget, and how long an anonymous onchain-status snapshot is reused.
  publicReadRateLimitWindowMs: parseInt(process.env.PUBLIC_READ_RATE_LIMIT_WINDOW_MS) || 60000,
  publicReadRateLimitMax: parseInt(process.env.PUBLIC_READ_RATE_LIMIT_MAX) || 60,
  publicOnchainStatusCacheMs: parseInt(process.env.PUBLIC_ONCHAIN_STATUS_CACHE_MS) || 30000,

  // Temp directory
  tmpDir: process.env.VERDIKTA_TMP_DIR || null, // null means use os.tmpdir()

  // Testing
  devFakeRubricCid: process.env.DEV_FAKE_RUBRIC_CID === 'true',

  // Receipts-as-memes
  // Server-side salt used to generate stable pseudonymous agent IDs for receipts.
  // REQUIRED in production if receipts are enabled.
  receiptSalt: process.env.RECEIPT_SALT || '',

  // Archival settings
  archiveTtlDays: parseInt(process.env.ARCHIVE_TTL_DAYS) || 30,
  archiveAfterRetrievalDays: parseInt(process.env.ARCHIVE_AFTER_RETRIEVAL_DAYS) || 7,
  pinVerifyIntervalHours: parseInt(process.env.PIN_VERIFY_INTERVAL_HOURS) || 1,
};

// Alias for backwards compatibility
config.rpcProviderUrl = config.rpcUrl;

// BOUNTY ORACLE DEFAULTS (the key is still `submissionDefaults` to minimise churn).
//
// Since the September 2026 BountyEscrow revision these four values are chosen by
// the CREATOR at createBounty time (the `oracle` member of the CreateParams struct)
// and used verbatim for every evaluation of that bounty. Hunters no longer pass
// any of them to prepareSubmission — the contract reads bounty.oracle and sizes
// ethMaxBudget = aggregator.maxTotalFee(bounty.oracle.maxOracleFee).
//
// They are the defaults for POST /api/jobs/create (oracleMaxOracleFee /
// oracleAlpha / oracleEstimatedBaseCost / oracleMaxFeeBasedScaling), the create
// scripts, and the fee estimator's fallback. Canonical unit is WEI — convert with
// ethers.formatEther at the decimal-ETH call sites rather than re-typing the number.
//
// Contract bounds (checked at createBounty): maxOracleFee > 0 and <= aggregator
// ceiling (0.0004 ETH); estimatedBaseCost < maxOracleFee; 1 <= maxFeeBasedScaling
// <= 1000; 0 <= alpha <= 1000.
config.submissionDefaults = {
  maxOracleFeeWei: '20000000000000',      // 0.00002 ETH per oracle call
  estimatedBaseCostWei: '10000000000000', // 0.00001 ETH base cost per evaluation
  maxFeeBasedScaling: '3',                // x-factor cap on fee-based boost (>= 1)
  alpha: 500,                             // timeliness-vs-quality blend (0-1000)
};

// Deployment block numbers per network.
// These are the blocks at or just before the BountyEscrow deployment transactions.
// Used as the starting point for bootstrap event replay.
const deploymentBlocks = {
  'base-sepolia': 46_734_719,  // ETH BountyEscrow v0.5.0 0x1B4F…e08f (lens + wallet clones), 2026-09-12
  'base':         51_224_966,  // ETH BountyEscrow v0.5.0 0xA741…D3f6 (lens + wallet clones), 2026-09-12
};

config.deploymentBlock = deploymentBlocks[networkKey] || 0;

module.exports = { config, networks };
