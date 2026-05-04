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

  // Force the wallet to re-prompt for which account to share with this site.
  // Uses EIP-2255 (wallet_requestPermissions) which works in MetaMask, Rabby,
  // Coinbase Wallet, Brave Wallet, etc. Falls back gracefully if the wallet
  // doesn't support revoke.
  const switchAccount = async () => {
    if (!window.ethereum) {
      alert('No wallet detected.');
      return;
    }
    try {
      // Best-effort revoke first so MetaMask is forced to show the picker
      // (some versions silently approve if there are existing grants).
      try {
        await window.ethereum.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        });
      } catch (_) {
        // Older wallets don't support revoke — ignore and proceed.
      }
      const perms = await window.ethereum.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
      const accountsCaveat = perms?.[0]?.caveats?.find(c => c.type === 'restrictReturnedAccounts');
      const granted = accountsCaveat?.value || [];
      if (granted.length > 0) {
        setWalletAddress(granted[0]);
        setIsConnected(true);
      } else {
        // Fall back to whatever the wallet now reports as active
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts.length > 0) {
          setWalletAddress(accounts[0]);
          setIsConnected(true);
        } else {
          setWalletAddress('');
          setIsConnected(false);
        }
      }
    } catch (error) {
      // user closed the popup or rejected — leave existing state alone
      if (error?.code !== 4001) {
        console.error('Error switching account:', error);
        alert('Failed to switch account: ' + (error?.message || error));
      }
    }
  };

  const disconnectWallet = async () => {
    if (window.ethereum) {
      try {
        await window.ethereum.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        });
      } catch (_) {
        // Older wallets don't support revoke — clearing local state is the
        // best we can do.
      }
    }
    setWalletAddress('');
    setIsConnected(false);
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
              <span className="wallet-address" title={walletAddress}>
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </span>
              <span className="connection-status">Connected</span>
              <button
                className="wallet-switch"
                onClick={switchAccount}
                title="Pick a different account from your wallet"
                style={{
                  marginLeft: '8px',
                  padding: '2px 8px',
                  fontSize: '0.85em',
                  cursor: 'pointer',
                }}
              >
                Switch
              </button>
              <button
                className="wallet-disconnect"
                onClick={disconnectWallet}
                title="Disconnect wallet from this site"
                style={{
                  marginLeft: '4px',
                  padding: '2px 8px',
                  fontSize: '0.85em',
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
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