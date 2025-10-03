import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Header from './components/Header';
import Home from './pages/Home';
import CreateBounty from './pages/CreateBounty';
import BountyDetails from './pages/BountyDetails';
import SubmitWork from './pages/SubmitWork';
import { walletService } from './services/wallet';
import './App.css';

function App() {
  const [walletState, setWalletState] = useState({
    isConnected: false,
    address: null,
    chainId: null,
    isCorrectNetwork: false
  });

  // Check for existing wallet connection on mount
  useEffect(() => {
    checkWalletConnection();
  }, []);

  const checkWalletConnection = async () => {
    if (walletService.isMetaMaskInstalled()) {
      try {
        const accounts = await window.ethereum.request({
          method: 'eth_accounts'
        });

        if (accounts.length > 0) {
          await connectWallet();
        }
      } catch (error) {
        console.error('Error checking wallet connection:', error);
      }
    }
  };

  const connectWallet = async () => {
    try {
      const result = await walletService.connect();
      setWalletState({
        isConnected: true,
        address: result.address,
        chainId: result.chainId,
        isCorrectNetwork: walletService.getState().isCorrectNetwork
      });
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      alert(error.message);
    }
  };

  const disconnectWallet = () => {
    walletService.disconnect();
    setWalletState({
      isConnected: false,
      address: null,
      chainId: null,
      isCorrectNetwork: false
    });
  };

  return (
    <Router>
      <div className="app">
        <Header
          walletState={walletState}
          onConnect={connectWallet}
          onDisconnect={disconnectWallet}
        />
        
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home walletState={walletState} />} />
            <Route path="/create" element={<CreateBounty walletState={walletState} />} />
            <Route path="/bounty/:bountyId" element={<BountyDetails walletState={walletState} />} />
            <Route path="/bounty/:bountyId/submit" element={<SubmitWork walletState={walletState} />} />
          </Routes>
        </main>

        <footer className="app-footer">
          <p>Verdikta AI-Powered Bounty Program • Built with ❤️ on Base</p>
        </footer>
      </div>
    </Router>
  );
}

export default App;
