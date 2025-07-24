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
  const [selectedContractClass, setSelectedContractClass] = useState(128);
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
        setContractOptions(updatedContracts.map(c => ({ ...c, class: c.class === undefined ? 128 : c.class })));
        if (updatedContracts.length > 0) {
          const currentSelected = updatedContracts.find(c => c.address === contractAddress);
          if (currentSelected) {
            setSelectedContractClass(currentSelected.class === undefined ? 128 : currentSelected.class);
          } else if (!contractAddress || contractAddress === "manage"){
            setContractAddress(updatedContracts[0].address);
            setSelectedContractClass(updatedContracts[0].class === undefined ? 128 : updatedContracts[0].class);
          }
        }
        setIsLoadingContracts(false);
        return;
      }
      
      const fetchedContracts = await fetchContracts();
      const contractsWithClass = fetchedContracts.map(c => ({ ...c, class: c.class === undefined ? 128 : c.class }));
      setContractOptions(contractsWithClass);

      if (contractsWithClass.length > 0) {
        const currentSelected = contractsWithClass.find(c => c.address === contractAddress);
        if (currentSelected) {
          setSelectedContractClass(currentSelected.class);
        } else if (!contractAddress || contractAddress === "manage") {
          setContractAddress(contractsWithClass[0].address);
          setSelectedContractClass(contractsWithClass[0].class);
        }
      }
    } catch (error) {
      console.error('Failed to load contracts:', error);
      const CONTRACT_ADDRESSES = (process.env.REACT_APP_CONTRACT_ADDRESSES || '').split(',');
      const CONTRACT_NAMES = (process.env.REACT_APP_CONTRACT_NAMES || '').split(',');
      const CONTRACT_CLASSES = (process.env.REACT_APP_CONTRACT_CLASSES || '').split(',').map(c => parseInt(c.trim(), 10));
      
      const fallbackOptions = CONTRACT_ADDRESSES.map((address, index) => {
        const cls = (index < CONTRACT_CLASSES.length && !isNaN(CONTRACT_CLASSES[index])) ? CONTRACT_CLASSES[index] : 128;
        return {
          address,
          name: CONTRACT_NAMES[index] || `Contract ${index + 1}`,
          class: cls >=0 && cls <= 99999 ? cls : 128
        };
      }).filter(c => c.address);

      setContractOptions(fallbackOptions);
      if (fallbackOptions.length > 0) {
        const currentSelected = fallbackOptions.find(c => c.address === contractAddress);
        if (currentSelected) {
            setSelectedContractClass(currentSelected.class);
        } else if (!contractAddress) {
            setContractAddress(fallbackOptions[0].address);
            setSelectedContractClass(fallbackOptions[0].class);
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

  // Reset dropdown after returning from Contract Management
  useEffect(() => {
    if (currentPage !== PAGES.CONTRACT_MANAGEMENT && contractAddress === "manage" && contractOptions.length > 0) {
      setContractAddress(contractOptions[0].address);
      setSelectedContractClass(contractOptions[0].class === undefined ? 128 : contractOptions[0].class);
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
      const provider = new ethers.BrowserProvider(window.ethereum);
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
      <div className="brand">AI Jury System</div>
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
                const selectedOpt = contractOptions.find(c => c.address === selectedAddr);
                if (selectedOpt) {
                  setSelectedContractClass(selectedOpt.class === undefined ? 128 : selectedOpt.class);
                }
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
                <option disabled style={{ borderTop: '1px solid #444', margin: '0', padding: '0', height: '1px', opacity: '0.5', overflow: 'hidden' }}>
                  ──────────
                </option>
                <option value="manage">Manage Contracts</option>
              </>
            )}
          </select>
          {contractOptions.length === 0 && !isLoadingContracts && (
            <button
              className="small-button"
              onClick={() => setCurrentPage(PAGES.CONTRACT_MANAGEMENT)}
              title="Add contracts"
            >
              +
            </button>
          )}
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
            walletAddress={walletAddress}
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
            selectedContractClass={selectedContractClass}
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
        {currentPage === PAGES.CONTRACT_MANAGEMENT && (
          <ContractManagement onContractsUpdated={loadContracts} />
        )}
      </main>
      <ToastContainer position="bottom-right" />
    </div>
  );
}

export default App;

