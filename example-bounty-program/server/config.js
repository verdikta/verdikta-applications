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
  },
  'base': {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    verdiktaAggregatorAddress: '0x2f7a02298D4478213057edA5e5bEB07F20c4c054',
  },
};

// Determine current network from environment
const networkKey = process.env.NETWORK || 'base-sepolia';
const networkDefaults = networks[networkKey] || networks['base-sepolia'];

// Export configuration with env overrides
const config = {
  // Network info
  network: networkKey,
  networkName: networkDefaults.name,

  // Chain configuration (from network, with env override)
  chainId: parseInt(process.env.CHAIN_ID) || networkDefaults.chainId,
  rpcUrl: process.env.RPC_URL || process.env.RPC_PROVIDER_URL || networkDefaults.rpcUrl,
  explorer: networkDefaults.explorer,

  // Contract addresses
  // BOUNTY_ESCROW_ADDRESS must be set in .env file
  bountyEscrowAddress: process.env.BOUNTY_ESCROW_ADDRESS || '',
  // Verdikta aggregator from network config, with env override
  verdiktaAggregatorAddress: process.env.VERDIKTA_AGGREGATOR_ADDRESS || networkDefaults.verdiktaAggregatorAddress,

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

  // Archival settings
  archiveTtlDays: parseInt(process.env.ARCHIVE_TTL_DAYS) || 30,
  archiveAfterRetrievalDays: parseInt(process.env.ARCHIVE_AFTER_RETRIEVAL_DAYS) || 7,
  pinVerifyIntervalHours: parseInt(process.env.PIN_VERIFY_INTERVAL_HOURS) || 1,
};

// Alias for backwards compatibility
config.rpcProviderUrl = config.rpcUrl;

module.exports = { config, networks };
