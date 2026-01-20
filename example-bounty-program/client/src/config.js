/**
 * Application configuration
 * Loads from environment variables (Vite uses VITE_ prefix)
 */

export const config = {
  // API Configuration - use relative URL so requests go through Nginx proxy
  apiUrl: import.meta.env.VITE_API_URL || '',
  apiTimeout: parseInt(import.meta.env.VITE_API_TIMEOUT) || 30000,

  // Blockchain Configuration
  network: import.meta.env.VITE_NETWORK || 'base-sepolia',
  chainId: parseInt(import.meta.env.VITE_CHAIN_ID) || 84532,

  // IPFS Configuration
  ipfsGateway: import.meta.env.VITE_IPFS_GATEWAY || 'https://ipfs.io',

  // Feature Flags
  enableDebug: import.meta.env.VITE_ENABLE_DEBUG === 'true',

  // Network Details
  networks: {
    'base-sepolia': {
      name: 'Base Sepolia',
      chainId: 84532,
      chainIdHex: '0x14A34',
      rpcUrl: 'https://sepolia.base.org',
      explorer: 'https://sepolia.basescan.org',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      linkTokenAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410'
    },
    'base': {
      name: 'Base',
      chainId: 8453,
      chainIdHex: '0x2105',
      rpcUrl: 'https://mainnet.base.org',
      explorer: 'https://basescan.org',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      linkTokenAddress: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196'
    }
  },

  // LINK token address (from current network)
  get linkTokenAddress() {
    const network = this.networks[this.network] || this.networks['base-sepolia'];
    return import.meta.env.VITE_LINK_TOKEN_ADDRESS || network.linkTokenAddress;
  },

  // BountyEscrow address (must be set in .env file)
  get bountyEscrowAddress() {
    return import.meta.env.VITE_BOUNTY_ESCROW_ADDRESS || '';
  }
};

// Get current network config
const networkConfig = config.networks[config.network] || config.networks['base-sepolia'];
export const currentNetwork = {
  ...networkConfig,
  // Allow env override for LINK token address
  linkTokenAddress: import.meta.env.VITE_LINK_TOKEN_ADDRESS || networkConfig.linkTokenAddress
};

// Log configuration in debug mode
if (config.enableDebug) {
  console.log('🔧 App Configuration:', {
    apiUrl: config.apiUrl,
    network: config.network,
    chainId: config.chainId,
    bountyEscrowAddress: config.bountyEscrowAddress || 'Not set'
  });
}



