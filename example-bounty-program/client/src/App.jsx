import { useState, useEffect } from 'react';
import { initializeContractService, getContractService } from './services/contractService';
import { config, currentNetwork } from './config';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { walletService } from './services/wallet';
import { ToastProvider, useToast } from './components/Toast';
import Header from './components/Header';
import ErrorBoundary from './components/ErrorBoundary';
import Home from './pages/Home';
import CreateBounty from './pages/CreateBounty';
import BountyDetails from './pages/BountyDetails';
import SubmitWork from './pages/SubmitWork';
import MyBounties from './pages/MyBounties';
import Analytics from './pages/Analytics';
import Agents from './pages/Agents';
import Skills from './pages/Skills';
import Blockchain from './pages/Blockchain';
import AggHistory from './pages/AggHistory';
import EvaluationDetails from './pages/EvaluationDetails';
import ClassDetails from './pages/ClassDetails';
import ScrollToTop from './components/ScrollToTop';
import './App.css';

function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="not-found">
      <h1>Page not found</h1>
      <p>No page exists at <code>{pathname}</code>.</p>
      <p><Link to="/">Return to home</Link></p>
    </div>
  );
}

function AppContent() {
  const toast = useToast();

  useEffect(() => {
    // Initialize contract service
    if (config.bountyEscrowAddress) {
      try {
        initializeContractService(config.bountyEscrowAddress);
        console.log('Contract service initialized:', config.bountyEscrowAddress);
      } catch (error) {
        console.error('Failed to initialize contract service:', error);
      }
    } else {
      console.warn('No contract address configured');
    }
  }, []);

  const [walletState, setWalletState] = useState(() => walletService.getState());

  // Subscribe to wallet state changes and try to reconnect on mount
  useEffect(() => {
    const unsubscribe = walletService.subscribe((newState) => {
      setWalletState(newState);
      // Reset contract service when account changes so it reconnects with the new signer
      const cs = getContractService();
      if (cs) {
        if (!newState.isConnected) {
          cs.disconnect();
        } else if (cs.userAddress && newState.address !== cs.userAddress) {
          cs.disconnect();
        }
      }
    });

    // Try to silently reconnect if user was previously connected
    walletService.tryReconnect().then((result) => {
      if (result) {
        console.log('Wallet auto-reconnected on page load');
      }
    }).catch((err) => {
      console.warn('Auto-reconnect failed:', err);
    });

    return unsubscribe;
  }, []);

  const handleConnect = async () => {
    try {
      await walletService.connect();
      // State will be updated via subscription
    } catch (error) {
      // walletService already logged the raw error + diagnostics and set
      // lastError (rendered persistently in the header). The toast is just a
      // nudge toward it, so keep it short but visible for longer than default.
      const explained = walletService.lastError;
      toast.error(explained?.message || `Failed to connect wallet: ${error?.message || error}`, 8000);
    }
  };

  const handleDisconnect = () => {
    walletService.disconnect({ revoke: true });
    // State will be updated via subscription
  };

  const handleDismissError = () => walletService.clearError();

  return (
    <>
      <ScrollToTop />
      <div className="app">
        <Header
        walletState={walletState}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onDismissError={handleDismissError}
      />

      <main className="main-content">
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home walletState={walletState} />} />
          <Route path="/create" element={<CreateBounty walletState={walletState} />} />
          <Route path="/bounty/:bountyId" element={<BountyDetails walletState={walletState} />} />
          <Route path="/bounty/:bountyId/submit" element={<SubmitWork walletState={walletState} />} />
          <Route path="/my-bounties" element={<MyBounties walletState={walletState} onConnect={handleConnect} />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/agents" element={<Agents walletState={walletState} />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/blockchain" element={<Blockchain />} />
          <Route path="/bounty/:bountyId/evaluation" element={<EvaluationDetails />} />
          <Route path="/agg-history/:aggId" element={<AggHistory />} />
          <Route path="/class/:classId" element={<ClassDetails />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </ErrorBoundary>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <div className="app-footer-meta">
            <span>Verdikta Bounties · {currentNetwork.name}</span>
            {config.bountyEscrowAddress && (
              <a
                href={`${currentNetwork.explorer}/address/${config.bountyEscrowAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                title="BountyEscrow contract on the block explorer"
              >
                Escrow <code>{walletService.formatAddress(config.bountyEscrowAddress)}</code>
              </a>
            )}
            <span>
              <Link to="/#guarantees">On-chain escrow, judged by the Verdikta arbiter network</Link>
              {' '}· Use at your own risk
            </span>
          </div>
          <nav className="app-footer-links" aria-label="Footer">
            {/* /learn/ pages are static HTML (client/public/learn/), not router routes */}
            <a href="/learn/">About</a>
            <a href="/learn/faq/">FAQ</a>
            <Link to="/agents">Agents</Link>
            <Link to="/skills">Skills</Link>
            <Link to="/blockchain">Blockchain</Link>
            <a href="https://docs.verdikta.org" target="_blank" rel="noopener noreferrer">Docs</a>
            <a
              href="https://github.com/verdikta/verdikta-applications/tree/main/example-bounty-program"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source
            </a>
            <a href="https://verdikta.org/how-it-works" target="_blank" rel="noopener noreferrer">How Verdikta works</a>
          </nav>
        </div>
      </footer>
      </div>
    </>
  );
}

function App() {
  return (
    <ToastProvider>
      <Router>
        <AppContent />
      </Router>
    </ToastProvider>
  );
}

export default App;

