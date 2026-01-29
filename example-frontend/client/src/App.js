/* global BigInt */
// src/App.js

// import polyfill for UUID
import './utils/crypto-polyfill';

import React, { useState, useEffect, useCallback } from 'react';
import { Chart, CategoryScale, LinearScale, BarElement } from 'chart.js';
import './App.css';
import { ethers, parseEther } from 'ethers'; // ethers v6 import
import { createClient } from './services/verdiktaClient';
import { fetchContracts } from './utils/contractManagementService';
import { modelProviderService } from './services/modelProviderService';
import RunQuery from './pages/RunQuery';
import JurySelection from './pages/JurySelection';
import QueryDefinition from './pages/QueryDefinition';
import Results from './pages/Results';
import ContractManagement from './pages/ContractManagement';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Initialize browser-compatible verdikta client
const { archiveService, manifestParser, logger } = createClient({
  logging: { level: 'info' }
});

// Register Chart.js components
Chart.register(CategoryScale, LinearScale, BarElement);

// Navigation constants
export const PAGES = {
  DEFINE_QUERY: 'DEFINE_QUERY',
  JURY_SELECTION: 'JURY_SELECTION',
  RUN: 'RUN',
  RESULTS: 'RESULTS',
  CONTRACT_MANAGEMENT: 'CONTRACT_MANAGEMENT'
};

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';

// Set network label from .env
const NETWORK = (process.env.REACT_APP_NETWORK || '').toLowerCase();
const NETWORK_LABEL =
  NETWORK === 'base_sepolia' ? 'Base Sepolia' :
  NETWORK === 'base' ? 'Base Mainnet' :
  '';

// Static configuration mode settings
const STATIC_CONFIG_MODE = process.env.REACT_APP_STATIC_CONFIG_MODE === 'true';
const STATIC_CLASS_ID = parseInt(process.env.REACT_APP_STATIC_CLASS_ID) || 128;

// Simplified fetchQueryPackageDetails using verdikta client
const fetchQueryPackageDetails = async (cid) => {
  try {
    logger.info('Fetching query package:', cid);
    const baseUrl = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
    const response = await fetch(`${baseUrl}/api/fetch/${cid}?isQueryPackage=true`);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.details || `Failed to fetch query package: ${response.statusText}`);
    }

    const blob = await response.blob();
    logger.info('Received blob:', {
      size: blob.size,
      type: blob.type
    });

    // Use archiveService to extract files
    const files = await archiveService.extractArchive(blob);
    logger.info('Extracted files:', files.map(f => f.name));
    
    // Use manifestParser to parse the extracted content
    const result = await manifestParser.parse(files);
    logger.info('Parsed query package successfully');

    return result;
  } catch (error) {
    logger.error('Error fetching query package:', error);
    throw error;
  }
};

function App() {
  // Navigation state
  const [currentPage, setCurrentPage] = useState(PAGES.DEFINE_QUERY);
  
  // Query Definition state
  const [queryText, setQueryText] = useState('');
  const [supportingFiles, setSupportingFiles] = useState([]);
  const [ipfsCids, setIpfsCids] = useState([]);
  const [cidInput, setCidInput] = useState('');

  // Outcomes state
  const [outcomeLabels, setOutcomeLabels] = useState(['True', 'False']);
  
  // Jury Selection state
  const [iterations, setIterations] = useState(1);
  const [juryNodes, setJuryNodes] = useState([{
    provider: 'OpenAI',
    model: 'gpt-4o',
    runs: 1,
    weight: 1.0,
    id: Date.now()
  }]);
  
  // Dynamic model selection state
  const [availableModels, setAvailableModels] = useState({});
  const [classInfo, setClassInfo] = useState(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelError, setModelError] = useState(null);
  
  // Results state
  const [resultCid, setResultCid] = useState('');
  const [justification, setJustification] = useState(
    "Based on the provided query and supporting documentation, the AI Jury has reached the following conclusion:\n\n" +
    "The majority opinion (60%) favors Outcome 2, with a significant minority (40%) supporting Outcome 1. " +
    "This decision was reached after careful consideration of all submitted evidence and multiple rounds of deliberation. " +
    "Key factors influencing this decision include...\n\n" +
    "The jury particularly noted the strength of arguments presented in supporting document A, while also considering " +
    "the counterpoints raised in document B. The final distribution of opinions reflects both the complexity of the " +
    "issue and the relative weight of evidence presented."
  );
  const [outcomes, setOutcomes] = useState([400000, 600000]);

  // Additional results state
  const [lookupCid, setLookupCid] = useState('');
  const [loadingResults, setLoadingResults] = useState(false);

  // Other state declarations
  const [currentCid, setCurrentCid] = useState('');
  // For Run page – we use "approval" so the new method is used seamlessly
  const [selectedMethod, setSelectedMethod] = useState('approval');
  const [queryPackageFile, setQueryPackageFile] = useState(null);
  const [queryPackageCid, setQueryPackageCid] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [contractAddress, setContractAddress] = useState('');
  
  // Decoupled class selection - no longer tied to contract
  // In static config mode, use the static class ID and prevent changes
  const [selectedClassId, setSelectedClassId] = useState(STATIC_CONFIG_MODE ? STATIC_CLASS_ID : 128);
  const [overrideClassInfo, setOverrideClassInfo] = useState(null);
  
  // Handle class selection (including override classes)
  const handleClassSelect = (classId, overrideInfo = null) => {
    // In static config mode, ignore class selection changes
    if (STATIC_CONFIG_MODE) {
      console.log('🎯 App.js handleClassSelect ignored in static config mode');
      return;
    }
    console.log('🎯 App.js handleClassSelect called with:', classId, overrideInfo);
    setSelectedClassId(classId);
    setOverrideClassInfo(overrideInfo);
  };
  const [transactionStatus, setTransactionStatus] = useState('');
  const [resultTimestamp, setResultTimestamp] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [packageDetails, setPackageDetails] = useState(null);
  const [hyperlinks, setHyperlinks] = useState([]);
  const [linkInput, setLinkInput] = useState('');
  const [contractOptions, setContractOptions] = useState([]);
  const [isLoadingContracts, setIsLoadingContracts] = useState(true);
  const [prevPage, setPrevPage] = useState(null);

  // Default aggregator parameters
  const ALPHA = 500;
  const MAX_FEE = parseEther("0.01"); // returns a bigint
  const BASE_FEE_PCT = 1; // 1%
  const ESTIMATED_BASE_COST = MAX_FEE * BigInt(BASE_FEE_PCT) / 100n; // Using native BigInt arithmetic
  const MAX_FEE_SCALING_FACTOR = 10;

  // Function to load contracts - wrapping in useCallback to prevent infinite re-renders
  const loadContracts = useCallback(async (updatedContracts) => {
    setIsLoadingContracts(true);
    try {
      // If contracts are passed directly, use them instead of fetching
      if (updatedContracts && Array.isArray(updatedContracts)) {
        // Remove class coupling - contracts now only store address and name
        setContractOptions(updatedContracts.map(c => ({ 
          address: c.address, 
          name: c.name 
        })));
        if (updatedContracts.length > 0) {
          if (!contractAddress || contractAddress === "manage"){
            setContractAddress(updatedContracts[0].address);
          }
        }
        setIsLoadingContracts(false);
        return;
      }
      
      const fetchedContracts = await fetchContracts();
      // Remove class coupling - contracts now only store address and name
      const contractsWithoutClass = fetchedContracts.map(c => ({ 
        address: c.address, 
        name: c.name 
      }));
      setContractOptions(contractsWithoutClass);

      if (contractsWithoutClass.length > 0) {
        if (!contractAddress || contractAddress === "manage") {
          setContractAddress(contractsWithoutClass[0].address);
        }
      }
    } catch (error) {
      console.error('Failed to load contracts:', error);
      const CONTRACT_ADDRESSES = (process.env.REACT_APP_CONTRACT_ADDRESSES || '').split(',');
      const CONTRACT_NAMES = (process.env.REACT_APP_CONTRACT_NAMES || '').split(',');
      
      const fallbackOptions = CONTRACT_ADDRESSES.map((address, index) => {
        return {
          address,
          name: CONTRACT_NAMES[index] || `Contract ${index + 1}`
        };
      }).filter(c => c.address);

      setContractOptions(fallbackOptions);
      if (fallbackOptions.length > 0) {
        if (!contractAddress) {
            setContractAddress(fallbackOptions[0].address);
        }
      }
      toast.error('Failed to load contracts from server. Using fallback values.');
    } finally {
      setIsLoadingContracts(false);
    }
  }, [contractAddress]);

  // Load contracts from API on mount
  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  // Load available models when selected class changes
  useEffect(() => {
    const loadModels = async () => {
      if (!selectedClassId) return;
      
      console.log('🔄 Loading models for class:', selectedClassId, 'Override info:', overrideClassInfo);
      
      setIsLoadingModels(true);
      setModelError(null);
      
      try {
        // Use the updated service method that handles overrides
        const modelData = await modelProviderService.getProviderModels(selectedClassId, overrideClassInfo);
        
        console.log('📊 Model data loaded:', modelData);
        
        setAvailableModels(modelData.providerModels);
        setClassInfo(modelData.classInfo);
        
        // If this is an empty/error class, show a warning
        if (modelData.isEmpty) {
          if (modelData.classInfo.error) {
            setModelError(modelData.classInfo.error);
            toast.warning(`Class ${selectedClassId}: ${modelData.classInfo.error}`);
          } else if (modelData.classInfo.status === 'EMPTY') {
            setModelError(`Class ${selectedClassId} is empty and has no available models.`);
            toast.warning(`Class ${selectedClassId} is empty and has no available models.`);
          }
        }
        
        // Update jury nodes to use available models if current selection is invalid
        if (!modelData.isEmpty && Object.keys(modelData.providerModels).length > 0) {
          setJuryNodes(prevNodes => {
            let updatedNodes = prevNodes.map(node => {
              const availableProviders = Object.keys(modelData.providerModels);
              
              // If current provider is not available, switch to first available
              if (!availableProviders.includes(node.provider)) {
                const newProvider = availableProviders[0];
                const newModel = modelProviderService.getDefaultModel(newProvider, modelData.providerModels);
                return {
                  ...node,
                  provider: newProvider,
                  model: newModel
                };
              }
              
              // If current model is not available for the provider, switch to first available model
              const availableModels = modelData.providerModels[node.provider];
              if (!availableModels || !availableModels.includes(node.model)) {
                const newModel = modelProviderService.getDefaultModel(node.provider, modelData.providerModels);
                return {
                  ...node,
                  model: newModel
                };
              }
              
              return node;
            });

            // Enforce max panel size limit
            if (modelData.classInfo.limits?.max_panel_size) {
              const maxModels = modelData.classInfo.limits.max_panel_size;
              if (updatedNodes.length > maxModels) {
                console.warn(`Trimming jury nodes to max limit: ${maxModels}`);
                updatedNodes = updatedNodes.slice(0, maxModels);
              }
            }

            // Enforce max runs limit for each node
            if (modelData.classInfo.limits?.max_no_counts) {
              const maxRuns = modelData.classInfo.limits.max_no_counts;
              updatedNodes = updatedNodes.map(node => ({
                ...node,
                runs: Math.min(node.runs, maxRuns)
              }));
            }

            return updatedNodes;
          });

          // Enforce max iterations limit
          if (modelData.classInfo.limits?.max_iterations) {
            const maxIterations = modelData.classInfo.limits.max_iterations;
            setIterations(prev => {
              if (prev > maxIterations) {
                console.warn(`Trimming iterations to max limit: ${maxIterations}`);
                return maxIterations;
              }
              return prev;
            });
          }
        }
        
      } catch (error) {
        console.error('Error loading models:', error);
        setModelError(error.message);
        setAvailableModels({});
        setClassInfo({ id: selectedClassId, status: 'ERROR', error: error.message });
        toast.error(`Failed to load models for class ${selectedClassId}: ${error.message}`);
      } finally {
        setIsLoadingModels(false);
      }
    };

    loadModels();
  }, [selectedClassId, overrideClassInfo]);

  // Reset dropdown after returning from Contract Management
  useEffect(() => {
    if (currentPage !== PAGES.CONTRACT_MANAGEMENT && contractAddress === "manage" && contractOptions.length > 0) {
      setContractAddress(contractOptions[0].address);
      // Class selection is now independent of contract selection
    }
    
    // Refresh contracts when returning from Contract Management page
    if (currentPage !== PAGES.CONTRACT_MANAGEMENT && prevPage === PAGES.CONTRACT_MANAGEMENT) {
      loadContracts();
    }
  }, [currentPage, contractAddress, contractOptions, loadContracts, prevPage]);

  // Track previous page for detecting navigation from Contract Management
  useEffect(() => {
    setPrevPage(currentPage);
  }, [currentPage]);

  // Fetch package details when currentCid changes
  useEffect(() => {
    if (currentCid) {
      console.log('Fetching package details for CID:', currentCid);
      setTransactionStatus('Loading query package details...');
      fetchQueryPackageDetails(currentCid)
        .then(details => {
          console.log('Fetched package details:', details);
          setPackageDetails(details);
          setTransactionStatus('');
        })
        .catch(error => {
          console.error('Failed to load query package:', error);
          setTransactionStatus('Failed to load query package details');
        });
    }
  }, [currentCid]);

  const connectWallet = async () => {
    try {
      console.log('Connecting wallet...');
      if (!window.ethereum) {
        alert('Please install MetaMask!');
        return;
      }
      // const provider = new ethers.BrowserProvider(window.ethereum);
      const ethereum = window.ethereum?.providers?.find(p => p.isMetaMask) ?? window.ethereum;
      const provider = new ethers.BrowserProvider(ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      console.log('Accounts:', accounts);
      const address = accounts[0];
      setWalletAddress(address);
      setIsConnected(true);
      console.log('Wallet connected:', address);
      window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length === 0) {
          setIsConnected(false);
          setWalletAddress('');
        } else {
          setWalletAddress(accounts[0]);
        }
      });
    } catch (error) {
      console.error('Error connecting to MetaMask:', error);
      alert('Failed to connect to MetaMask.');
    }
  };

  const renderHeader = () => (
    <header className="app-header">
      <div className="brand">
        <div className="brand-title">Verdikta Playground</div>
        {NETWORK_LABEL && <div className="brand-subtitle">{NETWORK_LABEL}</div>}
      </div>
      <nav className="main-nav">
        <button 
          className={currentPage === PAGES.DEFINE_QUERY ? 'active' : ''}
          onClick={() => setCurrentPage(PAGES.DEFINE_QUERY)}
        >
          Define Query
        </button>
        <button 
          className={currentPage === PAGES.JURY_SELECTION ? 'active' : ''}
          onClick={() => setCurrentPage(PAGES.JURY_SELECTION)}
        >
          Jury Selection
        </button>
        <button 
          className={currentPage === PAGES.RUN ? 'active' : ''}
          onClick={() => setCurrentPage(PAGES.RUN)}
        >
          Run
        </button>
        <button 
          className={currentPage === PAGES.RESULTS ? 'active' : ''}
          onClick={() => setCurrentPage(PAGES.RESULTS)}
        >
          Results
        </button>
      </nav>
      <div className="contract-wallet-section">
        <div className="contract-selector">
          <select
            value={contractAddress}
            onChange={(e) => {
              if (e.target.value === "manage") {
                setCurrentPage(PAGES.CONTRACT_MANAGEMENT);
                setContractAddress("manage");
              } else {
                const selectedAddr = e.target.value;
                setContractAddress(selectedAddr);
                // Class selection is now decoupled from contract selection
              }
            }}
            className="contract-select"
            disabled={isLoadingContracts}
          >
            {isLoadingContracts ? (
              <option>Loading contracts...</option>
            ) : contractOptions.length === 0 ? (
              <option value="">No contracts available</option>
            ) : (
              <>
                {contractOptions.map((contract) => (
                  <option key={contract.address} value={contract.address}>
                    {contract.name}
                  </option>
                ))}
                {/* Hide Manage Contracts option in static config mode */}
                {!STATIC_CONFIG_MODE && (
                  <>
                    <option disabled style={{ borderTop: '1px solid #444', margin: '0', padding: '0', height: '1px', opacity: '0.5', overflow: 'hidden' }}>
                      ──────────
                    </option>
                    <option value="manage">Manage Contracts</option>
                  </>
                )}
              </>
            )}
          </select>
          {/* Hide add button in static config mode, but keep refresh button */}
          {!STATIC_CONFIG_MODE && contractOptions.length === 0 && !isLoadingContracts && (
            <button
              className="small-button"
              onClick={() => setCurrentPage(PAGES.CONTRACT_MANAGEMENT)}
              title="Add contracts"
            >
              +
            </button>
          )}
          {/* Always show refresh button - users should be able to refresh the contract list */}
          <button
            className="small-button refresh-button"
            onClick={loadContracts}
            title="Refresh contracts"
            disabled={isLoadingContracts}
          >
            ↻
          </button>
        </div>
        <div className="wallet-connection">
          {isConnected ? (
            <div className="wallet-info">
              <span className="wallet-address">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
              <span className="connection-status">Connected</span>
            </div>
          ) : (
            <button className="connect-wallet" onClick={connectWallet}>
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </header>
  );

  const renderJurySelection = () => (
    <JurySelection
      outcomeLabels={outcomeLabels}
      juryNodes={juryNodes}
      setJuryNodes={setJuryNodes}
      iterations={iterations}
      setIterations={setIterations}
      setCurrentPage={setCurrentPage}
      setSelectedMethod={setSelectedMethod}
      // Dynamic model props
      availableModels={availableModels}
      classInfo={classInfo}
      isLoadingModels={isLoadingModels}
      modelError={modelError}
      selectedClassId={selectedClassId}
      onClassSelect={handleClassSelect}
      overrideClassInfo={overrideClassInfo}
      staticConfigMode={STATIC_CONFIG_MODE}
    />
  );

  return (
    <div className="app">
      {renderHeader()}
      <main className="content">
        {currentPage === PAGES.DEFINE_QUERY && (
          <QueryDefinition
            queryText={queryText}
            setQueryText={setQueryText}
            outcomeLabels={outcomeLabels}
            setOutcomeLabels={setOutcomeLabels}
            supportingFiles={supportingFiles}
            setSupportingFiles={setSupportingFiles}
            ipfsCids={ipfsCids}
            setIpfsCids={setIpfsCids}
            cidInput={cidInput}
            setCidInput={setCidInput}
            hyperlinks={hyperlinks}
            setHyperlinks={setHyperlinks}
            linkInput={linkInput}
            setLinkInput={setLinkInput}
            setCurrentPage={setCurrentPage}
            classInfo={classInfo}
            selectedClassId={selectedClassId}
            onClassSelect={handleClassSelect}
            isLoadingModels={isLoadingModels}
            modelError={modelError}
            overrideClassInfo={overrideClassInfo}
            staticConfigMode={STATIC_CONFIG_MODE}
          />
        )}
        {currentPage === PAGES.JURY_SELECTION && renderJurySelection()}
        {currentPage === PAGES.RUN && (
          <RunQuery
            queryText={queryText}
            outcomeLabels={outcomeLabels}
            supportingFiles={supportingFiles}
            ipfsCids={ipfsCids}
            juryNodes={juryNodes}
            iterations={iterations}
            selectedMethod={selectedMethod}
            setSelectedMethod={setSelectedMethod}
            queryPackageFile={queryPackageFile}
            setQueryPackageFile={setQueryPackageFile}
            queryPackageCid={queryPackageCid}
            setQueryPackageCid={setQueryPackageCid}
            isConnected={isConnected}
            setIsConnected={setIsConnected}
            walletAddress={walletAddress}
            setWalletAddress={setWalletAddress}
            contractAddress={contractAddress}
            transactionStatus={transactionStatus}
            setTransactionStatus={setTransactionStatus}
            loadingResults={loadingResults}
            setLoadingResults={setLoadingResults}
            uploadProgress={uploadProgress}
            setUploadProgress={setUploadProgress}
            setCurrentCid={setCurrentCid}
            setPackageDetails={setPackageDetails}
            setResultCid={setResultCid}
            setJustification={setJustification}
            setOutcomes={setOutcomes}
            setResultTimestamp={setResultTimestamp}
            setCurrentPage={setCurrentPage}
            hyperlinks={hyperlinks}
            setOutcomeLabels={setOutcomeLabels}
            // Pass new aggregator parameters:
            alpha={ALPHA}
            maxFee={MAX_FEE}
            estimatedBaseCost={ESTIMATED_BASE_COST}
            maxFeeBasedScalingFactor={MAX_FEE_SCALING_FACTOR}
            selectedClassId={selectedClassId}
          />
        )}
        {currentPage === PAGES.RESULTS && (
          <Results
            queryText={queryText}
            outcomeLabels={outcomeLabels}
            outcomes={outcomes}
            justification={justification}
            resultCid={resultCid}
            setResultCid={setResultCid}
            lookupCid={lookupCid}
            setLookupCid={setLookupCid}
            loadingResults={loadingResults}
            resultTimestamp={resultTimestamp}
            packageDetails={packageDetails}
            currentCid={currentCid}
            setCurrentPage={setCurrentPage}
            setJustification={setJustification}
            setOutcomes={setOutcomes}
            setResultTimestamp={setResultTimestamp}
            setOutcomeLabels={setOutcomeLabels}
          />
        )}
        {/* Hide Contract Management page in static config mode */}
        {currentPage === PAGES.CONTRACT_MANAGEMENT && !STATIC_CONFIG_MODE && (
          <ContractManagement onContractsUpdated={loadContracts} />
        )}
      </main>
      <ToastContainer position="bottom-right" />
    </div>
  );
}

export default App;

