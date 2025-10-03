import { Link } from 'react-router-dom';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import './Header.css';

function Header({ walletState, onConnect, onDisconnect }) {
  const { isConnected, address, isCorrectNetwork } = walletState;

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
                <span className="network-warning">
                  ⚠️ Wrong Network
                </span>
              )}
              <div className="wallet-address">
                <span className="network-badge">{currentNetwork.name}</span>
                <span className="address">{walletService.formatAddress(address)}</span>
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



