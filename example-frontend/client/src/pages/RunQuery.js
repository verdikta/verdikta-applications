/* global BigInt */
// src/pages/RunQuery.js
import React, { useState, useEffect } from 'react';
// Import ethers along with parseEther from ethers v6 (we no longer import BigNumber)
import { ethers, parseEther, parseUnits } from 'ethers';
import { getNetworkConfig } from '../utils/contractUtils';
import { PAGES } from '../App';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';
import { createQueryPackageArchive } from '../utils/packageUtils';
import { uploadToServer } from '../utils/serverUtils';
import { getAugmentedQueryText } from '../utils/queryUtils';
import {
  CONTRACT_ABI,
  ensureCorrectNetwork,
  CURRENT_NETWORK,
} from '../utils/contractUtils';
import { modelProviderService } from '../services/modelProviderService';
import { waitForFulfilOrTimeout } from '../utils/timeoutUtils';
import { ContractDebugger } from '../utils/contractDebugger';

// Import the LINK token ABI (make sure this file exists at src/utils/LINKTokenABI.json)
import LINK_TOKEN_ABI from '../utils/LINKTokenABI.json';

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
  // 1. look for MetaMask in the multi‑provider array
  const injected = window.ethereum?.providers?.find(p => p.isMetaMask);
  if (injected) return new ethers.BrowserProvider(injected);

  // 2. single injected provider (does not work with Brave) 
  if (window.ethereum && window.ethereum.isBraveWallet === false) 
    return new ethers.BrowserProvider(window.ethereum);

  // 3. no wallet at all – use public RPC for selected network
  const networkConfig = getNetworkConfig(networkKey);
  return new ethers.JsonRpcProvider(networkConfig.rpcUrl);

}

// Helper function to poll for evaluation results
async function pollForEvaluationResults(
  contract,
  requestId,
  setTransactionStatus,
  setOutcomes,
  setJustification,
  setResultCid,
  setResultTimestamp,
  setOutcomeLabels
) {
  setTransactionStatus?.('Waiting for evaluation results...');
  let attempts = 0;
  const maxAttempts = 60; // 5 min. Should timeout at exactly 5 minutes (60 * 5s = 300s)
  let foundEvaluation = null;
  while (!foundEvaluation && attempts < maxAttempts) {
    attempts++;
    console.log(`🔄 Polling attempt ${attempts}/${maxAttempts} (${attempts * 5}s elapsed)`);
    try {
      const result = await contract.getEvaluation(requestId);
      const [likelihoods, justificationCid, exists] = result;
      console.log(`📊 Poll result - exists: ${exists}, likelihoods: ${likelihoods?.length || 0}, justificationCid: ${justificationCid}`);
      if (exists && likelihoods?.length > 0) {
        console.log('✅ Found evaluation results!');
        foundEvaluation = result;
        break;
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
    if (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (!foundEvaluation) {
    console.log('🕐 Polling timeout reached - returning timed-out status');
    return { status: 'timed-out' };
  }
  const [likelihoods, justificationCid] = foundEvaluation;
  setOutcomes?.(likelihoods.map(Number));
  setJustification?.('Loading justification...');
  setResultCid?.(justificationCid);
  setTransactionStatus?.('Fetching justification from server...');
  try {
    if (!justificationCid) {
      // Still in commit stage – keep polling
      return { status: 'pending' };
    }
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
  return { status: 'fulfilled' };
}

/**
 * Grow or replace LINK allowance according to age of last Approval event.
 *
 * requiredExtra – bigint (fee for this new request)
 */
async function topUpLinkAllowance({
  requiredExtra,
  provider,
  owner,
  spender,
  linkTokenAddress,
  setTransactionStatus,
  STALE_SECONDS   = 1800,      // 1/2 hour, after this approval is considered stale
  SEARCH_WINDOW   = 7_200,     // look back this many blocks seeking last approval (~4 hours on Base Sepolia)
  PAYMENT_MULTIPLIER = 1.5,    // modest margin for overlapping calls; actual fee is ~0.03 LINK
  PAYMENT_MIN = parseUnits("5", 15), // 0.005 LINK floor (safety only, not a buffer)
  PAYMENT_MAX = parseUnits("2", 17)  // 0.2 LINK ceiling (sanity cap)
}) {
  const signer = await provider.getSigner();
  const link   = new ethers.Contract(linkTokenAddress, LINK_TOKEN_ABI, signer);

  // 1.  Find the age of the last Approval(owner, spender, …) 
  const filter       = link.filters.Approval(owner, spender);
  const latestBlock  = await provider.getBlockNumber();
  const fromBlock    = Math.max(0, latestBlock - SEARCH_WINDOW);
  const events       = await link.queryFilter(filter, fromBlock, latestBlock);

  let hasHistory = false;
  let ageSecs    = 0;

  if (events.length > 0) {
    hasHistory = true;
    const lastBlock = await provider.getBlock(events[events.length - 1].blockNumber);
    ageSecs = Math.floor(Date.now() / 1000) - lastBlock.timestamp;
  }

  // 2.  Current allowance 
  const current = await link.allowance(owner, spender); 

  // 3.  Decide newTotal 
  let newTotal;
  const requiredExtraWithMargin = BigInt(PAYMENT_MULTIPLIER)*requiredExtra;
  if (!hasHistory) {
    // First approval over window 
    newTotal = requiredExtraWithMargin;
    newTotal<BigInt(PAYMENT_MIN) && (newTotal=BigInt(PAYMENT_MIN));
    setTransactionStatus?.(`Approving LINK to begin (using ${PAYMENT_MULTIPLIER}× margin with a minimum)…`);
  } else if (ageSecs > STALE_SECONDS) {
    // Old approval exists → replace with just this fee
    newTotal = requiredExtraWithMargin;
    newTotal<BigInt(PAYMENT_MIN) && (newTotal=BigInt(PAYMENT_MIN));
    setTransactionStatus?.('Replacing stale LINK allowance…');
  } else {
    // Recent approval → add on top
    newTotal = current + requiredExtraWithMargin;
    newTotal<BigInt(PAYMENT_MIN) && (newTotal=BigInt(PAYMENT_MIN));
    if(newTotal>BigInt(PAYMENT_MAX))
    {
      newTotal = BigInt(PAYMENT_MAX);
      setTransactionStatus?.('Topping-up active LINK allowance to maximum…');
    }
    else
    {
      setTransactionStatus?.('Topping-up active LINK allowance…');
    }
  }

  // 4.  Send approve() 
  console.log( `Allowance ${ethers.formatUnits(current, 18)} → `
    + `${ethers.formatUnits(newTotal, 18)} LINK`);
  const tx = await link.approve(spender, newTotal);
  await tx.wait();
  console.log('LINK approval confirmed:', tx.hash);
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

  // Timer
  const [secondsLeft, setSecondsLeft] = useState(null);   // null = countdown not active
  useEffect(() => {
    if (secondsLeft === null) return;          // countdown inactive
    const id = setInterval(() => {
      setSecondsLeft(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  // Update showingDefaultCid when selectedMethod changes to 'ipfs'
  useEffect(() => {
    if (selectedMethod === 'ipfs') {
      setShowingDefaultCid(queryPackageCid === '' || queryPackageCid === undefined);
    }
  }, [selectedMethod, queryPackageCid]);

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
    
    const provider = new ethers.BrowserProvider(window.ethereum);
    const contractDebugger = new ContractDebugger(provider, contractAddress, walletAddress);
    
    // Get actual parameters from current state
    const currentCid = selectedMethod === 'ipfs' 
      ? (showingDefaultCid ? DEFAULT_QUERY_CID : queryPackageCid.trim())
      : 'QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS';
    
    const report = await contractDebugger.generateDebugReport(
      [getFirstCid(currentCid)], // Use actual CID from current state
      textAddendum.trim(),
      alpha || 500, // Use actual alpha value
      maxFee || parseUnits("0.01", 18), // Use actual maxFee
      estimatedBaseCost || parseUnits("0.0001", 18), // Use actual estimatedBaseCost
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

const handleRunQuery = async () => {
  console.log('🚀 handleRunQuery called - isConnected:', isConnected, 'walletAddress:', walletAddress);
  
  if (!isConnected) {
    alert('Please connect your wallet first using the "Connect Wallet" button in the header.');
    return;
  }

  console.log('🔄 Proceeding with query execution...');
  try {
    setLoadingResults(true);
    setTransactionStatus('Processing...');
    // Clear any previous errors when starting a new query
    setHasError(false);
    setLastError(null);

    console.log('🌐 Creating provider and ensuring correct network...');
    console.log('📍 Selected network:', selectedNetwork);

    // Fallback to default if selectedNetwork is undefined
    const networkToUse = selectedNetwork || 'base_sepolia';
    console.log('📍 Using network:', networkToUse);

    // 1) Ensure wallet is on the selected network (base or base_sepolia)
    const ethereum = window.ethereum?.providers?.find(p => p.isMetaMask) ?? window.ethereum;
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
     setTransactionStatus(`Error: No contract at ${contractAddress} on ${CURRENT_NETWORK.name}`);
     alert(`No contract at ${contractAddress} on ${CURRENT_NETWORK.name}. Did you pick the right address for this network?`);
     setLoadingResults(false);
     return;
   }

    const signer = await provider.getSigner();
    const writeContract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
    const readContract  = new ethers.Contract(
       contractAddress, CONTRACT_ABI, roProvider);

    // 2) Check contract funding
    // setTransactionStatus?.('Checking contract funding...');
    // await checkContractFunding(contract, provider);
    const config = await readContract.getContractConfig();
    const linkTokenAddress = config.linkAddr;
    if ((await roProvider.getCode(linkTokenAddress)) === '0x') {
      throw new Error(`LINK token not found at ${linkTokenAddress} on ${CURRENT_NETWORK.name}`);
    }

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

    // 4) Make sure the contract has enough LINK allowance
    try {
      console.log('💰 Checking LINK allowance - walletAddress:', walletAddress);
      if (!walletAddress) {
        throw new Error('Wallet address is not available for LINK allowance check');
      }
      
      const feeForThisRequest = await readContract.maxTotalFee(maxFee);
      await topUpLinkAllowance({
        requiredExtra:     feeForThisRequest,
        provider,
        owner:             walletAddress,
        spender:           contractAddress,
        linkTokenAddress,
        setTransactionStatus
      });
    } catch (err) {
      console.error('LINK approval error:', err);
      // Set error state for debug functionality
      setHasError(true);
      setLastError(err);
      // Bail out early; the main tx will fail without allowance
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

/* ----- Start a five-minute countdown in the UI ----- */
setSecondsLeft(300);          // match responseTimeoutSeconds

/* ----- Build fee overrides once, reuse for timeout tx ----- */
const feeOverrides = {
  gasLimit: 900_000,          // plentiful; the function is cheap
  maxFeePerGas: adjustedMaxFee,
  maxPriorityFeePerGas: adjustedPriorityFee
};

/* ----- Consolidate the callback setters so we can pass them as one object ----- */
const pollCallbacks = {
  pollForEvaluationResults,
  setTransactionStatus,
  setOutcomes,
  setJustification,
  setResultCid,
  setResultTimestamp,
  setOutcomeLabels
};

const result = await waitForFulfilOrTimeout({
  contract: readContract,
  requestId,
  pollCallbacks,
  feeOverrides,
  setTransactionStatus,
  responseTimeoutSeconds
});

console.log('🔍 Timeout check - result status:', result.status);
if (result.status === 'timed-out') {
  console.log('⏰ TIMEOUT DETECTED - handling timeout case');
  console.error('TIMEOUT ERROR: Query timed out after waiting for oracle response');
  
  // Clear all result state to prevent showing stale data
  setJustification?.('⚠️  The oracle did not respond in time. Request marked as FAILED.');
  setOutcomes?.([]);
  setResultCid?.('');
  setResultTimestamp?.('');
  setOutcomeLabels?.([]);
  
  // Stay on RunQuery page to show timeout error, don't navigate to Results
  setTransactionStatus('❌ TIMEOUT ERROR: Query timed out - no response received from the oracle.');
  
  // Show multiple forms of user feedback
  alert('⚠️ Query Timeout\n\nThe oracle did not respond within the timeout period. The request has been marked as FAILED.\n\nPlease check the browser console for detailed logs.');
  
  // Also log to server if possible
  try {
    fetch('/api/log-timeout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: 'Client-side timeout detected',
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
      
      if (error.message.includes('Insufficient LINK tokens')) {
        const errorMessage = `Contract doesn't have enough LINK tokens to perform this operation.

This blockchain operation requires LINK tokens to pay for the AI jury service. Please contact the administrator to fund the contract.`;
        setTransactionStatus(`Error: Insufficient LINK tokens`);
        alert(errorMessage);
      } else if (error.message.includes('User rejected')) {
        setTransactionStatus(`Error: Transaction rejected`);
        alert('You rejected the transaction in your wallet. Please try again and approve the transaction.');
      } else {
        setTransactionStatus(`Error: ${error.message}`);
        alert('An error occurred while processing the query. Check the console for details.');
      }
    } finally {
      setLoadingResults(false);
    }
  };

  return (
    <div className="page run">
      <h2>Run Query</h2>
      
      {/* Timeout Error Display */}
      {transactionStatus && transactionStatus.includes('TIMEOUT ERROR') && (
        <div style={{
          backgroundColor: '#fee',
          border: '2px solid #f88',
          borderRadius: '8px',
          padding: '20px',
          margin: '20px 0',
          textAlign: 'center'
        }}>
          <h3 style={{ color: '#d44', margin: '0 0 10px 0' }}>⚠️ Query Timeout</h3>
          <p style={{ color: '#d44', fontSize: '16px', margin: '0' }}>
            {transactionStatus}
          </p>
          <p style={{ color: '#666', fontSize: '14px', margin: '10px 0 0 0' }}>
            The oracle did not respond within the timeout period. Please try again or contact support if this persists.
          </p>
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
              {secondsLeft !== null && secondsLeft >= 0 && (
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

