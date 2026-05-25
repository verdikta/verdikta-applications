/**
 * WalletContext
 * React wrapper around the singleton walletService (injected MetaMask via
 * ethers v6). Exposes connection state + actions to the app, consistent with
 * NetworkContext. The wallet's chainId is tracked but not enforced here —
 * pages compare it against the header-selected network themselves.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import walletService from '../services/wallet';

const WalletContext = createContext(null);

export function WalletProvider({ children }) {
  const [state, setState] = useState(() => walletService.getState());
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const unsubscribe = walletService.subscribe(setState);
    // Silent reconnect for returning users (no popup).
    walletService.tryReconnect();
    return unsubscribe;
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      await walletService.connect();
    } finally {
      setConnecting(false);
    }
  };

  const value = {
    ...state,
    connecting,
    isMetaMaskInstalled: walletService.isMetaMaskInstalled(),
    connect,
    disconnect: () => walletService.disconnect(),
    switchChain: (chain) => walletService.switchChain(chain),
    getSigner: () => walletService.getSigner(),
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within a WalletProvider');
  return ctx;
}
