// src/components/Header.js
import React from 'react';
import { PAGES, CONTRACT_OPTIONS } from '../App'; // or re-export these from a constants file

import { ethers } from 'ethers';

function Header({
  currentPage,
  setCurrentPage,
  isConnected,
  setIsConnected,
  walletAddress,
  setWalletAddress,
  contractAddress,
  setContractAddress
}) {

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        alert('Please install MetaMask!');
        return;
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts.length > 0) {
        setWalletAddress(accounts[0]);
        setIsConnected(true);
      }

      // Handle accountsChanged
      window.ethereum.on('accountsChanged', (acc) => {
        if (acc.length === 0) {
          setIsConnected(false);
          setWalletAddress('');
        } else {
          setWalletAddress(acc[0]);
        }
      });
    } catch (error) {
      console.error('Error connecting wallet:', error);
      alert('Failed to connect to MetaMask.');
    }
  };

  return (
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
            onChange={(e) => setContractAddress(e.target.value)}
            className="contract-select"
          >
            {CONTRACT_OPTIONS.map((contract, index) => (
              <option key={index} value={contract.address}>
                {contract.name}
              </option>
            ))}
          </select>
        </div>
        <div className="wallet-connection">
          {isConnected ? (
            <div className="wallet-info">
              <span className="wallet-address">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </span>
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
}

export default Header;