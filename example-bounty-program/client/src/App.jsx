import { useState, useEffect } from 'react';
import { initializeContractService } from './services/contractService';
import { config } from './config';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { walletService } from './services/wallet';
import { ToastProvider, useToast } from './components/Toast';
import Header from './components/Header';
import Home from './pages/Home';
import CreateBounty from './pages/CreateBounty';
import BountyDetails from './pages/BountyDetails';
import SubmitWork from './pages/SubmitWork';
import MyBounties from './pages/MyBounties';
import Analytics from './pages/Analytics';
import Agents from './pages/Agents';
import Blockchain from './pages/Blockchain';
import './App.css';

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

  const [walletState, setWalletState] = useState({
    isConnected: false,
    address: null,
    chainId: null,
    isCorrectNetwork: false
  });

  // Subscribe to wallet state changes and try to reconnect on mount
  useEffect(() => {
    const unsubscribe = walletService.subscribe((newState) => {
      setWalletState(newState);
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
      console.error('Failed to connect wallet:', error);
      toast.error(`Failed to connect wallet: ${error.message}`);
    }
  };

  const handleDisconnect = () => {
    walletService.disconnect();
    // State will be updated via subscription
  };

  return (
    <div className="app">
      <Header
        walletState={walletState}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Home walletState={walletState} />} />
          <Route path="/create" element={<CreateBounty walletState={walletState} />} />
          <Route path="/bounty/:bountyId" element={<BountyDetails walletState={walletState} />} />
          <Route path="/bounty/:bountyId/submit" element={<SubmitWork walletState={walletState} />} />
          <Route path="/my-bounties" element={<MyBounties walletState={walletState} />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/agents" element={<Agents walletState={walletState} />} />
          <Route path="/blockchain" element={<Blockchain />} />
        </Routes>
      </main>
    </div>
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

