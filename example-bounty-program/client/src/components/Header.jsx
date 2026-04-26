import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Target, Wallet, LogOut, Check, Menu, X } from 'lucide-react';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import './Header.css';

function Header({ walletState, onConnect, onDisconnect }) {
  const { isConnected, address, chainId } = walletState;
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the mobile menu on route change.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Close on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const getCurrentNetworkName = () => {
    if (!chainId) return 'Unknown';
    return walletService.getNetworkName(chainId);
  };

  return (
    <header className="header">
      <div className="header-container">
        <Link to="/" className="logo">
          <Target size={28} className="logo-icon" />
          <div className="logo-text">
            <span className="logo-title">Verdikta Bounties</span>
            <span className="network-label">{currentNetwork.name}</span>
          </div>
        </Link>

        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen(o => !o)}
        >
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <div
          id="primary-nav"
          className={`header-collapsible${menuOpen ? ' is-open' : ''}`}
        >
          <nav className="nav">
            <Link to="/" className="nav-link">Browse</Link>
            <Link to="/create" className="nav-link">Create Bounty</Link>
            <Link to="/agents" className="nav-link">Agents</Link>
            <Link to="/analytics" className="nav-link">Analytics</Link>
            {isConnected && (
              <Link to="/my-bounties" className="nav-link">My Bounties</Link>
            )}
          </nav>

          <div className="header-right">
            {!isConnected ? (
              <button onClick={onConnect} className="btn btn-primary btn-with-icon">
                <Wallet size={18} />
                Connect Wallet
              </button>
            ) : (
              <div className="wallet-info">
                <div className="wallet-address">
                  <span className="network-badge correct" title={`Chain ID: ${chainId}`}>
                    <Check size={14} />
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
      </div>
    </header>
  );
}

export default Header;

