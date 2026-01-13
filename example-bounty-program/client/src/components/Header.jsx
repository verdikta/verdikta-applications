import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Target, Wallet, LogOut, AlertTriangle, Check, X } from 'lucide-react';
import { useToast } from './Toast';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import './Header.css';

function Header({ walletState, onConnect, onDisconnect }) {
  const toast = useToast();
  const { isConnected, address, chainId, isCorrectNetwork } = walletState;
  const [isSwitching, setIsSwitching] = useState(false);

  const handleSwitchNetwork = async () => {
    setIsSwitching(true);
    try {
      await walletService.switchNetwork();
    } catch (error) {
      console.error('Failed to switch network:', error);
      toast.error(`Failed to switch network: ${error.message}`);
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
            <Target size={28} className="logo-icon" />
            <h1>Verdikta Bounties</h1>
          </Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Browse</Link>
            <Link to="/create" className="nav-link">Create Bounty</Link>
            <Link to="/analytics" className="nav-link">Analytics</Link>
            {isConnected && (
              <Link to="/my-bounties" className="nav-link">My Bounties</Link>
            )}
          </nav>
        </div>

        <div className="header-right">
          {!isConnected ? (
            <button onClick={onConnect} className="btn btn-primary btn-with-icon">
              <Wallet size={18} />
              Connect Wallet
            </button>
          ) : (
            <div className="wallet-info">
              {!isCorrectNetwork && (
                <div className="wrong-network-alert">
                  <span className="network-warning">
                    <AlertTriangle size={16} />
                    Wrong Network
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
                  {isCorrectNetwork ? <Check size={14} /> : <X size={14} />}
                  {getCurrentNetworkName()}
                </span>
                <span className="address" title={address}>
                  {walletService.formatAddress(address)}
                </span>
              </div>

              <button onClick={onDisconnect} className="btn btn-secondary btn-sm btn-with-icon">
                <LogOut size={16} />
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

