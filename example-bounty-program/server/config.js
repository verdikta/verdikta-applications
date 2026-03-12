/**
 * Server configuration
 * Network-specific values are selected based on NETWORK env var.
 * Contract addresses (BOUNTY_ESCROW_ADDRESS) must be set in .env file.
 */

// Network definitions
const networks = {
  'base-sepolia': {
    chainId: 84532,
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    verdiktaAggregatorAddress: '0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089',
    linkTokenAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
  },
  'base': {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    verdiktaAggregatorAddress: '0x2f7a02298D4478213057edA5e5bEB07F20c4c054',
    linkTokenAddress: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
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

// Select BountyEscrow address based on network
const bountyEscrowAddresses = {
  'base-sepolia': process.env.BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA || '',
  'base': process.env.BOUNTY_ESCROW_ADDRESS_BASE || '',
};

// Export configuration with env overrides
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
  // LINK token address for oracle payments
  linkTokenAddress: networkDefaults.linkTokenAddress,

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
  pinTimeout: parseInt(process.env.PIN_TIMEOUT_MS) || 20000,

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,

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

// Deployment block numbers per network.
// These are the blocks at or just before the BountyEscrow deployment transactions.
// Used as the starting point for bootstrap event replay.
const deploymentBlocks = {
  'base-sepolia': 20_290_000,  // ~2026-01-07T19:42:34Z
  'base':         26_800_000,  // ~2026-01-21T04:01:15Z
};

config.deploymentBlock = deploymentBlocks[networkKey] || 0;

module.exports = { config, networks };
