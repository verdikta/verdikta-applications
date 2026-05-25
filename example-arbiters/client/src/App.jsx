import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { NetworkProvider } from './context/NetworkContext';
import ScrollToTop from './components/ScrollToTop';
import Header from './components/Header';
import Home from './pages/Home';
import Analytics from './pages/Analytics';
import Contracts from './pages/Contracts';
import ClassDetails from './pages/ClassDetails';
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
            <Route path="/class/:classId" element={<ClassDetails />} />
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
        <Router>
          <AppContent />
        </Router>
      </NetworkProvider>
    </ToastProvider>
  );
}

export default App;
