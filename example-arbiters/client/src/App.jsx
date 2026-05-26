import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { NetworkProvider } from './context/NetworkContext';
import { WalletProvider } from './context/WalletContext';
import ScrollToTop from './components/ScrollToTop';
import Header from './components/Header';
import Home from './pages/Home';
import Analytics from './pages/Analytics';
import Contracts from './pages/Contracts';
import OwnerDetails from './pages/OwnerDetails';
import MyArbiters from './pages/MyArbiters';
import './App.css';

function AppContent() {
  return (
    <>
      <ScrollToTop />
      <div className="app">
        <Header />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/contracts" element={<Contracts />} />
            <Route path="/owner/:address" element={<OwnerDetails />} />
            <Route path="/my-arbiters" element={<MyArbiters />} />
          </Routes>
        </main>
      </div>
    </>
  );
}

function App() {
  return (
    <ToastProvider>
      <NetworkProvider>
        <WalletProvider>
          <Router>
            <AppContent />
          </Router>
        </WalletProvider>
      </NetworkProvider>
    </ToastProvider>
  );
}

export default App;
