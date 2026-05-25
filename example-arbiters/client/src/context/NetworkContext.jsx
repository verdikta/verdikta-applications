/**
 * NetworkContext
 * Single source of truth for the selected chain (Base mainnet / Base Sepolia).
 * The selector lives in the global Header; every network-aware page consumes
 * `useNetwork()` so a switch re-renders all of them in sync. Persisted to
 * localStorage under 'selectedNetwork' (the key the API layer already expects).
 *
 * Values use underscored keys ('base' / 'base_sepolia'); the server normalizes
 * 'base_sepolia' -> 'base-sepolia'.
 */

import { createContext, useContext, useState, useCallback } from 'react';

export const NETWORKS = [
  { value: 'base', label: 'Base Mainnet' },
  { value: 'base_sepolia', label: 'Base Sepolia Testnet' }
];
export const DEFAULT_NETWORK = 'base_sepolia';

const STORAGE_KEY = 'selectedNetwork';

const NetworkContext = createContext(null);

export function NetworkProvider({ children }) {
  const [selectedNetwork, setSelectedNetworkState] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_NETWORK;
  });

  const setNetwork = useCallback((network) => {
    setSelectedNetworkState(network);
    try {
      localStorage.setItem(STORAGE_KEY, network);
    } catch {
      // Ignore persistence failures (e.g. private-mode storage limits).
    }
  }, []);

  return (
    <NetworkContext.Provider value={{ selectedNetwork, setNetwork, networks: NETWORKS }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used within a NetworkProvider');
  return ctx;
}
