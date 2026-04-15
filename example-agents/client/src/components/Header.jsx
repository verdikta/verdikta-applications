import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import './Header.css';

function Header() {
  return (
    <header className="header">
      <div className="header-container">
        <div className="header-left">
          <Link to="/" className="logo">
            <Bot size={28} className="logo-icon" />
            <div className="logo-text">
              <h1>Verdikta Agents</h1>
            </div>
          </Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Home</Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

export default Header;
