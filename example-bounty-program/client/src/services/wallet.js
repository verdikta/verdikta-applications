/**
 * Wallet Service
 * Handles MetaMask connection and network management
 */

import { ethers } from 'ethers';
import { currentNetwork } from '../config';

const STORAGE_KEY = 'wallet_was_connected';

class WalletService {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.listeners = new Set();
  }

  /**
   * Try to silently reconnect if user was previously connected.
   * Uses eth_accounts (no prompt) instead of eth_requestAccounts.
   * Call this on app initialization.
   */
  async tryReconnect() {
    if (!this.isMetaMaskInstalled()) {
      return null;
    }

    // Check if user previously connected
    const wasConnected = localStorage.getItem(STORAGE_KEY) === 'true';
    if (!wasConnected) {
      return null;
    }

    try {
      // eth_accounts returns accounts if already authorized (no prompt)
      const accounts = await window.ethereum.request({
        method: 'eth_accounts'
      });

      if (accounts.length === 0) {
        // User revoked access or never authorized
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }

      // User is still authorized - reconnect silently
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.address = accounts[0];

      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      // Don't auto-reconnect if on wrong network
      if (this.chainId !== currentNetwork.chainId) {
        console.warn(`Auto-reconnect skipped: wallet on chain ${this.chainId}, expected ${currentNetwork.chainId}`);
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        return null;
      }

      this.setupEventListeners();
      this.notifyListeners();

      console.log('✅ Wallet auto-reconnected:', this.address);

      return {
        address: this.address,
        chainId: this.chainId,
        isCorrectNetwork: true
      };
    } catch (error) {
      console.warn('Auto-reconnect failed:', error.message);
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  /**
   * Check if MetaMask is installed
   */
  isMetaMaskInstalled() {
    return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined';
  }

  /**
   * Subscribe to wallet state changes
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all subscribers of state change
   */
  notifyListeners() {
    const state = this.getState();
    this.listeners.forEach(callback => callback(state));
  }

  /**
   * Connect to MetaMask
   */
  async connect() {
    if (!this.isMetaMaskInstalled()) {
      throw new Error('MetaMask is not installed. Please install MetaMask to continue.');
    }

    try {
      // Request account access
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      });

      // Create provider and signer
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.address = accounts[0];

      // Get current chain ID
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      // Check if on correct network - prompt to switch if wrong
      if (this.chainId !== currentNetwork.chainId) {
        console.warn(`Connected to chain ${this.chainId}, expected ${currentNetwork.chainId}. Prompting switch.`);
        try {
          await this.switchNetwork();
          // Wait for MetaMask to fully process the switch
          await new Promise(resolve => setTimeout(resolve, 500));
          // Recreate provider and signer for new network
          this.provider = new ethers.BrowserProvider(window.ethereum);
          this.signer = await this.provider.getSigner();
          // Verify we're now on the correct network
          const updatedNetwork = await this.provider.getNetwork();
          this.chainId = Number(updatedNetwork.chainId);
          if (this.chainId !== currentNetwork.chainId) {
            throw new Error('Network switch did not complete');
          }
        } catch (switchError) {
          // User rejected or switch failed - clean up
          this.provider = null;
          this.signer = null;
          this.address = null;
          this.chainId = null;
          throw new Error(`Please switch to ${currentNetwork.name} to connect.`);
        }
      }

      // Set up event listeners
      this.setupEventListeners();

      // Remember that user connected (for auto-reconnect after refresh)
      localStorage.setItem(STORAGE_KEY, 'true');

      // Notify subscribers
      this.notifyListeners();

      return {
        address: this.address,
        chainId: this.chainId,
        isCorrectNetwork: this.chainId === currentNetwork.chainId
      };
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      throw error;
    }
  }

  /**
   * Disconnect wallet
   */
  disconnect() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;

    // Clear auto-reconnect flag
    localStorage.removeItem(STORAGE_KEY);

    this.notifyListeners();
  }

  /**
   * Switch to correct network
   */
  async switchNetwork() {
    if (!this.isMetaMaskInstalled()) {
      throw new Error('MetaMask is not installed');
    }

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentNetwork.chainIdHex }]
      });

      // Wait a bit for the network to switch
      await new Promise(resolve => setTimeout(resolve, 500));

      // Update provider and chainId
      if (this.provider) {
        const network = await this.provider.getNetwork();
        this.chainId = Number(network.chainId);
        
        // Recreate signer after network switch
        if (this.address) {
          this.signer = await this.provider.getSigner();
        }
      }

      this.notifyListeners();
      return true;
    } catch (error) {
      // Network doesn't exist, try to add it
      if (error.code === 4902) {
        return await this.addNetwork();
      } else if (error.code === 4001) {
        // User rejected the request
        throw new Error('Network switch rejected by user');
      } else {
        throw error;
      }
    }
  }

  /**
   * Add network to MetaMask
   */
  async addNetwork() {
    try {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: currentNetwork.chainIdHex,
          chainName: currentNetwork.name,
          nativeCurrency: currentNetwork.currency,
          rpcUrls: [currentNetwork.rpcUrl],
          blockExplorerUrls: [currentNetwork.explorer]
        }]
      });

      // Wait a bit for the network to be added
      await new Promise(resolve => setTimeout(resolve, 500));

      // Update chainId after adding
      if (this.provider) {
        const network = await this.provider.getNetwork();
        this.chainId = Number(network.chainId);
        
        // Recreate signer
        if (this.address) {
          this.signer = await this.provider.getSigner();
        }
      }

      this.notifyListeners();
      return true;
    } catch (error) {
      console.error('Failed to add network:', error);
      throw error;
    }
  }

  /**
   * Set up MetaMask event listeners
   */
  setupEventListeners() {
    if (!window.ethereum) return;

    // Remove existing listeners to prevent duplicates (only if they exist)
    if (this.handleAccountsChanged) {
      window.ethereum.removeListener('accountsChanged', this.handleAccountsChanged);
    }
    if (this.handleChainChanged) {
      window.ethereum.removeListener('chainChanged', this.handleChainChanged);
    }

    // Account changed
    this.handleAccountsChanged = async (accounts) => {
      console.log('Accounts changed:', accounts);
      
      if (accounts.length === 0) {
        // User disconnected
        this.disconnect();
      } else if (accounts[0] !== this.address) {
        // Account switched
        this.address = accounts[0];
        
        // Update signer
        if (this.provider) {
          try {
            this.signer = await this.provider.getSigner();
          } catch (error) {
            console.error('Failed to get signer after account change:', error);
          }
        }
        
        this.notifyListeners();
      }
    };

    // Chain changed
    this.handleChainChanged = async (chainIdHex) => {
      console.log('Chain changed:', chainIdHex);
      
      const newChainId = parseInt(chainIdHex, 16);
      this.chainId = newChainId;
      
      // Recreate provider and signer for new network
      if (window.ethereum && this.address) {
        try {
          this.provider = new ethers.BrowserProvider(window.ethereum);
          this.signer = await this.provider.getSigner();
        } catch (error) {
          console.error('Failed to update provider after chain change:', error);
        }
      }
      
      // Auto-disconnect if on wrong network
      if (newChainId !== currentNetwork.chainId) {
        console.warn(
          `Wrong network detected. Connected to chain ${newChainId}, ` +
          `expected ${currentNetwork.chainId} (${currentNetwork.name}). Disconnecting.`
        );
        this.disconnect();
        return;
      }

      this.notifyListeners();
    };

    window.ethereum.on('accountsChanged', this.handleAccountsChanged);
    window.ethereum.on('chainChanged', this.handleChainChanged);
  }

  /**
   * Get current wallet state
   */
  getState() {
    return {
      isConnected: !!this.address,
      address: this.address,
      chainId: this.chainId,
      isCorrectNetwork: this.chainId === currentNetwork.chainId,
      expectedChainId: currentNetwork.chainId,
      expectedNetwork: currentNetwork.name
    };
  }

  /**
   * Format address for display
   */
  formatAddress(address) {
    if (!address) return '';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Get provider (for contract interactions)
   */
  getProvider() {
    return this.provider;
  }

  /**
   * Get signer (for transactions)
   */
  getSigner() {
    return this.signer;
  }

  /**
   * Get network name from chain ID
   */
  getNetworkName(chainId) {
    const networks = {
      1: 'Ethereum Mainnet',
      5: 'Goerli Testnet',
      11155111: 'Sepolia Testnet',
      8453: 'Base Mainnet',
      84532: 'Base Sepolia',
      137: 'Polygon Mainnet',
      80001: 'Mumbai Testnet'
    };
    return networks[chainId] || `Chain ${chainId}`;
  }
}

// Export singleton instance
export const walletService = new WalletService();
export default walletService;

