/**
 * Wallet Service (injected MetaMask only)
 *
 * Singleton that wraps window.ethereum via ethers v6. Adapted from
 * example-bounty-program's wallet service, but with one deliberate difference:
 * this app's network is chosen by the header selector at runtime, not baked in
 * at build time. So the service only *tracks* the wallet's chainId — it never
 * enforces a specific chain or auto-disconnects on mismatch. Deciding whether
 * the wallet's chain matches the selected network (and prompting a switch) is
 * the UI's job (see MyArbiters).
 */

import { ethers } from 'ethers';

const STORAGE_KEY = 'arbiters_wallet_connected';

class WalletService {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.listeners = new Set();
  }

  isMetaMaskInstalled() {
    return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined';
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    const state = this.getState();
    this.listeners.forEach((cb) => cb(state));
  }

  /** Build provider/signer for an authorized account and read the chain id. */
  async _hydrate(address) {
    this.provider = new ethers.BrowserProvider(window.ethereum);
    this.signer = await this.provider.getSigner();
    this.address = address;
    const net = await this.provider.getNetwork();
    this.chainId = Number(net.chainId);
  }

  /**
   * Silent reconnect on page load if the user connected before and is still
   * authorized. Uses eth_accounts (no popup).
   */
  async tryReconnect() {
    if (!this.isMetaMaskInstalled()) return null;
    if (localStorage.getItem(STORAGE_KEY) !== 'true') return null;
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (!accounts.length) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      await this._hydrate(accounts[0]);
      this.setupEventListeners();
      this.notifyListeners();
      return this.getState();
    } catch (error) {
      console.warn('Wallet auto-reconnect failed:', error.message);
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  /** User-initiated connect (shows the MetaMask popup). */
  async connect() {
    if (!this.isMetaMaskInstalled()) {
      throw new Error('MetaMask is not installed. Please install MetaMask to continue.');
    }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    await this._hydrate(accounts[0]);
    this.setupEventListeners();
    localStorage.setItem(STORAGE_KEY, 'true');
    this.notifyListeners();
    return this.getState();
  }

  disconnect() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }

  /**
   * Ask MetaMask to switch to a chain (from config/chains.js). If the chain is
   * unknown to the wallet (4902) we add it first. The chainChanged listener
   * refreshes our state once the switch lands.
   */
  async switchChain(chain) {
    if (!this.isMetaMaskInstalled()) throw new Error('MetaMask is not installed');
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chain.chainIdHex }],
      });
    } catch (error) {
      if (error.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.chainIdHex,
            chainName: chain.name,
            nativeCurrency: chain.currency,
            rpcUrls: [chain.rpcUrl],
            blockExplorerUrls: [chain.explorer],
          }],
        });
      } else if (error.code === 4001) {
        throw new Error('Network switch rejected.');
      } else {
        throw error;
      }
    }
  }

  setupEventListeners() {
    if (!window.ethereum) return;

    if (this.handleAccountsChanged) {
      window.ethereum.removeListener('accountsChanged', this.handleAccountsChanged);
    }
    if (this.handleChainChanged) {
      window.ethereum.removeListener('chainChanged', this.handleChainChanged);
    }

    this.handleAccountsChanged = async (accounts) => {
      if (!accounts.length) {
        this.disconnect();
        return;
      }
      if (accounts[0] !== this.address) {
        this.address = accounts[0];
        if (this.provider) {
          try {
            this.signer = await this.provider.getSigner();
          } catch (e) {
            console.error('Failed to refresh signer after account change:', e);
          }
        }
        this.notifyListeners();
      }
    };

    this.handleChainChanged = async (chainIdHex) => {
      this.chainId = parseInt(chainIdHex, 16);
      // Recreate provider/signer so they bind to the new chain. We do NOT
      // disconnect on mismatch — the UI surfaces a "switch network" prompt.
      if (window.ethereum && this.address) {
        try {
          this.provider = new ethers.BrowserProvider(window.ethereum);
          this.signer = await this.provider.getSigner();
        } catch (e) {
          console.error('Failed to refresh provider after chain change:', e);
        }
      }
      this.notifyListeners();
    };

    window.ethereum.on('accountsChanged', this.handleAccountsChanged);
    window.ethereum.on('chainChanged', this.handleChainChanged);
  }

  getState() {
    return {
      isConnected: !!this.address,
      address: this.address,
      chainId: this.chainId,
    };
  }

  getProvider() {
    return this.provider;
  }

  getSigner() {
    return this.signer;
  }
}

export const walletService = new WalletService();
export default walletService;
