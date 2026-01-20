// src/config/index.js

// ---- Network definitions ----
const networks = {
  'base-sepolia': {
    chainId: 84532,
    chainIdHex: '0x14a34',
    name: 'Base Sepolia',
    currency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    linkTokenAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
  },
  'base': {
    chainId: 8453,
    chainIdHex: '0x2105',
    name: 'Base',
    currency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    linkTokenAddress: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
  },
};

// ---- Determine current network from environment ----
const networkKey = import.meta.env.VITE_NETWORK || 'base-sepolia';
const networkDefaults = networks[networkKey] || networks['base-sepolia'];

// ---- Network your dapp should use (matches your walletService expectations) ----
export const currentNetwork = {
  ...networkDefaults,
  // Allow env overrides
  chainId: Number(import.meta.env.VITE_CHAIN_ID) || networkDefaults.chainId,
  rpcUrl: import.meta.env.VITE_RPC_URL || networkDefaults.rpcUrl,
  linkTokenAddress: import.meta.env.VITE_LINK_TOKEN_ADDRESS || networkDefaults.linkTokenAddress,
};

// ---- App-wide config pulled from Vite env vars ----
export const config = {
  // BountyEscrow address (must be set in .env file)
  bountyEscrowAddress: import.meta.env.VITE_BOUNTY_ESCROW_ADDRESS || '',

  // API base URL: supports either name so you don't have to rename your existing var
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_URL || // <-- you already have this one
    '',

  // LINK token address (from network config)
  linkTokenAddress: currentNetwork.linkTokenAddress,

  // RPC URL for read-only operations
  rpcUrl: currentNetwork.rpcUrl,
};

