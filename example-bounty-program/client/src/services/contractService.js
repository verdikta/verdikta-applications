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
 *
 * Bounty Status System:
 * - OPEN: Active, accepting submissions
 * - EXPIRED: Deadline passed, awaiting closeExpiredBounty()
 * - AWARDED: Winner paid
 * - CLOSED: Funds returned to creator
 */

import { ethers } from 'ethers';

// Base Sepolia LINK token address
const LINK_ADDRESS = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";

// BountyEscrow ABI - only the functions we need to call
const BOUNTY_ESCROW_ABI = [
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string rubricCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 linkMaxBudget)",

  "function createBounty(string rubricCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)",
  // prepareSubmission takes evaluationCid (evaluation package) and hunterCid (work product)
  "function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) returns (uint256, address, uint256)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId)",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)",
  "function closeExpiredBounty(uint256 bountyId)",
  // NOTE: No read functions! Frontend reads from backend API for cached data
  // NOTE: No cancelBounty - only closeExpiredBounty after deadline passes
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
   * @param {number|bigint} params.classId - Verdikta class ID (uint64)
   * @param {number|bigint} params.threshold - Passing threshold (0-100, uint8)
   * @param {number|string} params.bountyAmountEth - Bounty amount in ETH
   * @param {number} params.submissionWindowHours - Hours until deadline
   * @returns {Promise<Object>} Transaction result with bountyId
   */

  async createBounty({ rubricCid, classId, threshold, bountyAmountEth, submissionWindowHours }) {
    if (!this.contract) throw new Error('Contract not initialized. Call connect() first.');

    // Quick UI validations
    if (!rubricCid || typeof rubricCid !== 'string') throw new Error('Rubric CID is empty');
    const winHrs = Number(submissionWindowHours);
    if (!Number.isFinite(winHrs) || winHrs <= 0) throw new Error('Submission window (hours) must be > 0');
    const thrNum = Number(threshold);
    if (!Number.isFinite(thrNum) || thrNum < 0 || thrNum > 100) throw new Error('Threshold must be 0..100');
    const ethStr = String(bountyAmountEth);
    if (isNaN(Number(ethStr)) || Number(ethStr) <= 0) throw new Error('Payout amount (ETH) must be > 0');

    try {
      // Encode exact solidity widths
      const now = Math.floor(Date.now() / 1000);
      const submissionDeadline = BigInt(now + Math.trunc(winHrs * 3600)); // uint64
      const classId64  = BigInt(classId);                                 // uint64
      const thresh8    = BigInt(thrNum);                                   // uint8
      const valueWei   = ethers.parseEther(ethStr);

      // Optional clamps
      const mask64 = (1n << 64n) - 1n;
      const mask8  = (1n << 8n)  - 1n;
      if ((classId64 & ~mask64) !== 0n) throw new Error('classId exceeds uint64');
      if ((thresh8   & ~mask8)  !== 0n) throw new Error('threshold exceeds uint8');

      console.log('🔍 createBounty params', {
        rubricCid,
        rubricCidLength: rubricCid.length,
        classId64: classId64.toString(),
        threshold8: thresh8.toString(),
        submissionDeadline: submissionDeadline.toString(),
        deadlineISO: new Date(Number(submissionDeadline) * 1000).toISOString(),
        valueWei: valueWei.toString(),
        contract: this.contractAddress
      });

      // 1) Dry-run (surfaces real revert reasons)
      try {
        await this.contract.createBounty.staticCall(
          rubricCid,
          classId64,
          thresh8,
          submissionDeadline,
          { value: valueWei }
        );
      } catch (e) {
        const msg = (e?.shortMessage || e?.message || '').toLowerCase();
        if (msg.includes('no eth'))           throw new Error('Bounty requires ETH value (msg.value > 0)');
        if (msg.includes('empty rubric'))     throw new Error('Rubric CID is empty');
        if (msg.includes('bad threshold'))    throw new Error('Threshold must be 0..100');
        if (msg.includes('deadline in past')) throw new Error('Deadline must be in the future');
        throw e;
      }

      // 2) Send the tx
      const tx = await this.contract.createBounty(
        rubricCid,
        classId64,
        thresh8,
        submissionDeadline,
        { value: valueWei }
      );
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Transaction confirmed:', receipt.hash);

      // 3) Parse bountyId from the event
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

      const msg = (error?.shortMessage || error?.message || '').toLowerCase();
      if (msg.includes('missing revert data') || msg.includes('call exception')) {
        throw new Error(
          'Transaction simulation failed. Possible causes: ' +
          '1) wrong network/contract address, ' +
          '2) invalid inputs (empty CID / deadline in past / threshold out of range), or ' +
          '3) zero ETH value. Check the debug log above.'
        );
      }
      throw error;
    }
  }

  /**
   * STEP 1: Prepare a submission (deploys EvaluationWallet)
   *
   * @param {number} bountyId - The bounty ID
   * @param {string} evaluationCid - IPFS CID of the evaluation package (contains jury config, rubric ref, instructions)
   * @param {string} hunterCid - IPFS CID of the hunter's work product archive (bCID)
   * @param {string} addendum - Additional context for AI evaluators
   * @param {number} alpha - Reputation weight (0-100, default 75)
   * @param {string} maxOracleFee - Max fee per oracle in wei (e.g. "50000000000000000" = 0.05 LINK)
   * @param {string} estimatedBaseCost - Estimated base cost in wei
   * @param {string} maxFeeBasedScaling - Max fee-based scaling in wei
   * @returns {Promise<Object>} { submissionId, evalWallet, linkMaxBudget }
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
        evaluationCid,
        hunterCid,
        addendum: addendum.substring(0, 50) + '...',
        alpha,
        maxOracleFee
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

      // Parse SubmissionPrepared event to get submissionId, evalWallet, linkMaxBudget
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

      const msg = (error?.message || '').toLowerCase();
      if (msg.includes('not open')) {
        throw new Error('Bounty is not open for submissions');
      }
      if (msg.includes('deadline passed')) {
        throw new Error('Submission deadline has passed');
      }
      if (msg.includes('empty deliverable')) {
        throw new Error('Deliverable CID cannot be empty');
      }

      throw error;
    }
  }

  /**
   * STEP 2: Approve LINK tokens to the EvaluationWallet
   * The EvaluationWallet needs approval because it calls transferFrom() on hunter's LINK
   *
   * @param {string} evalWallet - Address of the EvaluationWallet to approve
   * @param {string} linkAmount - Amount of LINK in wei to approve
   * @returns {Promise<Object>} Transaction result
   */
  async approveLink(evalWallet, linkAmount) {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call connect() first.');
    }

    const LINK_ABI = [
      "function approve(address spender, uint256 amount) returns (bool)"
    ];

    try {
      console.log('🔍 Approving LINK to EvaluationWallet...', {
        spender: evalWallet,
        linkAmount,
        linkAddress: LINK_ADDRESS
      });

      const linkContract = new ethers.Contract(LINK_ADDRESS, LINK_ABI, this.signer);
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
   *
   * @param {number} bountyId - The bounty ID
   * @param {number} submissionId - The submission ID from prepareSubmission
   * @returns {Promise<Object>} Transaction result
   */
  async startPreparedSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Starting submission evaluation...', {
        bountyId,
        submissionId
      });

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

      const msg = (error?.message || '').toLowerCase();
      if (msg.includes('not prepared')) {
        throw new Error('Submission not in Prepared state');
      }
      if (msg.includes('link transfer failed')) {
        throw new Error('Failed to transfer LINK. Ensure you have approved sufficient LINK to the EvaluationWallet.');
      }

      throw error;
    }
  }

  /**
   * Finalize a timed-out or completed submission
   * This reads results from Verdikta and updates submission status
   * If evaluation timed out, it will attempt to finalize on Verdikta first
   *
   * @param {number} bountyId - The bounty ID
   * @param {number} submissionId - The submission ID to finalize
   * @returns {Promise<Object>} Transaction result
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

      const msg = (error?.message || '').toLowerCase();

      if (msg.includes('not pending')) {
        throw new Error('Submission is not in PendingVerdikta state');
      }
      if (msg.includes('verdikta not ready')) {
        throw new Error('Verdikta evaluation not ready yet - wait longer or oracle may have failed');
      }

      throw error;
    }
  }

  /**
   * Force-fail a submission that's been stuck in evaluation for >20 minutes
   * Useful when Verdikta oracle fails or evaluation never starts
   *
   * @param {number} bountyId - The bounty ID
   * @param {number} submissionId - The submission ID to fail
   * @returns {Promise<Object>} Transaction result
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

      const msg = (error?.message || '').toLowerCase();

      if (msg.includes('not pending')) {
        throw new Error('Submission is not in PendingVerdikta state');
      }
      if (msg.includes('timeout not reached')) {
        throw new Error('Must wait 20 minutes before force-failing submission');
      }

      throw error;
    }
  }

  /**
   * Close an expired bounty and return funds to creator
   * Can be called by ANYONE after submission deadline passes
   *
   * Requirements:
   * - Bounty status must be Open (shows as EXPIRED in frontend)
   * - Deadline must have passed
   * - No active evaluations (PendingVerdikta submissions)
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

  /**
   * Get the effective status of a bounty (OPEN, EXPIRED, AWARDED, or CLOSED)
   *
   * @param {number} bountyId - The bounty ID to check
   * @returns {Promise<string>} The bounty status
   */
  async getBountyStatus(bountyId) {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call connect() first.');
    }

    try {
      const viewAbi = [
        "function getEffectiveBountyStatus(uint256) view returns (string)"
      ];

      const contract = new ethers.Contract(
        this.contractAddress,
        viewAbi,
        this.provider
      );

      const status = await contract.getEffectiveBountyStatus(bountyId);

      console.log(`Bounty #${bountyId} effective status:`, status);

      return status; // Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"

    } catch (error) {
      console.error('Error getting bounty status:', error);

      const msg = (error?.message || '').toLowerCase();
      if (msg.includes('bad bountyid')) {
        throw new Error(`Bounty #${bountyId} does not exist on-chain`);
      }

      throw error;
    }
  }

  /**
   * Get submission details from contract
   * 
   * @param {number} bountyId - The bounty ID
   * @param {number} submissionId - The submission ID
   * @returns {Promise<Object>} Submission details including status
   */
  async getSubmission(bountyId, submissionId) {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call connect() first.');
    }

    try {
      const viewAbi = [
        "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))"
      ];

      const contract = new ethers.Contract(
        this.contractAddress,
        viewAbi,
        this.provider
      );

      const sub = await contract.getSubmission(bountyId, submissionId);
      
      // Status enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
      const statusMap = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];

      return {
        hunter: sub.hunter,
        evaluationCid: sub.evaluationCid,
        hunterCid: sub.hunterCid,
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

// --- helper: derive bountyId from a known tx hash by parsing the event ---
export async function deriveBountyIdFromTx(txHash, escrowAddress) {
  if (!window.ethereum) throw new Error('Wallet not available');
  const provider = new ethers.BrowserProvider(window.ethereum);

  const iface = new ethers.Interface([
    "event BountyCreated(uint256 indexed bountyId, address indexed creator, string rubricCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
  ]);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt?.logs?.length) throw new Error('No logs in receipt');

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "BountyCreated") {
        // bigint -> number (safe for your small ids)
        return Number(parsed.args.bountyId);
      }
    } catch { /* non-matching log */ }
  }
  throw new Error('BountyCreated not found in tx logs');
}


/**
 * Resolve on-chain bountyId by reading contract state (no log scan).
 * Looser match: creator + deadline within tolerance, prefer matching CID.
 */
export async function resolveBountyIdByStateLoose({
  escrowAddress,
  creator,
  rubricCid,
  submissionDeadline,
  deadlineToleranceSec = 300, // ±5 minutes default
  lookback = 1000
}) {
  if (!window.ethereum) throw new Error("Wallet not available");
  const provider = new ethers.BrowserProvider(window.ethereum);

  const abi = [
    "function bountyCount() view returns (uint256)",
    "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
  ];

  const c = new ethers.Contract(escrowAddress, abi, provider);
  const total = Number(await c.bountyCount());
  if (total === 0) throw new Error("No bounties on chain yet");

  const start = Math.max(0, total - 1);
  const stop  = Math.max(0, total - 1 - Math.max(1, lookback));

  const wantCreator  = (creator || "").toLowerCase();
  const wantCid      = rubricCid || "";
  const wantDeadline = Number(submissionDeadline || 0);

  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let i = start; i >= stop; i--) {
    const b = await c.getBounty(i);
    const bCreator  = (b[0] || "").toLowerCase();
    if (bCreator !== wantCreator) continue;

    const bCid      = b[1] || "";
    const bDeadline = Number(b[6] || 0);
    const delta     = Math.abs(bDeadline - wantDeadline);

    const cidOk      = !wantCid || wantCid === bCid;
    const deadlineOk = delta <= deadlineToleranceSec;

    // Choose the "best" match: exact CID + in-tolerance deadline beats others;
    // otherwise pick the closest delta we've seen so far.
    if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) {
      best = i;
      bestDelta = delta;
      if (cidOk && delta === 0) break; // perfect match — stop early
    }
  }

  if (best != null) return best;
  throw new Error("No matching bounty found with loose state match");
}

// Keep a strict alias for older callers (optional)
export async function resolveBountyIdByState(args) {
  return resolveBountyIdByStateLoose(args);
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

