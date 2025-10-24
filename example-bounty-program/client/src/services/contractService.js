/**
 * Frontend Contract Service
 * Handles WRITE-ONLY smart contract interactions via MetaMask
 *
 * IMPORTANT: This service is for USER TRANSACTIONS ONLY (writing to blockchain)
 * For READING job data, use apiService.getJob() which reads from backend cache
 *
 * Why?
 * - Reading from blockchain is slow (200-500ms per request)
 * - Backend syncs blockchain → local storage every 2 minutes
 * - Frontend reads from fast cached API (<10ms)
 */

import { ethers } from 'ethers';

// BountyEscrow ABI - only the functions we need to call
const BOUNTY_ESCROW_ABI = [
  "function createBounty(string rubricCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)",
  "function prepareSubmission(uint256 bountyId, string deliverableCid, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) returns (uint256, address, uint256)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId)",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function cancelBounty(uint256 bountyId)",
  "function closeExpiredBounty(uint256 bountyId)"
  // NOTE: No read functions! Frontend reads from backend API for cached data
];

class ContractService {
  constructor(contractAddress) {
    this.contractAddress = contractAddress;
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
  }

  /**
   * Connect to MetaMask and initialize contract
   */
  async connect() {
    if (!window.ethereum) {
      throw new Error('MetaMask not installed. Please install MetaMask to continue.');
    }

    try {
      // Request account access
      await window.ethereum.request({ method: 'eth_requestAccounts' });

      // Create provider and signer
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.userAddress = await this.signer.getAddress();

      // Initialize contract
      this.contract = new ethers.Contract(
        this.contractAddress,
        BOUNTY_ESCROW_ABI,
        this.signer
      );

      console.log('✅ Connected to MetaMask:', this.userAddress);

      return {
        address: this.userAddress,
        chainId: (await this.provider.getNetwork()).chainId
      };

    } catch (error) {
      console.error('Error connecting to MetaMask:', error);
      throw error;
    }
  }

  /**
   * Create a bounty on-chain via MetaMask
   *
   * @param {Object} params
   * @param {string} params.rubricCid - IPFS CID of the rubric
   * @param {number} params.classId - Verdikta class ID
   * @param {number} params.threshold - Passing threshold (0-100)
   * @param {number} params.bountyAmountEth - Bounty amount in ETH
   * @param {number} params.submissionWindowHours - Hours until deadline
   * @returns {Promise<Object>} Transaction result with bountyId
   */
  async createBounty({ rubricCid, classId, threshold, bountyAmountEth, submissionWindowHours }) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('Creating bounty on-chain...', {
        rubricCid,
        classId,
        threshold,
        bountyAmountEth,
        submissionWindowHours
      });

      // Calculate deadline
      const now = Math.floor(Date.now() / 1000);
      const submissionDeadline = now + (submissionWindowHours * 3600);

      // Convert ETH to Wei
      const bountyAmountWei = ethers.parseEther(bountyAmountEth.toString());

      // Call contract (MetaMask will prompt user to sign)
      const tx = await this.contract.createBounty(
        rubricCid,
        classId,
        threshold,
        submissionDeadline,
        { value: bountyAmountWei }
      );

      console.log('📤 Transaction sent:', tx.hash);

      // Wait for confirmation
      const receipt = await tx.wait();
      console.log('✅ Transaction confirmed:', receipt.hash);

      // Extract bountyId from BountyCreated event
      const event = receipt.logs
        .map(log => {
          try {
            return this.contract.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find(log => log && log.name === 'BountyCreated');

      const bountyId = event ? Number(event.args.bountyId) : null;

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        bountyId,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error creating bounty:', error);

      // Handle user rejection
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }

      throw error;
    }
  }

  /**
   * Creator cancels bounty early (before deadline) if no submissions exist
   *
   * @param {number} bountyId - The bounty to cancel
   * @returns {Promise<Object>} Transaction result
   */
  async cancelBounty(bountyId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('Cancelling bounty...', { bountyId });

      const tx = await this.contract.cancelBounty(bountyId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Bounty cancelled:', receipt.hash);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error cancelling bounty:', error);

      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }

      // Parse contract revert reasons
      if (error.message.includes('not creator')) {
        throw new Error('Only the bounty creator can cancel');
      }
      if (error.message.includes('cancel lock period not passed')) {
        throw new Error('Cannot cancel yet - lock period not passed');
      }
      if (error.message.includes('cannot cancel with submissions')) {
        throw new Error('Cannot cancel - submissions exist');
      }

      throw error;
    }
  }

  /**
   * Close an expired bounty and return funds to creator
   * Can be called by ANYONE after submission deadline passes
   *
   * @param {number} bountyId - The bounty to close
   * @returns {Promise<Object>} Transaction result
   */
  async closeExpiredBounty(bountyId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('Closing expired bounty...', { bountyId });

      const tx = await this.contract.closeExpiredBounty(bountyId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Expired bounty closed:', receipt.hash);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error closing expired bounty:', error);

      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }

      // Parse contract revert reasons
      if (error.message.includes('deadline not passed')) {
        throw new Error('Cannot close yet - deadline not passed');
      }
      if (error.message.includes('active submission exists')) {
        throw new Error('Cannot close - active evaluations in progress. Finalize them first.');
      }

      throw error;
    }
  }

  /**
   * Check if user is connected
   */
  isConnected() {
    return this.contract !== null && this.userAddress !== null;
  }

  /**
   * Get current user address
   */
  getAddress() {
    return this.userAddress;
  }

  /**
   * Get network info
   */
  async getNetwork() {
    if (!this.provider) return null;
    return await this.provider.getNetwork();
  }

  /**
   * Listen for account changes
   */
  onAccountChange(callback) {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', async (accounts) => {
        if (accounts.length > 0) {
          await this.connect();
          callback(accounts[0]);
        } else {
          this.disconnect();
          callback(null);
        }
      });
    }
  }

  /**
   * Listen for network changes
   */
  onNetworkChange(callback) {
    if (window.ethereum) {
      window.ethereum.on('chainChanged', (chainId) => {
        callback(chainId);
        // Recommend page reload on network change
        window.location.reload();
      });
    }
  }

  /**
   * Disconnect
   */
  disconnect() {
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
  }
}

// Export singleton instance
let contractService = null;

export function initializeContractService(contractAddress) {
  contractService = new ContractService(contractAddress);
  return contractService;
}

export function getContractService() {
  if (!contractService) {
    throw new Error('Contract service not initialized');
  }
  return contractService;
}

export default ContractService;

