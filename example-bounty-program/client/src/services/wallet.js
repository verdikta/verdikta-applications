/**
 * Wallet Service
 * Handles MetaMask connection and network management
 */

import { ethers } from 'ethers';
import { currentNetwork } from '../config';

class WalletService {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
  }

  /**
   * Check if MetaMask is installed
   */
  isMetaMaskInstalled() {
    return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined';
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

      // Check if on correct network
      if (this.chainId !== currentNetwork.chainId) {
        await this.switchNetwork();
      }

      // Set up event listeners
      this.setupEventListeners();

      return {
        address: this.address,
        chainId: this.chainId
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
  }

  /**
   * Switch to correct network
   */
  async switchNetwork() {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentNetwork.chainIdHex }]
      });

      // Update chainId after switch
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);
    } catch (error) {
      // Network doesn't exist, try to add it
      if (error.code === 4902) {
        await this.addNetwork();
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

      // Update chainId after adding
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);
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

    // Account changed
    window.ethereum.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        this.disconnect();
        window.location.reload();
      } else {
        this.address = accounts[0];
        window.location.reload();
      }
    });

    // Chain changed
    window.ethereum.on('chainChanged', () => {
      window.location.reload();
    });
  }

  /**
   * Get current wallet state
   */
  getState() {
    return {
      isConnected: !!this.address,
      address: this.address,
      chainId: this.chainId,
      isCorrectNetwork: this.chainId === currentNetwork.chainId
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
}

// Export singleton instance
export const walletService = new WalletService();
export default walletService;

