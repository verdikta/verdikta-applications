import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Target, Wallet, LogOut, Check, Menu, X } from 'lucide-react';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import { apiService } from '../services/api';
import './Header.css';

// How often to poll the action-required endpoint while the user has a wallet
// connected. Once a minute is plenty for an expiry-triggered nag — close
// actions are rare and on-chain state changes slowly.
const ACTION_REQUIRED_POLL_MS = 60_000;

function Header({ walletState, onConnect, onDisconnect }) {
  const { isConnected, address, chainId } = walletState;
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionRequiredCount, setActionRequiredCount] = useState(0);
  const location = useLocation();

  // Close the mobile menu on route change.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Poll for expired-bounty action-required count while a wallet is connected.
  // The endpoint returns 0 cheaply when there's nothing to do, so polling is
  // fine. Cleared immediately on disconnect to avoid stale badges.
  useEffect(() => {
    if (!isConnected || !address) {
      setActionRequiredCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const result = await apiService.getActionRequired(address);
        if (!cancelled) setActionRequiredCount(result?.count || 0);
      } catch (_) {
        // Swallow — the badge is best-effort; failure shouldn't disrupt the header.
      }
    };
    fetchCount();
    const id = setInterval(fetchCount, ACTION_REQUIRED_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isConnected, address]);

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
              <Link to="/my-bounties" className="nav-link">
                My Bounties
                {actionRequiredCount > 0 && (
                  <span
                    className="nav-badge"
                    aria-label={`${actionRequiredCount} bounty${actionRequiredCount === 1 ? '' : 'ies'} need attention`}
                    title="Expired bounties needing close — click to review"
                  >
                    {actionRequiredCount}
                  </span>
                )}
              </Link>
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

