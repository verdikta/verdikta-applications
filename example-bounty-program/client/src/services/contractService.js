/**
 * Frontend Contract Service (OPTIMIZED)
 * Handles WRITE-ONLY smart contract interactions via MetaMask
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Singleton provider/signer instances (avoid repeated MetaMask connections)
 * - Cached contract instances
 * - Debounced RPC calls
 * - Reduced polling frequency
 * - Connection state management
 *
 * IMPORTANT: This service is for USER TRANSACTIONS ONLY (writing to blockchain)
 * For READING job data, use apiService.getJob() which reads from backend cache
 */

import { ethers } from 'ethers';
import { config, currentNetwork } from '../config';

// LINK token address from config (supports both Base Sepolia and Base Mainnet)
const LINK_ADDRESS = config.linkTokenAddress;

// BountyEscrow ABI - only the functions we need to call
const BOUNTY_ESCROW_ABI = [
  // Events
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 linkMaxBudget)",

  // Write Functions
  "function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)",
  "function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) returns (uint256, address, uint256)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId)",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)",
  "function closeExpiredBounty(uint256 bountyId)",
  
  // View Functions (used sparingly)
  "function getEffectiveBountyStatus(uint256) view returns (string)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))",
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)",
  "function verdikta() view returns (address)"
];

// LINK token ABI (minimal)
const LINK_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

// ============================================================================
// PERFORMANCE: Debounce utility
// ============================================================================

const pendingCalls = new Map();

/**
 * Debounce identical RPC calls within a time window
 * Prevents hammering MetaMask with duplicate requests
 */
function debounceRpcCall(key, fn, windowMs = 500) {
  const now = Date.now();
  const pending = pendingCalls.get(key);
  
  if (pending && (now - pending.timestamp) < windowMs) {
    // Return cached promise if within debounce window
    return pending.promise;
  }
  
  const promise = fn();
  pendingCalls.set(key, { promise, timestamp: now });
  
  // Clean up after resolution
  promise.finally(() => {
    setTimeout(() => {
      const current = pendingCalls.get(key);
      if (current && current.promise === promise) {
        pendingCalls.delete(key);
      }
    }, windowMs);
  });
  
  return promise;
}

// ============================================================================
// CONTRACT SERVICE CLASS
// ============================================================================

class ContractService {
  constructor(contractAddress) {
    this.contractAddress = contractAddress;
    
    // Singleton instances - created once, reused
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
    
    // Cached contract instances
    this._linkContract = null;
    this._readOnlyProvider = null;
    
    // Connection state
    this._connecting = false;
    this._connectionPromise = null;
    
    // Cache for expensive reads
    this._statusCache = new Map();
    this._statusCacheTTL = 5000; // 5 seconds
  }

  // ==========================================================================
  // PROVIDER MANAGEMENT (OPTIMIZED)
  // ==========================================================================

  /**
   * Get a read-only provider (doesn't prompt MetaMask)
   * Used for view calls that don't need signing
   */
  getReadOnlyProvider() {
    if (!this._readOnlyProvider && window.ethereum) {
      this._readOnlyProvider = new ethers.BrowserProvider(window.ethereum);
    }
    return this._readOnlyProvider;
  }

  /**
   * Get cached LINK contract instance
   */
  getLinkContract(signerOrProvider) {
    // For write operations, create with signer
    if (signerOrProvider) {
      return new ethers.Contract(LINK_ADDRESS, LINK_ABI, signerOrProvider);
    }
    
    // For read operations, use cached instance
    if (!this._linkContract) {
      const provider = this.getReadOnlyProvider();
      if (provider) {
        this._linkContract = new ethers.Contract(LINK_ADDRESS, LINK_ABI, provider);
      }
    }
    return this._linkContract;
  }

  /**
   * Connect to MetaMask and initialize contract
   * OPTIMIZED: Prevents duplicate connection attempts
   */
  async connect() {
    // Return existing connection if already connected
    if (this.contract && this.userAddress) {
      return {
        address: this.userAddress,
        chainId: (await this.provider.getNetwork()).chainId
      };
    }

    // Prevent duplicate concurrent connection attempts
    if (this._connecting && this._connectionPromise) {
      return this._connectionPromise;
    }

    this._connecting = true;
    this._connectionPromise = this._doConnect();
    
    try {
      return await this._connectionPromise;
    } finally {
      this._connecting = false;
      this._connectionPromise = null;
    }
  }

  async _doConnect() {
    if (!window.ethereum) {
      throw new Error('MetaMask not installed. Please install MetaMask to continue.');
    }

    try {
      // Request account access
      await window.ethereum.request({ method: 'eth_requestAccounts' });

      // Create provider and signer (ONCE)
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.userAddress = await this.signer.getAddress();

      // Initialize main contract
      this.contract = new ethers.Contract(
        this.contractAddress,
        BOUNTY_ESCROW_ABI,
        this.signer
      );

      // Update read-only provider reference
      this._readOnlyProvider = this.provider;

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

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  /**
   * Create a bounty on-chain via MetaMask
   */
  async createBounty({ evaluationCid, classId, threshold, bountyAmountEth, submissionWindowHours }) {
    if (!this.contract) throw new Error('Contract not initialized. Call connect() first.');

    // Quick UI validations
    if (!evaluationCid || typeof evaluationCid !== 'string') throw new Error('Evaluation CID is empty');
    const winHrs = Number(submissionWindowHours);
    if (!Number.isFinite(winHrs) || winHrs <= 0) throw new Error('Submission window (hours) must be > 0');
    const thrNum = Number(threshold);
    if (!Number.isFinite(thrNum) || thrNum < 0 || thrNum > 100) throw new Error('Threshold must be 0..100');
    const ethStr = String(bountyAmountEth);
    if (isNaN(Number(ethStr)) || Number(ethStr) <= 0) throw new Error('Payout amount (ETH) must be > 0');

    try {
      // Encode exact solidity widths
      const now = Math.floor(Date.now() / 1000);
      const submissionDeadline = BigInt(now + Math.trunc(winHrs * 3600));
      const classId64 = BigInt(classId);
      const thresh8 = BigInt(thrNum);
      const valueWei = ethers.parseEther(ethStr);

      // Validate ranges
      const mask64 = (1n << 64n) - 1n;
      const mask8 = (1n << 8n) - 1n;
      if ((classId64 & ~mask64) !== 0n) throw new Error('classId exceeds uint64');
      if ((thresh8 & ~mask8) !== 0n) throw new Error('threshold exceeds uint8');

      console.log('🔍 createBounty params', {
        evaluationCid: evaluationCid.substring(0, 20) + '...',
        classId64: classId64.toString(),
        threshold8: thresh8.toString(),
        submissionDeadline: submissionDeadline.toString(),
        valueWei: valueWei.toString()
      });

      // Dry-run to surface revert reasons
      try {
        await this.contract.createBounty.staticCall(
          evaluationCid,
          classId64,
          thresh8,
          submissionDeadline,
          { value: valueWei }
        );
      } catch (e) {
        const msg = (e?.shortMessage || e?.message || '').toLowerCase();
        if (msg.includes('no eth')) throw new Error('Bounty requires ETH value (msg.value > 0)');
        if (msg.includes('empty evaluationcid')) throw new Error('Evaluation CID is empty');
        if (msg.includes('bad threshold')) throw new Error('Threshold must be 0..100');
        if (msg.includes('deadline in past')) throw new Error('Deadline must be in the future');
        throw e;
      }

      // Send the tx
      const tx = await this.contract.createBounty(
        evaluationCid,
        classId64,
        thresh8,
        submissionDeadline,
        { value: valueWei }
      );
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Transaction confirmed:', receipt.hash);

      // Parse bountyId from event
      let bountyId = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === 'BountyCreated') {
            bountyId = Number(parsed.args.bountyId);
            break;
          }
        } catch {}
      }

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        bountyId,
        gasUsed: receipt.gasUsed?.toString?.() ?? null
      };

    } catch (error) {
      console.error('Error creating bounty:', error);
      if (error.code === 'ACTION_REJECTED') throw new Error('Transaction rejected by user');
      throw error;
    }
  }

  /**
   * STEP 1: Prepare a submission (deploys EvaluationWallet)
   */
  async prepareSubmission(bountyId, evaluationCid, hunterCid, addendum = "", alpha = 75,
                          maxOracleFee = "50000000000000000",
                          estimatedBaseCost = "30000000000000000",
                          maxFeeBasedScaling = "20000000000000000") {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Preparing submission...', {
        bountyId,
        evaluationCid: evaluationCid?.substring(0, 20) + '...',
        hunterCid: hunterCid?.substring(0, 20) + '...'
      });

      const tx = await this.contract.prepareSubmission(
        bountyId,
        evaluationCid,
        hunterCid,
        addendum,
        alpha,
        maxOracleFee,
        estimatedBaseCost,
        maxFeeBasedScaling
      );

      console.log('📤 Transaction sent:', tx.hash);
      const receipt = await tx.wait();
      console.log('✅ Submission prepared:', receipt.hash);

      // Parse SubmissionPrepared event
      let result = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === 'SubmissionPrepared') {
            result = {
              submissionId: Number(parsed.args.submissionId),
              evalWallet: parsed.args.evalWallet,
              linkMaxBudget: parsed.args.linkMaxBudget.toString(),
              txHash: receipt.hash
            };
            break;
          }
        } catch {}
      }

      if (!result) {
        throw new Error('Could not parse SubmissionPrepared event from transaction');
      }

      return result;

    } catch (error) {
      console.error('Error preparing submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  /**
   * STEP 2: Approve LINK tokens to the EvaluationWallet
   */
  async approveLink(evalWallet, linkAmount) {
    if (!this.signer) {
      throw new Error('Signer not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Approving LINK to EvaluationWallet...', {
        spender: evalWallet,
        linkAmount: ethers.formatUnits(linkAmount, 18) + ' LINK'
      });

      // Use signer for write operation
      const linkContract = this.getLinkContract(this.signer);
      const tx = await linkContract.approve(evalWallet, linkAmount);

      console.log('📤 LINK approval transaction sent:', tx.hash);
      const receipt = await tx.wait();
      console.log('✅ LINK approved:', receipt.hash);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error approving LINK:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('LINK approval rejected by user');
      }
      throw error;
    }
  }

  /**
   * STEP 3: Start the prepared submission (triggers Verdikta evaluation)
   */
  async startPreparedSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Starting submission evaluation...', { bountyId, submissionId });

      const tx = await this.contract.startPreparedSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Evaluation started:', receipt.hash);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error starting submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  /**
   * Finalize a submission - reads results from Verdikta
   */
  async finalizeSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Finalizing submission...', { bountyId, submissionId });

      const tx = await this.contract.finalizeSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Submission finalized:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error finalizing submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  /**
   * Force-fail a timed-out submission
   */
  async failTimedOutSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('⏱️ Failing timed-out submission...', { bountyId, submissionId });

      const tx = await this.contract.failTimedOutSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Submission failed:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error failing timed-out submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  /**
   * Close an expired bounty and return funds to creator
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

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

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

      const msg = (error?.message || '').toLowerCase();
      if (msg.includes('not open')) {
        throw new Error('Bounty is not open - it may already be closed or awarded');
      }
      if (msg.includes('deadline not passed')) {
        throw new Error('Cannot close yet - deadline has not passed');
      }
      if (msg.includes('active evaluation')) {
        throw new Error('Cannot close - active evaluations in progress. Finalize them first.');
      }

      throw error;
    }
  }

  // ==========================================================================
  // READ OPERATIONS (OPTIMIZED with caching)
  // ==========================================================================

  /**
   * Get the effective status of a bounty (CACHED)
   * Uses debouncing and short-term cache to avoid hammering MetaMask
   */
  async getBountyStatus(bountyId) {
    const cacheKey = `${bountyId}`;
    const cached = this._statusCache.get(cacheKey);
    
    // Return cached value if still valid
    if (cached && (Date.now() - cached.timestamp) < this._statusCacheTTL) {
      return cached.status;
    }

    // Debounce identical requests
    return debounceRpcCall(`status-${bountyId}`, async () => {
      const provider = this.getReadOnlyProvider();
      if (!provider) {
        throw new Error('Provider not initialized. Call connect() first.');
      }

      try {
        const contract = new ethers.Contract(
          this.contractAddress,
          ["function getEffectiveBountyStatus(uint256) view returns (string)"],
          provider
        );

        const status = await contract.getEffectiveBountyStatus(bountyId);

        // Cache the result
        this._statusCache.set(cacheKey, { status, timestamp: Date.now() });

        return status;

      } catch (error) {
        console.error('Error getting bounty status:', error);
        const msg = (error?.message || '').toLowerCase();
        if (msg.includes('bad bountyid')) {
          throw new Error(`Bounty #${bountyId} does not exist on-chain`);
        }
        throw error;
      }
    });
  }

  /**
   * Get submission details (debounced)
   */
  async getSubmission(bountyId, submissionId) {
    return debounceRpcCall(`submission-${bountyId}-${submissionId}`, async () => {
      const provider = this.getReadOnlyProvider();
      if (!provider) {
        throw new Error('Provider not initialized. Call connect() first.');
      }

      try {
        const contract = new ethers.Contract(
          this.contractAddress,
          BOUNTY_ESCROW_ABI,
          provider
        );

        const sub = await contract.getSubmission(bountyId, submissionId);
        
        const statusMap = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];

        return {
          hunter: sub.hunter,
          evalWallet: sub.evalWallet,
          verdiktaAggId: sub.verdiktaAggId,
          status: statusMap[sub.status] || 'UNKNOWN',
          statusCode: sub.status,
          submittedAt: Number(sub.submittedAt),
          acceptance: Number(sub.acceptance),
          rejection: Number(sub.rejection)
        };

      } catch (error) {
        console.error('Error getting submission:', error);
        throw error;
      }
    });
  }

  /**
   * Check if Verdikta evaluation results are ready for a submission
   * Polls the VerdiktaAggregator contract directly
   * Returns: { ready: boolean, scores?: { acceptance, rejection }, justificationCids?: string[] }
   */
  async checkEvaluationReady(bountyId, submissionId) {
    // Try to get a provider - prefer MetaMask but fall back to public RPC
    let provider = this.getReadOnlyProvider();
    
    if (!provider) {
      console.log('⚠️ No MetaMask provider, trying public RPC...');
      try {
        provider = new ethers.JsonRpcProvider(currentNetwork.rpcUrl);
      } catch (e) {
        console.warn('⚠️ checkEvaluationReady: Could not create provider');
        return { ready: false, error: 'No provider available' };
      }
    }

    try {
      // Use the CORRECT 17-field Submission struct ABI (matches actual BountyEscrow.sol)
      const submissionAbi = [
        'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))'
      ];

      const tempContract = new ethers.Contract(this.contractAddress, submissionAbi, provider);
      const submission = await tempContract.getSubmission(bountyId, submissionId);

      // Extract fields - indices match the 17-field struct
      const verdiktaAggId = submission.verdiktaAggId || submission[4];
      const statusCode = Number(submission.status ?? submission[5]);

      // Status codes: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
      if (statusCode !== 0 && statusCode !== 1) {
        return { ready: false };
      }

      // Check if aggId is zero (not yet assigned)
      const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (!verdiktaAggId || verdiktaAggId === zeroBytes32) {
        return { ready: false };
      }

      // Get VerdiktaAggregator address
      const verdiktaSelector = ethers.id('verdikta()').slice(0, 10);
      const verdiktaResult = await provider.call({
        to: this.contractAddress,
        data: verdiktaSelector
      });
      const verdiktaAddr = '0x' + verdiktaResult.slice(26);

      // VerdiktaAggregator ABI for getEvaluation - use bytes32 (not uint256!)
      // The function selector for getEvaluation(bytes32) is different from getEvaluation(uint256)
      // Return type is: (uint256[] memory, string memory, bool) - note string not string[]
      const verdiktaAbi = [
        'function getEvaluation(bytes32 aggId) view returns (uint256[] memory scores, string justificationCids, bool ok)'
      ];
      
      // Use a public RPC provider for more reliable read calls (avoids MetaMask caching/throttling issues)
      let readProvider;
      try {
        readProvider = new ethers.JsonRpcProvider(currentNetwork.rpcUrl);
      } catch (e) {
        console.log('⚠️ Public RPC failed, falling back to MetaMask provider');
        readProvider = provider;
      }
      
      const verdikta = new ethers.Contract(verdiktaAddr, verdiktaAbi, readProvider);
      
      let scores, justCids, ok;
      try {
        [scores, justCids, ok] = await verdikta.getEvaluation(verdiktaAggId);
      } catch (evalError) {
        // CALL_EXCEPTION is expected when evaluation data doesn't exist yet
        if (evalError.code === 'CALL_EXCEPTION') {
          return { ready: false };
        }
        throw evalError;
      }

      if (!ok || !scores || scores.length < 2) {
        return { ready: false };
      }

      // Scores are in format: [rejection, acceptance] with 6 decimal precision (0-1000000)
      const rejectionScore = Number(scores[0]) / 10000;
      const acceptanceScore = Number(scores[1]) / 10000;

      console.log(`✅ Evaluation ready: acceptance=${acceptanceScore.toFixed(1)}%, rejection=${rejectionScore.toFixed(1)}%`);

      return {
        ready: true,
        scores: {
          rejection: rejectionScore,
          acceptance: acceptanceScore
        },
        justificationCids: justCids || []
      };

    } catch (error) {
      // Log more details about the error
      console.error(`❌ checkEvaluationReady error for bounty ${bountyId}, submission ${submissionId}:`, {
        message: error.message,
        code: error.code,
        reason: error.reason
      });
      return { ready: false, error: error.message };
    }
  }

  // ==========================================================================
  // ALLOWANCE VERIFICATION (OPTIMIZED)
  // ==========================================================================

  /**
   * Verify LINK allowance is visible on-chain before proceeding
   * OPTIMIZED: Uses cached LINK contract, exponential backoff
   */
  async verifyAllowanceOnChain(ownerAddress, spenderAddress, requiredAmount, maxAttempts = 12, initialIntervalMs = 500) {
    const linkContract = this.getLinkContract();
    if (!linkContract) {
      throw new Error('Could not initialize LINK contract');
    }

    const requiredBigInt = BigInt(requiredAmount);
    let intervalMs = initialIntervalMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const currentAllowance = await linkContract.allowance(ownerAddress, spenderAddress);
        
        if (BigInt(currentAllowance) >= requiredBigInt) {
          console.log('✅ Allowance verified on-chain');
          return true;
        }
      } catch (err) {
        // Silently retry
      }

      // Exponential backoff: 500ms, 750ms, 1125ms, 1687ms, etc.
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        intervalMs = Math.min(intervalMs * 1.5, 3000); // Cap at 3 seconds
      }
    }

    return false;
  }

  /**
   * Check LINK balance (debounced)
   */
  async getLinkBalance(address) {
    return debounceRpcCall(`link-balance-${address}`, async () => {
      const linkContract = this.getLinkContract();
      if (!linkContract) {
        throw new Error('Could not initialize LINK contract');
      }

      const balance = await linkContract.balanceOf(address);
      return {
        raw: balance.toString(),
        formatted: ethers.formatUnits(balance, 18)
      };
    });
  }

  // ==========================================================================
  // CONNECTION STATE
  // ==========================================================================

  isConnected() {
    return this.contract !== null && this.userAddress !== null;
  }

  getAddress() {
    return this.userAddress;
  }

  async getNetwork() {
    if (!this.provider) return null;
    return await this.provider.getNetwork();
  }

  /**
   * Clear all caches (useful after transactions)
   */
  clearCache() {
    this._statusCache.clear();
    pendingCalls.clear();
  }

  /**
   * Listen for account changes
   */
  onAccountChange(callback) {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', async (accounts) => {
        // Clear caches on account change
        this.clearCache();
        
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
        // Clear caches on network change
        this.clearCache();
        callback(chainId);
        window.location.reload();
      });
    }
  }

  /**
   * Disconnect and clear all state
   */
  disconnect() {
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
    this._linkContract = null;
    this._readOnlyProvider = null;
    this.clearCache();
  }
}

// ============================================================================
// HELPER FUNCTIONS (OPTIMIZED - use singleton provider)
// ============================================================================

/**
 * Get or create a shared BrowserProvider instance
 */
let sharedProvider = null;
function getSharedProvider() {
  if (!sharedProvider && window.ethereum) {
    sharedProvider = new ethers.BrowserProvider(window.ethereum);
  }
  return sharedProvider;
}

/**
 * Derive bountyId from a known tx hash by parsing the event
 */
export async function deriveBountyIdFromTx(txHash, escrowAddress) {
  if (!window.ethereum) throw new Error('Wallet not available');
  
  const provider = getSharedProvider();
  const iface = new ethers.Interface([
    "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
  ]);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt?.logs?.length) throw new Error('No logs in receipt');

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "BountyCreated") {
        return Number(parsed.args.bountyId);
      }
    } catch { /* non-matching log */ }
  }
  throw new Error('BountyCreated not found in tx logs');
}

/**
 * Resolve on-chain bountyId by reading contract state
 * OPTIMIZED: Uses shared provider
 */
export async function resolveBountyIdByStateLoose({
  escrowAddress,
  creator,
  evaluationCid,
  submissionDeadline,
  deadlineToleranceSec = 300,
  lookback = 1000
}) {
  if (!window.ethereum) throw new Error("Wallet not available");
  
  const provider = getSharedProvider();
  const abi = [
    "function bountyCount() view returns (uint256)",
    "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
  ];

  const c = new ethers.Contract(escrowAddress, abi, provider);
  const total = Number(await c.bountyCount());
  if (total === 0) throw new Error("No bounties on chain yet");

  const start = Math.max(0, total - 1);
  const stop = Math.max(0, total - 1 - Math.max(1, lookback));

  const wantCreator = (creator || "").toLowerCase();
  const wantCid = evaluationCid || "";
  const wantDeadline = Number(submissionDeadline || 0);

  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let i = start; i >= stop; i--) {
    const b = await c.getBounty(i);
    const bCreator = (b[0] || "").toLowerCase();
    if (bCreator !== wantCreator) continue;

    const bCid = b[1] || "";
    const bDeadline = Number(b[6] || 0);
    const delta = Math.abs(bDeadline - wantDeadline);

    const cidOk = !wantCid || wantCid === bCid;
    const deadlineOk = delta <= deadlineToleranceSec;

    if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) {
      best = i;
      bestDelta = delta;
      if (cidOk && delta === 0) break;
    }
  }

  if (best != null) return best;
  throw new Error("No matching bounty found with loose state match");
}

export async function resolveBountyIdByState(args) {
  return resolveBountyIdByStateLoose(args);
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

let contractService = null;

// Default contract address from config (supports both networks)
const DEFAULT_CONTRACT_ADDRESS = config.bountyEscrowAddress;

export function initializeContractService(contractAddress) {
  contractService = new ContractService(contractAddress);
  return contractService;
}

export function getContractService() {
  // Auto-initialize with default address if not already initialized
  if (!contractService) {
    console.warn('⚠️ Contract service was not initialized, auto-initializing with default address');
    contractService = new ContractService(DEFAULT_CONTRACT_ADDRESS);
  }
  return contractService;
}

export default ContractService;

