# Bounty Program Frontend

**Status:** 🟡 MVP Complete - Awaiting Contract Integration  
**Framework:** React + Vite  
**Version:** 0.1.0

## Overview

Modern React frontend for the Verdikta AI-Powered Bounty Program. Built with Vite for fast development and optimized production builds.

## Features Implemented

### ✅ Core Pages
- **Home** - Browse bounties, hero section, how it works
- **Create Bounty** - Multi-step form for bounty creation
- **Bounty Details** - View rubric, criteria, submissions
- **Submit Work** - File upload interface

### ✅ Components
- **Header** - Wallet connection, network display, navigation
- **BountyCard** - Reusable bounty display component

### ✅ Services
- **API Service** - Complete backend API integration
- **Wallet Service** - MetaMask connection and network management
- **Configuration** - Environment-based config system

### ✅ Functionality
- Wallet connection (MetaMask)
- Network switching (Base Sepolia ↔ Base)
- IPFS file uploads (rubrics, deliverables)
- Rubric validation
- Responsive design

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React 18 + Vite |
| Routing | React Router v6 |
| Web3 | Ethers.js v6 |
| HTTP Client | Axios |
| Charts | Chart.js + react-chartjs-2 |
| Styling | CSS (custom, no framework) |

## Setup

### Prerequisites
- Node.js >=18
- npm or yarn
- MetaMask browser extension

### Installation

```bash
cd client
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env`:
```env
VITE_API_URL=http://localhost:5005
VITE_CHAIN_ID=84532
VITE_BOUNTY_ESCROW_ADDRESS=0x... # After contract deployment
```

### Development

```bash
npm run dev
```

Opens at `http://localhost:5173`

### Production Build

```bash
npm run build
npm run preview  # Preview production build
```

## Project Structure

```
client/
├── public/              # Static assets
├── src/
│   ├── components/      # Reusable UI components
│   │   └── Header.jsx
│   ├── pages/           # Page components
│   │   ├── Home.jsx
│   │   ├── CreateBounty.jsx
│   │   ├── BountyDetails.jsx
│   │   └── SubmitWork.jsx
│   ├── services/        # Business logic
│   │   ├── api.js       # Backend API client
│   │   └── wallet.js    # Wallet management
│   ├── config.js        # App configuration
│   ├── App.jsx          # Main app component
│   ├── App.css          # Global styles
│   ├── main.jsx         # Entry point
│   └── index.css        # Base CSS reset
├── .env.example         # Environment template
├── package.json
└── vite.config.js
```

## Current Status

### ✅ Implemented
1. **Wallet Integration** - MetaMask connection, network switching
2. **IPFS Functionality** - File uploads via backend API
3. **Routing** - All pages with navigation
4. **Responsive UI** - Works on desktop and mobile
5. **Form Validation** - Client-side validation for inputs
6. **Error Handling** - User-friendly error messages

### ⏳ Pending (Requires Smart Contracts)
1. **Contract Interaction** - Create bounty on-chain
2. **Bounty Listing** - Query bounties from blockchain
3. **Bounty Details** - Fetch from contract + IPFS
4. **Submit Work** - On-chain submission with LINK approval
5. **Results Display** - Show AI evaluation results

## Usage

### Connect Wallet

1. Click "Connect Wallet" in header
2. Approve MetaMask connection
3. Switch to Base Sepolia if needed

### Create Bounty (IPFS Upload Works!)

1. Navigate to "Create Bounty"
2. Fill in details (title, description, payout)
3. Set evaluation criteria
4. Submit → Uploads rubric to IPFS
5. **TODO:** Call smart contract with returned CID

### Submit Work (IPFS Upload Works!)

1. Browse to a bounty
2. Click "Submit Work"
3. Upload file (txt, md, jpg, png, pdf, docx)
4. Submit → Uploads to IPFS
5. **TODO:** Call contract submitAndEvaluate() with CID

## Integration Points

### Backend API

All API calls go through `src/services/api.js`:

```javascript
import { apiService } from './services/api';

// Upload rubric
const result = await apiService.uploadRubric(rubricJson, classId);

// Upload deliverable
const result = await apiService.uploadDeliverable(bountyId, file);

// Fetch from IPFS
const content = await apiService.fetchFromIPFS(cid);
```

### Smart Contracts

Contract interaction will be added in `src/services/contract.js`:

```javascript
// TODO: Create this file
import { ethers } from 'ethers';
import { walletService } from './wallet';
import { config } from '../config';

export const contractService = {
  async createBounty(rubricCid, payoutAmount, classId) {
    const signer = walletService.getSigner();
    const contract = new ethers.Contract(
      config.bountyEscrowAddress,
      BOUNTY_ABI,
      signer
    );
    const tx = await contract.createBounty(rubricCid, classId, {
      value: ethers.parseEther(payoutAmount)
    });
    return tx.wait();
  }
  // ... more methods
};
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | http://localhost:5000 |
| `VITE_NETWORK` | Network name | base-sepolia |
| `VITE_CHAIN_ID` | Chain ID | 84532 |
| `VITE_BOUNTY_ESCROW_ADDRESS` | Contract address | TBD |
| `VITE_IPFS_GATEWAY` | IPFS gateway | https://ipfs.io |
| `VITE_ENABLE_DEBUG` | Debug logging | false |

## Testing

### Manual Testing

1. **Wallet Connection**
   - ✅ Connect MetaMask
   - ✅ Display address
   - ✅ Switch networks
   - ✅ Disconnect

2. **IPFS Upload**
   - ✅ Create Bounty → Rubric uploaded
   - ✅ Submit Work → File uploaded
   - ✅ Fetch content from IPFS

3. **UI/UX**
   - ✅ Responsive design
   - ✅ Error messages
   - ✅ Loading states
   - ✅ Form validation

### Automated Tests

```bash
# TODO: Set up Vitest + React Testing Library
npm run test
```

## Deployment

### Vercel (Recommended)

```bash
# Build
npm run build

# Deploy
vercel --prod
```

### Netlify

```bash
# Build command
npm run build

# Publish directory
dist
```

### Custom Server

```bash
# Build
npm run build

# Serve with any static server
npx serve -s dist
```

## Next Steps

### Immediate
1. **Test IPFS Integration**
   - Create bounty → Verify rubric uploads
   - Submit work → Verify file uploads
   - Check backend logs

2. **Await Contract Deployment**
   - Get deployed BountyEscrow address
   - Get contract ABI
   - Add to .env

### Short-Term
1. **Add Contract Service**
   - Create `src/services/contract.js`
   - Implement createBounty()
   - Implement submitAndEvaluate()
   - Add LINK approval flow

2. **Implement Blockchain Queries**
   - List bounties from contract
   - Get bounty details
   - Get submission results

3. **Add Advanced Features**
   - Real-time status updates
   - Transaction monitoring
   - Better error messages
   - Loading animations

## Troubleshooting

**MetaMask not connecting:**
- Check if MetaMask is installed
- Refresh page
- Try different browser

**Wrong network:**
- Click wallet address in header
- Should auto-prompt to switch
- Manually switch in MetaMask

**IPFS uploads failing:**
- Check backend server is running
- Verify backend has IPFS credentials
- Check file size < 20 MB

**Build errors:**
- Delete `node_modules` and `package-lock.json`
- Run `npm install` again
- Check Node.js version >=18

## Resources

- [React Documentation](https://react.dev/)
- [Vite Documentation](https://vitejs.dev/)
- [Ethers.js v6](https://docs.ethers.org/v6/)
- [React Router](https://reactrouter.com/)

## License

MIT
