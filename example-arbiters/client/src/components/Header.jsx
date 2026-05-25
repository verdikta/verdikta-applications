import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { useNetwork, NETWORKS } from '../context/NetworkContext';
import './Header.css';

function Header() {
  const { selectedNetwork, setNetwork } = useNetwork();

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
        </div>
      </div>
    </header>
  );
}

export default Header;
