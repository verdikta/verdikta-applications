/**
 * Application configuration
 * Loads from environment variables (Vite uses VITE_ prefix)
 */

function requireEnv(name) {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Check your .env file and rebuild.`);
  }
  return value;
}

const network = import.meta.env.VITE_NETWORK || 'base-sepolia';

const bountyEscrowAddress = network === 'base'
  ? requireEnv('VITE_BOUNTY_ESCROW_ADDRESS_BASE')
  : requireEnv('VITE_BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA');

const verdiktaAggregatorAddress = requireEnv('VITE_VERDIKTA_AGGREGATOR_ADDRESS_' + (network === 'base' ? 'BASE' : 'BASE_SEPOLIA'));

export const config = {
  // API Configuration - use relative URL so requests go through Nginx proxy
  apiUrl: import.meta.env.VITE_API_URL || '',
  apiTimeout: parseInt(import.meta.env.VITE_API_TIMEOUT) || 30000,

  // Blockchain Configuration
  network,
  chainId: parseInt(import.meta.env.VITE_CHAIN_ID) || 84532,

  // IPFS Configuration
  ipfsGateway: import.meta.env.VITE_IPFS_GATEWAY || 'https://ipfs.io',

  // Feature Flags
  enableDebug: import.meta.env.VITE_ENABLE_DEBUG === 'true',

  // Contract addresses (from env vars, no defaults)
  bountyEscrowAddress,
  verdiktaAggregatorAddress,

  // Default parameters for prepareSubmission — single source of truth shared by
  // SubmitWork and the contractService default args. Canonical unit is WEI.
  // maxOracleFee is a product decision (per-oracle pay), kept under the
  // aggregator's on-chain 0.0004 ETH ceiling. Mirror of server config's
  // submissionDefaults (the two codebases can't share a module).
  submissionDefaults: {
    maxOracleFeeWei: '20000000000000',      // 0.00002 ETH per oracle call
    estimatedBaseCostWei: '10000000000000', // 0.00001 ETH base cost per evaluation
    maxFeeBasedScaling: '3',                // x-factor cap on fee-based boost (>= 1)
    alpha: 500,                             // timeliness-vs-quality blend (0-1000)
  },

  // Network Details
  // Contract addresses are only available for the active network (from env vars).
  // The inactive network will have null addresses.
  networks: {
    'base-sepolia': {
      name: 'Base Sepolia Testnet',
      chainId: 84532,
      chainIdHex: '0x14A34',
      rpcUrl: 'https://sepolia.base.org',
      explorer: 'https://sepolia.basescan.org',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      bountyEscrowAddress: network === 'base-sepolia' ? bountyEscrowAddress : null,
      verdiktaAggregatorAddress: network === 'base-sepolia' ? verdiktaAggregatorAddress : null,
    },
    'base': {
      name: 'Base Mainnet',
      chainId: 8453,
      chainIdHex: '0x2105',
      rpcUrl: 'https://mainnet.base.org',
      explorer: 'https://basescan.org',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      bountyEscrowAddress: network === 'base' ? bountyEscrowAddress : null,
      verdiktaAggregatorAddress: network === 'base' ? verdiktaAggregatorAddress : null,
    }
  },
};

// Get current network config
export const currentNetwork = {
  ...(config.networks[config.network] || config.networks['base-sepolia']),
  bountyEscrowAddress,
  verdiktaAggregatorAddress,
};

// Log configuration in debug mode
if (config.enableDebug) {
  console.log('App Configuration:', {
    apiUrl: config.apiUrl,
    network: config.network,
    chainId: config.chainId,
    bountyEscrowAddress: config.bountyEscrowAddress,
    verdiktaAggregatorAddress: config.verdiktaAggregatorAddress,
  });
}
