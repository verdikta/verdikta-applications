/* global BigInt */
// src/pages/RunQuery.js
import React, { useState, useEffect, useCallback } from 'react';
import { selectInjectedProvider } from '../utils/injectedProvider';
// Import ethers from ethers v6 (we no longer import BigNumber)
import { ethers, parseUnits } from 'ethers';
import { getNetworkConfig } from '../utils/contractUtils';
import { PAGES } from '../App';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';
import { createQueryPackageArchive } from '../utils/packageUtils';
import { uploadToServer } from '../utils/serverUtils';
import { getAugmentedQueryText } from '../utils/queryUtils';
import {
  CONTRACT_ABI,
  ensureCorrectNetwork,
} from '../utils/contractUtils';
import { modelProviderService } from '../services/modelProviderService';
import { waitForFulfilOrTimeout, closeTimedOutRound } from '../utils/timeoutUtils';
import TimeoutNotice from '../components/TimeoutNotice';
import { ContractDebugger } from '../utils/contractDebugger';

// Default query package CID for example/testing
const DEFAULT_QUERY_CID = 'QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH';

// Helper function to get the first CID from a comma-separated list
const getFirstCid = (cidString) => {
  if (!cidString) return '';
  return cidString.split(',')[0].trim();
};

/**
 * Pick the best provider for read‑only calls:
 * 1 → MetaMask if installed
 * 2 → any other injected provider
 * 3 → fallback to public RPC
 */
function getReadOnlyProvider(networkKey = 'base_sepolia') {
  // 1./2. injected wallet (EIP-6963 first, MetaMask preferred; Brave Wallet
  //       is skipped because its provider does not serve reads reliably)
  const injected = selectInjectedProvider();
  if (injected && !injected.isBraveWallet) return new ethers.BrowserProvider(injected);

  // 3. no wallet at all – use public RPC for selected network
  const networkConfig = getNetworkConfig(networkKey);
  return new ethers.JsonRpcProvider(networkConfig.rpcUrl);

}

/**
 * A signer-bound aggregator, on the selected network, for transactions the user's wallet
 * must send. Built when it is needed: the wallet may have changed network or account
 * during the minutes a query runs.
 */
async function getSignerContract(networkKey, address) {
  const ethereum = selectInjectedProvider();
  if (!ethereum) throw new Error('No Ethereum wallet detected. Please install MetaMask.');
  let provider = new ethers.BrowserProvider(ethereum);
  provider = await ensureCorrectNetwork(provider, networkKey);
  const signer = await provider.getSigner();
  return new ethers.Contract(address, CONTRACT_ABI, signer);
}

/**
 * Read the round once. When it holds a result, push it into the page state, load the
 * justification and return true; otherwise return false. How long and how often this is
 * called is decided by waitForFulfilOrTimeout() from the aggregator's own timeout.
 */
async function loadEvaluationIfReady(
  contract,
  requestId,
  { setTransactionStatus, setOutcomes, setJustification, setResultCid, setResultTimestamp, setOutcomeLabels }
) {
  const [likelihoods, justificationCid, exists] = await contract.getEvaluation(requestId);
  if (!exists || !likelihoods?.length) return false;

  console.log('✅ Found evaluation results!');
  setOutcomes?.(likelihoods.map(Number));
  setResultCid?.(justificationCid);
  if (!justificationCid) {
    setJustification?.('The round completed without a justification.');
    return true;
  }
  setJustification?.('Loading justification...');
  setTransactionStatus?.('Fetching justification from server...');
  try {
    const response = await fetchWithRetry(justificationCid);
    const justificationText = await tryParseJustification(
      response,
      justificationCid,
      setOutcomes,
      setResultTimestamp,
      setOutcomeLabels
    );
    setJustification?.(justificationText);
  } catch (error) {
    console.error('Justification fetch error:', error);
    setJustification?.(`Error loading justification: ${error.message}`);
  }
  return true;
}

/**
 * Compute the ETH (wei) the caller must attach to a request, given the contract's
 * worst-case requirement and the caller's existing on-chain ethOwed credit.
 *
 * The ETH-funded ReputationAggregator funds a round from the caller's existing
 * ethOwed credit FIRST, then requires msg.value to cover the remaining shortfall.
 * So value = max(0, required - credit). Mirrors _fundFromCredit() on-chain.
 *
 * @param {ethers.Contract} readContract - aggregator bound to a read provider
 * @param {bigint} maxFee   - per-oracle max fee (ETH wei) passed to the request
 * @param {string} owner    - the requester address (msg.sender)
 * @returns {Promise<{required: bigint, credit: bigint, value: bigint}>}
 */
async function computeEthFunding(readContract, maxFee, owner) {
  const required = await readContract.maxTotalFee(maxFee); // worst case, ETH wei
  let credit = 0n;
  try {
    credit = await readContract.ethOwed(owner);
  } catch (e) {
    // ethOwed is a simple mapping getter; a failure here just means "assume no credit".
    console.warn('Could not read ethOwed credit; assuming 0:', e?.message || e);
  }
  const value = required > credit ? required - credit : 0n;
  return { required, credit, value };
}

function RunQuery({
  queryText,
  outcomeLabels,
  supportingFiles,
  ipfsCids,
  juryNodes,
  iterations,
  selectedMethod,
  setSelectedMethod,
  queryPackageFile,
  setQueryPackageFile,
  queryPackageCid,
  setQueryPackageCid,
  isConnected,
  setIsConnected,
  walletAddress,
  setWalletAddress,
  contractAddress,
  transactionStatus,
  setTransactionStatus,
  // What happened to a round that got no result in time (see TimeoutNotice). App state.
  timeoutInfo,
  setTimeoutInfo,
  loadingResults,
  setLoadingResults,
  uploadProgress,
  setUploadProgress,
  setCurrentCid,
  setPackageDetails,
  setResultCid,
  setJustification,
  setOutcomes,
  setResultTimestamp,
  setCurrentPage,
  hyperlinks,
  setOutcomeLabels,
  // New props for the aggregator parameters (passed from App.js)
  alpha,
  maxFee,
  estimatedBaseCost,
  maxFeeBasedScalingFactor,
  selectedClassId,
  selectedNetwork,
}) {
  const [activeTooltipId, setActiveTooltipId] = useState(null);

  // Debug logging for class ID and network
  useEffect(() => {
    console.log('🏃 RunQuery component - selectedClassId:', selectedClassId);
    console.log('🌐 RunQuery component - selectedNetwork:', selectedNetwork);
  }, [selectedClassId, selectedNetwork]);
  const [textAddendum, setTextAddendum] = useState('');
  // Add state to track if we're showing the default CID value
  const [showingDefaultCid, setShowingDefaultCid] = useState(queryPackageCid === '' || queryPackageCid === undefined);
  // Add state to track errors and enable debug functionality
  const [hasError, setHasError] = useState(false);
  const [lastError, setLastError] = useState(null);

  // Countdown to the aggregator's timeout. It is computed from a deadline, not counted
  // down tick by tick, so it stays right when the browser slows timers in a hidden tab.
  const [waitDeadline, setWaitDeadline] = useState(null); // ms since epoch; null = inactive
  const [secondsLeft, setSecondsLeft] = useState(null);
  useEffect(() => {
    if (waitDeadline === null) {
      setSecondsLeft(null);
      return undefined;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((waitDeadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [waitDeadline]);

  // Second attempt to close a round that got no result (see TimeoutNotice).
  const [closingRound, setClosingRound] = useState(false);
  const [closeStatus, setCloseStatus] = useState('');

  // Update showingDefaultCid when selectedMethod changes to 'ipfs'
  useEffect(() => {
    if (selectedMethod === 'ipfs') {
      setShowingDefaultCid(queryPackageCid === '' || queryPackageCid === undefined);
    }
  }, [selectedMethod, queryPackageCid]);

  // ----- ETH prepay credit (ethOwed) widget -----
  // Unspent prepay from past queries is held on-chain as a withdrawable credit that is
  // also auto-applied to the next query. Surface it so users can see and reclaim it.
  const [ethCredit, setEthCredit] = useState(0n);
  const [withdrawing, setWithdrawing] = useState(false);
  // Worst-case prepay shown in the banner. Default to maxFee * (K + B*P) with the live
  // defaults (K=6, B=3, P=2 => 12); refined to the contract's exact maxTotalFee() below.
  const [maxTotalFeeEstimate, setMaxTotalFeeEstimate] = useState(() => (maxFee || 0n) * 12n);

  const refreshEthCredit = useCallback(async () => {
    if (!isConnected || !walletAddress || !contractAddress) {
      setEthCredit(0n);
      return;
    }
    try {
      const networkToUse = selectedNetwork || 'base_sepolia';
      const roProvider = getReadOnlyProvider(networkToUse);
      // Skip if there is no contract at this address on the selected network.
      if ((await roProvider.getCode(contractAddress)) === '0x') {
        setEthCredit(0n);
        return;
      }
      const readContract = new ethers.Contract(contractAddress, CONTRACT_ABI, roProvider);
      const [owed, worstCase] = await Promise.all([
        readContract.ethOwed(walletAddress),
        readContract.maxTotalFee(maxFee).catch(() => null),
      ]);
      setEthCredit(owed);
      if (worstCase != null) setMaxTotalFeeEstimate(worstCase);
    } catch (err) {
      console.warn('Could not read ETH prepay credit:', err?.message || err);
      setEthCredit(0n);
    }
  }, [isConnected, walletAddress, contractAddress, selectedNetwork, maxFee]);

  useEffect(() => {
    refreshEthCredit();
  }, [refreshEthCredit]);

  const handleWithdrawCredit = async () => {
    try {
      setWithdrawing(true);
      const networkToUse = selectedNetwork || 'base_sepolia';
      const ethereum = selectInjectedProvider();
      if (!ethereum) throw new Error('No Ethereum wallet detected. Please install MetaMask.');
      let provider = new ethers.BrowserProvider(ethereum);
      provider = await ensureCorrectNetwork(provider, networkToUse);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
      const tx = await contract.withdrawEth();
      await tx.wait();
      await refreshEthCredit();
      alert('Prepay credit withdrawn to your wallet.');
    } catch (err) {
      console.error('Withdraw credit error:', err);
      const reason = err?.reason || err?.shortMessage || err?.message || 'Unknown error';
      // NothingOwed simply means the credit was already 0 / withdrawn.
      if (String(reason).includes('NothingOwed')) {
        await refreshEthCredit();
      } else {
        alert(`Failed to withdraw credit: ${reason}`);
      }
    } finally {
      setWithdrawing(false);
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file && (file.type === 'application/zip' || file.name.endsWith('.zip'))) {
      setQueryPackageFile(file);
    } else {
      alert('Please upload a ZIP file');
    }
  };

const debugContractIssues = async () => {
  try {
    console.log('🔍 Running contract diagnostics...');
    
    // Show context about the last error if available
    let errorContext = '';
    if (lastError) {
      errorContext = `\n🚨 Last Error Context:\n${lastError.message}\n\n`;
      console.log('📋 Last Error Details:', lastError);
    }
    
    const provider = new ethers.BrowserProvider(selectInjectedProvider());
    const contractDebugger = new ContractDebugger(provider, contractAddress, walletAddress);
    
    // Get actual parameters from current state
    const currentCid = selectedMethod === 'ipfs' 
      ? (showingDefaultCid ? DEFAULT_QUERY_CID : queryPackageCid.trim())
      : 'QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS';
    
    const report = await contractDebugger.generateDebugReport(
      [getFirstCid(currentCid)], // Use actual CID from current state
      textAddendum.trim(),
      alpha || 500, // Use actual alpha value
      maxFee || parseUnits("0.0001", 18), // Use actual maxFee (ETH)
      estimatedBaseCost || parseUnits("0.000001", 18), // Use actual estimatedBaseCost (ETH)
      maxFeeBasedScalingFactor || 10, // Use actual scaling factor
      selectedClassId || 128
    );
    
    console.log('📋 Full Debug Report:', report);
    
    // Show critical issues to user with error context
    const criticalIssues = report.recommendations.filter(r => r.priority === 'CRITICAL' || r.priority === 'HIGH');
    if (criticalIssues.length > 0) {
      const issueText = criticalIssues.map(issue => `• ${issue.issue}: ${issue.solution}`).join('\n');
      alert(`🚨 Contract Issues Detected:${errorContext}${issueText}\n\nCheck console for full debug report and error details.`);
    } else if (lastError) {
      alert(`🔍 Debug Analysis:${errorContext}✅ No critical contract issues detected.\nThe error may be related to network conditions, gas settings, or transaction timing.\n\nCheck console for full debug report and error details.`);
    } else {
      alert('✅ No critical issues detected. Check console for full report.');
    }
    
  } catch (error) {
    console.error('Debug failed:', error);
    alert(`Debug failed: ${error.message}`);
  }
};

// Second chance to close a round that got no result: the user declined the wallet
// prompt, or the transaction could not be sent.
const handleCloseRound = async () => {
  if (!timeoutInfo || closingRound) return;
  const { requestId, contractAddress: roundContract, networkKey } = timeoutInfo;
  setClosingRound(true);
  setCloseStatus('Checking the round...');
  try {
    const readContract = new ethers.Contract(roundContract, CONTRACT_ABI, getReadOnlyProvider(networkKey));
    const result = await closeTimedOutRound({
      readContract,
      getWriteContract: () => getSignerContract(networkKey, roundContract),
      requestId,
      checkForResult: () => loadEvaluationIfReady(readContract, requestId, {
        setOutcomes,
        setJustification,
        setResultCid,
        setResultTimestamp,
        setOutcomeLabels
      }),
      setTransactionStatus: setCloseStatus
    });
    if (result.status === 'fulfilled') {
      // The round completed after all: show its result.
      setTimeoutInfo(null);
      setCurrentPage(PAGES.RESULTS);
      return;
    }
    setTimeoutInfo((info) => (info ? { ...info, outcome: result } : info));
    if (result.round === 'closed') {
      setJustification?.('No result: the arbiters did not answer in time, and the round was closed.');
    }
  } catch (err) {
    console.error('Close round error:', err);
    setTimeoutInfo((info) => (info ? {
      ...info,
      outcome: {
        status: 'timed-out',
        round: 'open',
        reason: 'check-failed',
        errorMessage: err?.shortMessage || err?.message || String(err)
      }
    } : info));
  } finally {
    setClosingRound(false);
    setCloseStatus('');
    refreshEthCredit();
  }
};

const handleRunQuery = async () => {
  console.log('🚀 handleRunQuery called - isConnected:', isConnected, 'walletAddress:', walletAddress);
  
  if (!isConnected) {
    alert('Please connect your wallet first using the "Connect Wallet" button in the header.');
    return;
  }

  console.log('🔄 Proceeding with query execution...');
  let writeContract;
  try {
    setLoadingResults(true);
    setTransactionStatus('Processing...');
    // Clear any previous errors when starting a new query
    setHasError(false);
    setLastError(null);
    // Drop the notice about an earlier round that is closed; keep one about a round
    // that is still open, so the way to close it stays on the page.
    setTimeoutInfo((info) => (info?.outcome?.round === 'open' ? info : null));

    console.log('🌐 Creating provider and ensuring correct network...');
    console.log('📍 Selected network:', selectedNetwork);

    // Fallback to default if selectedNetwork is undefined
    const networkToUse = selectedNetwork || 'base_sepolia';
    console.log('📍 Using network:', networkToUse);

    // 1) Ensure wallet is on the selected network (base or base_sepolia)
    const ethereum = selectInjectedProvider();
    if (!ethereum) {
      throw new Error('No Ethereum wallet detected. Please install MetaMask.');
    }

    let provider = new ethers.BrowserProvider(ethereum);
    console.log('🔄 Calling ensureCorrectNetwork...');
    provider = await ensureCorrectNetwork(provider, networkToUse);
    console.log('✅ Network check complete');

   // Quick existence check
   const roProvider = getReadOnlyProvider(networkToUse); // uses selected network RPC
   // Verify the selected address actually exists on this chain
   const codeAtAddr = await roProvider.getCode(contractAddress);
   if (codeAtAddr === '0x') {
     const networkName = getNetworkConfig(networkToUse).name;
     setTransactionStatus(`Error: No contract at ${contractAddress} on ${networkName}`);
     alert(`No contract at ${contractAddress} on ${networkName}. Did you pick the right address for this network?`);
     setLoadingResults(false);
     return;
   }

    const signer = await provider.getSigner();
    writeContract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
    const readContract  = new ethers.Contract(
       contractAddress, CONTRACT_ABI, roProvider);

    // 2) (ETH payment) No LINK funding/allowance check is needed: arbiters are paid in
    //    ETH from the requester's escrowed msg.value. The requester's own ETH balance is
    //    verified against the worst-case prepay in step 4 below.

    // Read the on-chain responseTimeoutSeconds so UI stays in sync
    const responseTimeoutSeconds = Number(
      await readContract.responseTimeoutSeconds()
    );

      // 3) Process query package based on selected method (config, file, or IPFS)
      let cid;
      let firstCid; // For fetching package details
      switch (selectedMethod) {
        case 'config': {
          setTransactionStatus?.('Building archive from config...');
          const manifest = {
            version: '1.0',
            primary: { filename: 'primary_query.json' },
            juryParameters: {
              NUMBER_OF_OUTCOMES: outcomeLabels.length,
              AI_NODES: modelProviderService.convertJuryNodesToManifestFormat(juryNodes),
              ITERATIONS: iterations
            }
          };
          
          console.log('📋 Manifest AI_NODES created:', manifest.juryParameters.AI_NODES);
          
          // Check for potentially unsupported providers and warn user
          const providers = manifest.juryParameters.AI_NODES.map(node => node.AI_PROVIDER);
          const uniqueProviders = [...new Set(providers)];
          if (uniqueProviders.includes('ollama')) {
            console.warn('⚠️ Using Ollama provider - ensure AI-node has Ollama support configured');
            setTransactionStatus?.('Warning: Using Ollama models - AI-node must have Ollama configured...');
          }
          
          const augmentedQueryText = getAugmentedQueryText(queryText, hyperlinks);
          const queryFileContent = {
            query: augmentedQueryText,
            references: [
              ...supportingFiles.map((_, i) => `supportingFile${i + 1}`),
              ...ipfsCids.map((c) => c.name)
            ],
            outcomes: outcomeLabels
          };
          setTransactionStatus?.('Creating ZIP package...');
          const archiveBlob = await createQueryPackageArchive(
            queryFileContent,
            supportingFiles,
            ipfsCids,
            manifest
          );
          setTransactionStatus?.('Uploading ZIP to server...');
          cid = await uploadToServer(archiveBlob, setUploadProgress);
          break;
        }
        case 'file': {
          if (!queryPackageFile) {
            throw new Error('No query package file provided');
          }
          setTransactionStatus?.('Uploading file to server...');
          cid = await uploadToServer(queryPackageFile, setUploadProgress);
          break;
        }

        case 'ipfs': {
          // If showing default, use DEFAULT_QUERY_CID, otherwise use the value from queryPackageCid
          cid = showingDefaultCid ? DEFAULT_QUERY_CID : queryPackageCid.trim();
          // Extract the first CID for fetching package details
          firstCid = getFirstCid(cid);
          // Set the first CID for package details display
          setCurrentCid?.(firstCid);
          break;
        }

        default:
          throw new Error(`Invalid method: ${selectedMethod}. Was any method selected?`);
      }

      // If we're using the IPFS method with multiple CIDs, we need to ensure
      // we're using the first CID for display purposes
      if (selectedMethod !== 'ipfs') {
        setCurrentCid?.(cid);
      }

    // 4) Compute the ETH to attach (msg.value). Worst-case prepay is maxTotalFee(maxFee);
    //    any existing ethOwed credit is applied first, and unspent ETH is refunded as a
    //    fresh ethOwed credit after the round settles.
    let ethValue;
    try {
      console.log('💰 Computing ETH funding - walletAddress:', walletAddress);
      if (!walletAddress) {
        throw new Error('Wallet address is not available for funding calculation');
      }

      const { required, credit, value } = await computeEthFunding(readContract, maxFee, walletAddress);
      ethValue = value;
      console.log(
        `ETH funding — required: ${ethers.formatEther(required)} ETH, ` +
        `credit: ${ethers.formatEther(credit)} ETH, attaching: ${ethers.formatEther(value)} ETH`
      );

      // Pre-flight: ensure the wallet can cover the ETH value (gas is on top).
      const walletBalance = await roProvider.getBalance(walletAddress);
      if (walletBalance < ethValue) {
        throw new Error(
          `Insufficient ETH. This query needs ${ethers.formatEther(ethValue)} ETH ` +
          `(worst case ${ethers.formatEther(required)} ETH minus ${ethers.formatEther(credit)} ETH credit), ` +
          `but your wallet holds ${ethers.formatEther(walletBalance)} ETH (plus gas).`
        );
      }

      if (value === 0n) {
        setTransactionStatus?.('Fully covered by your existing prepay credit — no ETH needed beyond gas…');
      } else if (credit > 0n) {
        setTransactionStatus?.(`Applying ${ethers.formatEther(credit)} ETH credit; attaching ${ethers.formatEther(value)} ETH…`);
      }
    } catch (err) {
      console.error('ETH funding error:', err);
      // Set error state for debug functionality
      setHasError(true);
      setLastError(err);
      // Bail out early; the main tx would revert without sufficient value
      setTransactionStatus(`Error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      setLoadingResults(false);
      return;
    }

      // 5) Send the transaction using the new aggregator method

      // Get the provider's fee data before sending the transaction
      const feeData = await provider.getFeeData();

      // get maxPriorityFeePerGas and maxFeePerGas with a fallback method for old nodes and implementations
      const fallbackGasPrice = feeData.gasPrice ? feeData.gasPrice * BigInt(10) : undefined;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas : fallbackGasPrice;
      const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas : fallbackGasPrice;


      // Set your desired multipliers (using whole numbers and then dividing for precision)
      const priorityFeeMultiplier = 110; // 1.1 as an integer (110%)
      const maxFeeMultiplier = 110; // 1.1 as an integer (110%)
      const divider = 100; // Divider to get back to the correct scale

      // Apply multipliers and divide by 1000 to fix the scaling issue
      let adjustedPriorityFee = (maxPriorityFeePerGas * BigInt(priorityFeeMultiplier)) / BigInt(divider) / BigInt(1000);
      let adjustedMaxFee = (maxFeePerGas * BigInt(maxFeeMultiplier)) / BigInt(divider) / BigInt(1000);

      const FLOOR_PRIORITY = parseUnits('0.01', 'gwei');     // minimum tip

      if (adjustedPriorityFee < FLOOR_PRIORITY) adjustedPriorityFee = FLOOR_PRIORITY;
      if (adjustedMaxFee      < adjustedPriorityFee + FLOOR_PRIORITY /* headroom */) {
        adjustedMaxFee = adjustedPriorityFee + FLOOR_PRIORITY;
      }

      // Parse comma-separated CIDs into an array
      const cidArray = cid.split(',').map(c => c.trim()).filter(c => c.length > 0);
      console.log('Sending CIDs to contract:', cidArray);

      // Random delay to ease resource contention in the events of many simultaneous calls or repeated calls
      console.log('⏱️ Calculating random delay - walletAddress:', walletAddress);
      if (!walletAddress) {
        throw new Error('Wallet address is not available for transaction delay calculation');
      }
      
      const addressSeed = parseInt(walletAddress.slice(-4), 16);
      const timeSeed = Math.floor(Date.now() / 600000); // constant over 10-minute windows
      const combinedSeed = (addressSeed + timeSeed) % 1000;
      const randomDelay = (combinedSeed % 200) + 10; // 10-210ms delay
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      setTransactionStatus?.('Sending transaction...');
      const tx = await writeContract.requestAIEvaluationWithApproval(
        cidArray,
	textAddendum.trim(),
        alpha,
        maxFee,
        estimatedBaseCost,
        maxFeeBasedScalingFactor,
	selectedClassId === undefined ? 128 : selectedClassId,
        {
          value: ethValue, // ETH prepay (msg.value); unspent portion refunded as ethOwed credit
          gasLimit: 4500000, // high current gas limit
          maxFeePerGas: adjustedMaxFee,
          maxPriorityFeePerGas: adjustedPriorityFee
        }
      );
      console.log('Transaction sent:', tx);
      setTransactionStatus?.('Waiting for confirmation...');
      const receipt = await tx.wait();
      console.log('Transaction confirmed:', receipt);
      if (!receipt.logs?.length) {
        throw new Error('No logs in transaction receipt');
      }
      // Find the RequestAIEvaluation event in the receipt
      const event = receipt.logs
        .map(log => {
          try {
            return writeContract.interface.parseLog({ topics: log.topics, data: log.data });
          } catch (e) {
            return null;
          }
        })
        .find(parsed => parsed && parsed.name === 'RequestAIEvaluation');
      if (!event) {
        throw new Error('RequestAIEvaluation event not found in transaction receipt');
      }
      const requestId = event.args.requestId;

      /* ----- Count down the aggregator's own timeout (300 s on Base, 900 s on Base Sepolia) ----- */
      setWaitDeadline(Date.now() + responseTimeoutSeconds * 1000);

      const resultSetters = {
        setTransactionStatus,
        setOutcomes,
        setJustification,
        setResultCid,
        setResultTimestamp,
        setOutcomeLabels
      };

      // Poll for as long as the aggregator's timeout. If no result arrives, the user's
      // wallet is asked to send finalizeEvaluationTimeout(), which closes the round and
      // returns the unspent prepayment as prepay credit.
      const result = await waitForFulfilOrTimeout({
        readContract,
        getWriteContract: () => getSignerContract(networkToUse, contractAddress),
        requestId,
        checkForResult: () => loadEvaluationIfReady(readContract, requestId, resultSetters),
        responseTimeoutSeconds,
        setTransactionStatus
      });
      setWaitDeadline(null);

      if (result.status === 'timed-out') {
        console.warn('No result within the timeout:', { requestId, responseTimeoutSeconds, ...result });

        // Clear result state so the Results page cannot show data from an earlier query.
        // The outcome labels are left alone: they are the query's own definition.
        setJustification?.(
          result.round === 'closed'
            ? 'No result: the arbiters did not answer in time, and the round was closed.'
            : 'No result: the arbiters did not answer in time. The round is still open: see the Run Query page.'
        );
        setOutcomes?.([]);
        setResultCid?.('');
        setResultTimestamp?.('');

        // Stay on the Run Query page and say what happened to the round.
        setTimeoutInfo({
          requestId,
          contractAddress,
          networkKey: networkToUse,
          explorerUrl: getNetworkConfig(networkToUse).explorer,
          timeoutSeconds: responseTimeoutSeconds,
          outcome: result
        });
        setTransactionStatus('');

        // Also log to server if possible
        try {
          fetch('/api/log-timeout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `Client-side timeout: round ${result.round}` +
                (result.round === 'open' ? ` (${result.reason})` : ` (closed by ${result.closedBy})`),
              timestamp: new Date().toISOString(),
              walletAddress: walletAddress
            })
          }).catch(e => console.log('Could not log to server:', e.message));
        } catch (e) {
          console.log('Could not send timeout log to server:', e.message);
        }

        return; // Don't navigate to Results page
      }

      // 6) Navigate to the RESULTS page on success
      setTransactionStatus('');
      setCurrentPage(PAGES.RESULTS);
    } catch (error) {
      console.error('Error running query:', error);
      // Set error state to enable debug functionality
      setHasError(true);
      setLastError(error);

      // Try custom error decoding, then fall back to message string matching
      let decoded = null;
      if (error.data && writeContract) {
        try {
          const parsed = writeContract.interface.parseError(error.data);
          if (parsed) {
            const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
            decoded = parsed.name + args;
          }
        } catch {}
      }
      const msg = decoded || error.reason || error.message || '';

      if (msg.includes('InsufficientPayment') || msg.toLowerCase().includes('insufficient funds') || msg.toLowerCase().includes('insufficient eth')) {
        const errorMessage = `Not enough ETH was attached to pay for this AI jury request.

Each query prepays the worst-case arbiter fees in ETH (refunded if unused). Please ensure your wallet has enough ETH and try again.`;
        setTransactionStatus(`Error: Insufficient ETH for payment`);
        alert(errorMessage);
      } else if (msg.includes('InactiveOracle') || msg.includes('BadSelectionCount')) {
        const errorMessage = `No eligible arbiters could be selected for this request (class ${selectedClassId === undefined ? 128 : selectedClassId}).

This usually means too few active oracles serve the selected class, or the per-oracle fee ceiling excluded them. Try a different class or contact the administrator.`;
        setTransactionStatus(`Error: ${decoded || 'No eligible arbiters'}`);
        alert(errorMessage);
      } else if (msg.includes('User rejected')) {
        setTransactionStatus(`Error: Transaction rejected`);
        alert('You rejected the transaction in your wallet. Please try again and approve the transaction.');
      } else {
        setTransactionStatus(`Error: ${msg}`);
        alert('An error occurred while processing the query. Check the console for details.');
      }
    } finally {
      setLoadingResults(false);
      setWaitDeadline(null);
      // A settled (or failed/timed-out) round may have refunded unspent prepay as an
      // ethOwed credit — refresh the widget so the user sees their reclaimable balance.
      refreshEthCredit();
    }
  };

  return (
    <div className="page run">
      <h2>Run Query</h2>
      
      {/* What happened to a round that got no result in time */}
      <TimeoutNotice
        info={timeoutInfo}
        ethCredit={ethCredit}
        onCloseRound={handleCloseRound}
        closing={closingRound}
        closeStatus={closeStatus}
        disabled={loadingResults}
      />

      {/* ETH payment notice + prepay credit */}
      {isConnected && (
        <div style={{
          backgroundColor: '#eef6ff',
          border: '1px solid #bcd8f5',
          borderRadius: '8px',
          padding: '12px 16px',
          margin: '12px 0',
          fontSize: '14px',
          color: '#234',
        }}>
          <div>
            💧 Queries are paid in <strong>ETH</strong>. Each run prepays the worst-case arbiter
            fees (about <strong>{ethers.formatEther(maxTotalFeeEstimate)} ETH</strong>); any unused
            amount is returned as on-chain <em>prepay credit</em> that is automatically applied to
            your next query.
          </div>
          {ethCredit > 0n && (
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span>
                Your prepay credit: <strong>{ethers.formatEther(ethCredit)} ETH</strong>
              </span>
              <button
                className="secondary"
                onClick={handleWithdrawCredit}
                disabled={withdrawing}
                style={{ padding: '2px 10px', fontSize: '13px', cursor: 'pointer' }}
                title="Withdraw your unused prepay credit back to your wallet"
              >
                {withdrawing ? 'Withdrawing…' : 'Withdraw credit'}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="method-selector">
        <h3>Select Query Method</h3>
        <div className="method-options">
          <div
            className={`method-option ${selectedMethod === 'config' ? 'selected' : ''}`}
            onClick={() => setSelectedMethod('config')}
          >
            <h4>Use Current Configuration</h4>
            <p>Use the query and jury settings defined in the previous steps</p>
          </div>
          <div
            className={`method-option ${selectedMethod === 'file' ? 'selected' : ''}`}
            onClick={() => setSelectedMethod('file')}
          >
            <h4>Upload Query Package</h4>
            <p>Upload a ZIP file containing a complete query package</p>
          </div>
          <div
            className={`method-option ${selectedMethod === 'ipfs' ? 'selected' : ''}`}
            onClick={() => setSelectedMethod('ipfs')}
          >
            <h4>Use IPFS CID</h4>
            <p>Provide a CID for an existing query package on IPFS</p>
          </div>
        </div>
        <div className="method-details">
          {selectedMethod === 'config' && (
            <div className="config-summary">
              <h4>Current Configuration Summary</h4>
              <div className="summary-details">
                <p>
                  <strong>Query Text:</strong> {queryText}
                </p>
                <p>
                  <strong>Outcomes ({outcomeLabels?.length || 0}):</strong>
                  <ul>
                    {outcomeLabels?.map((label, index) => (
                      <li key={index}>{label}</li>
                    ))}
                  </ul>
                </p>
                <p>
                  <strong>Supporting Files:</strong> {supportingFiles.length}
                </p>
                <p>
                  <strong>IPFS CIDs:</strong> {ipfsCids.length}
                </p>
                <p>
                  <strong>Jury Members:</strong> {juryNodes.length}
                </p>
                <p>
                  <strong>Iterations:</strong> {iterations}
                </p>
                {hyperlinks && hyperlinks.length > 0 && (
                  <div>
                    <strong>Reference URLs:</strong>
                    <ul>
                      {hyperlinks.map((link, index) => (
                        <li key={index}>
                          <a href={link.url} target="_blank" rel="noopener noreferrer" className="url-value">
                            {link.url}
                          </a>
                          {link.description && (
                            <span className="url-description">- {link.description}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
          {selectedMethod === 'file' && (
            <div className="file-upload">
              <input
                type="file"
                accept=".zip"
                onChange={handleFileUpload}
                className="file-input"
              />
              {queryPackageFile && (
                <div className="file-info">
                  <p className="file-name">Selected: {queryPackageFile.name}</p>
                  {uploadProgress > 0 && uploadProgress < 100 && (
                    <div className="upload-progress">
                      <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
                      <span className="progress-text">{uploadProgress}%</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

	{selectedMethod === 'ipfs' && (
	  <div className="cid-input">
	    <label>Enter Query Package CID(s)</label>
	    <input
	      type="text"
	      className={showingDefaultCid ? 'default-value' : ''}
	      value={showingDefaultCid ? DEFAULT_QUERY_CID : queryPackageCid}
	      onFocus={() => {
	        // Clear default value when field is focused
	        if (showingDefaultCid) {
	          setShowingDefaultCid(false);
	          setQueryPackageCid('');
	        }
	      }}
	      onChange={(e) => {
	        // Set exactly what the user typed/pasted
	        setQueryPackageCid(e.target.value);
	        // Ensure we're not showing default anymore once user has typed something
	        if (showingDefaultCid) {
	          setShowingDefaultCid(false);
	        }
	      }}
	      placeholder="Enter one or more CIDs separated by commas"
	    />
	    <small className="helper-text">For multiple CIDs, separate them with commas. Only the first CID will be used to display package details.</small>
	    
	    <label>Optional Text Addendum</label>
	    <input
	      type="text"
	      className="text-addendum"
	      placeholder="Add optional text here"
	      value={textAddendum}
	      onChange={(e) => setTextAddendum(e.target.value)}
	    />
	  </div>
	)}

        </div>
        <div className="actions">
          <button
            className="primary"
            onClick={handleRunQuery}
            disabled={loadingResults || (selectedMethod === 'file' && !queryPackageFile)}
          >
	  {loadingResults ? (
            <>
              <span className="spinner"></span>
              {transactionStatus || 'Processing…'}
              {secondsLeft !== null && secondsLeft > 0 && (
                <>  ({secondsLeft}s)</>
              )}
            </>
          ) : (
            'Run Query'
          )}
          </button>
          
          {isConnected && hasError && (
            <button
              className="secondary debug-button"
              onClick={debugContractIssues}
              disabled={loadingResults}
              style={{ marginLeft: '10px', fontSize: '14px' }}
              title="Debug contract issues and analyze the last error"
            >
              🔍 Debug Contract
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default RunQuery;

