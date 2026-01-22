import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { config } from './config'

// Set page title based on network
document.title = config.network === 'base-sepolia' ? 'Bounties - Testnet' : 'Bounties'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
