// src/config/index.js

// ---- Network your dapp should use (matches your walletService expectations) ----
export const currentNetwork = {
  // Base Sepolia defaults (change if you’re on a different chain)
  chainId: 84532,
  chainIdHex: '0x14a34',
  name: 'Base Sepolia',
  currency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org',
  explorer: 'https://sepolia.basescan.org',
};

// ---- App-wide config pulled from Vite env vars ----
export const config = {
  // Your deployed BountyEscrow address (already in your .env)
  bountyEscrowAddress: import.meta.env.VITE_BOUNTY_ESCROW_ADDRESS || '',

  // API base URL: supports either name so you don’t have to rename your existing var
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_URL || // <-- you already have this one
    '',
};

