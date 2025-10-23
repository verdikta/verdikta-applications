import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { walletService } from './services/wallet';
import Header from './components/Header';
import Home from './pages/Home';
import CreateBounty from './pages/CreateBounty';
import BountyDetails from './pages/BountyDetails';
import SubmitWork from './pages/SubmitWork';
import './App.css';

function App() {
  const [walletState, setWalletState] = useState({
    isConnected: false,
    address: null,
    chainId: null,
    isCorrectNetwork: false
  });

  // Subscribe to wallet state changes
  useEffect(() => {
    const unsubscribe = walletService.subscribe((newState) => {
      setWalletState(newState);
    });

    // Check if already connected on mount
    const currentState = walletService.getState();
    if (currentState.isConnected) {
      setWalletState(currentState);
    }

    return unsubscribe;
  }, []);

  const handleConnect = async () => {
    try {
      await walletService.connect();
      // State will be updated via subscription
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      alert(`Failed to connect wallet: ${error.message}`);
    }
  };

  const handleDisconnect = () => {
    walletService.disconnect();
    // State will be updated via subscription
  };

  return (
    <Router>
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
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;

