import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { config } from './config'

// Set page title based on network
document.title = config.network === 'base-sepolia' ? 'Verdikta Bounties - Testnet' : 'Verdikta Bounties'

// On testnet, use the red-center favicon so the tab is easy to tell apart
if (config.network === 'base-sepolia') {
  const icon = document.querySelector("link[rel='icon']")
  if (icon) icon.href = '/favicon-testnet.svg'
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
