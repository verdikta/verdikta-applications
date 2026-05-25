/**
 * Chain metadata keyed by the network-selector value (see NetworkContext).
 *
 * The header selector is the source of truth for which chain the app is
 * "on"; this maps that selection to the concrete chain parameters MetaMask
 * needs for wallet_switchEthereumChain / wallet_addEthereumChain.
 */

export const CHAINS = {
  base: {
    network: 'base',
    chainId: 8453,
    chainIdHex: '0x2105',
    name: 'Base Mainnet',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  base_sepolia: {
    network: 'base_sepolia',
    chainId: 84532,
    chainIdHex: '0x14A34',
    name: 'Base Sepolia Testnet',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
};

const DEFAULT = 'base_sepolia';

export const chainForNetwork = (network) => CHAINS[network] || CHAINS[DEFAULT];
export const chainIdForNetwork = (network) => chainForNetwork(network).chainId;
