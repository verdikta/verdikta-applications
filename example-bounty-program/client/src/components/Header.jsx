import { useState } from 'react';
import { Link } from 'react-router-dom';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import './Header.css';

function Header({ walletState, onConnect, onDisconnect }) {
  const { isConnected, address, chainId, isCorrectNetwork } = walletState;
  const [isSwitching, setIsSwitching] = useState(false);

  const handleSwitchNetwork = async () => {
    setIsSwitching(true);
    try {
      await walletService.switchNetwork();
    } catch (error) {
      console.error('Failed to switch network:', error);
      alert(`Failed to switch network: ${error.message}`);
    } finally {
      setIsSwitching(false);
    }
  };

  const getCurrentNetworkName = () => {
    if (!chainId) return 'Unknown';
    return walletService.getNetworkName(chainId);
  };

  return (
    <header className="header">
      <div className="header-container">
        <div className="header-left">
          <Link to="/" className="logo">
            <h1>🎯 Verdikta Bounties</h1>
          </Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Browse</Link>
            <Link to="/create" className="nav-link">Create Bounty</Link>
	    {isConnected && (
               <Link to="/my-bounties" className="nav-link">My Bounties</Link>
            )}
          </nav>
        </div>

        <div className="header-right">
          {!isConnected ? (
            <button onClick={onConnect} className="btn btn-primary">
              Connect Wallet
            </button>
          ) : (
            <div className="wallet-info">
              {!isCorrectNetwork && (
                <div className="wrong-network-alert">
                  <span className="network-warning">
                    ⚠️ Wrong Network
                  </span>
                  <button 
                    onClick={handleSwitchNetwork}
                    className="btn btn-warning btn-sm"
                    disabled={isSwitching}
                  >
                    {isSwitching ? 'Switching...' : `Switch to ${currentNetwork.name}`}
                  </button>
                </div>
              )}
              
              <div className="wallet-address">
                <span 
                  className={`network-badge ${isCorrectNetwork ? 'correct' : 'incorrect'}`}
                  title={`Chain ID: ${chainId}`}
                >
                  {isCorrectNetwork ? '✓' : '✗'} {getCurrentNetworkName()}
                </span>
                <span className="address" title={address}>
                  {walletService.formatAddress(address)}
                </span>
              </div>
              
              <button onClick={onDisconnect} className="btn btn-secondary btn-sm">
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;

