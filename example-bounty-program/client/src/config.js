/**
 * Application configuration
 * Loads from environment variables (Vite uses VITE_ prefix)
 */

export const config = {
  // API Configuration
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:5005',
  apiTimeout: parseInt(import.meta.env.VITE_API_TIMEOUT) || 30000,

  // Blockchain Configuration
  network: import.meta.env.VITE_NETWORK || 'base-sepolia',
  chainId: parseInt(import.meta.env.VITE_CHAIN_ID) || 84532,
  
  // Contract Addresses
  bountyEscrowAddress: import.meta.env.VITE_BOUNTY_ESCROW_ADDRESS,

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
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
    },
    'base': {
      name: 'Base',
      chainId: 8453,
      chainIdHex: '0x2105',
      rpcUrl: 'https://mainnet.base.org',
      explorer: 'https://basescan.org',
      currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
    }
  }
};

// Get current network config
export const currentNetwork = config.networks[config.network] || config.networks['base-sepolia'];

// Log configuration in debug mode
if (config.enableDebug) {
  console.log('🔧 App Configuration:', {
    apiUrl: config.apiUrl,
    network: config.network,
    chainId: config.chainId,
    bountyEscrowAddress: config.bountyEscrowAddress || 'Not set'
  });
}



