import { Link } from 'react-router-dom';
import { Scale, Wallet, LogOut } from 'lucide-react';
import { useNetwork, NETWORKS } from '../context/NetworkContext';
import { useWallet } from '../context/WalletContext';
import { useToast } from './Toast';
import './Header.css';

const formatAddress = (addr) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';

function Header() {
  const { selectedNetwork, setNetwork } = useNetwork();
  const { isConnected, address, connecting, isMetaMaskInstalled, connect, disconnect } = useWallet();
  const toast = useToast();

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      toast.error(err.message || 'Failed to connect wallet');
    }
  };

  return (
    <header className="header">
      <div className="header-container">
        <div className="header-left">
          <Link to="/" className="logo">
            <Scale size={28} className="logo-icon" />
            <div className="logo-text">
              <h1>Verdikta Arbiters</h1>
            </div>
          </Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Home</Link>
            <Link to="/analytics" className="nav-link">Analytics</Link>
            <Link to="/contracts" className="nav-link">Contracts</Link>
            <Link to="/my-arbiters" className="nav-link">My Arbiters</Link>
          </nav>
        </div>
        <div className="header-right">
          <select
            value={selectedNetwork}
            onChange={(e) => setNetwork(e.target.value)}
            className="network-selector"
            aria-label="Select network"
          >
            {NETWORKS.map((n) => (
              <option key={n.value} value={n.value}>{n.label}</option>
            ))}
          </select>

          {isConnected ? (
            <div className="wallet-pill" title={address}>
              <Wallet size={14} />
              <span className="wallet-address-short">{formatAddress(address)}</span>
              <button
                className="wallet-disconnect"
                onClick={disconnect}
                title="Disconnect wallet"
                aria-label="Disconnect wallet"
              >
                <LogOut size={14} />
              </button>
            </div>
          ) : isMetaMaskInstalled ? (
            <button className="btn-connect" onClick={handleConnect} disabled={connecting}>
              <Wallet size={14} />
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          ) : (
            <a
              className="btn-connect"
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Wallet size={14} />
              Install MetaMask
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;
