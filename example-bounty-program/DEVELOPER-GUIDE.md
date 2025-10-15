# Verdikta Bounty Program - Developer Guide

**Quick Reference for Development, Testing, and Deployment**

---

## Quick Start Commands

### Backend Development
```bash
cd example-bounty-program/server
npm install
cp .env.example .env        # Add IPFS_PINNING_KEY
npm run dev                 # Start dev server on :5005
npm test                    # Run tests
npm run lint                # Check code quality
```

### Frontend Development
```bash
cd example-bounty-program/client
npm install
cp .env.example .env        # Set VITE_API_URL
npm run dev                 # Start dev server on :5173
npm run build               # Production build
npm run preview             # Preview production build
npm run lint                # Check code quality
```

### Smart Contract Development
```bash
cd example-bounty-program/contracts
npm install
cp .env.example .env        # Add PRIVATE_KEY, RPC_URL
npx hardhat compile         # Compile contracts
npx hardhat test            # Run tests
npx hardhat run deploy/01_deploy_bounty.js --network baseSepolia
```

---

## Environment Setup

### Required Environment Variables

#### Backend (.env)
```bash
# Server
PORT=5005

# IPFS (Required)
IPFS_PINNING_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
# Get from: https://app.pinata.cloud/developers/api-keys

# Blockchain (After contract deployment)
BOUNTY_ESCROW_ADDRESS=0x1234567890123456789012345678901234567890
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
```

#### Frontend (.env)
```bash
# Backend API
VITE_API_URL=http://localhost:5005

# Smart Contract (After deployment)
VITE_BOUNTY_ESCROW_ADDRESS=0x1234567890123456789012345678901234567890
```

#### Contracts (.env)
```bash
# Deployment
PRIVATE_KEY=0xabcd...  # DO NOT COMMIT THIS
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE

# Contract Addresses
VERDIKTA_AGGREGATOR_ADDRESS=0x...  # Existing Verdikta contract
LINK_TOKEN_ADDRESS=0x...  # Base Sepolia LINK token

# Verification (Optional)
BASESCAN_API_KEY=YOUR_BASESCAN_API_KEY
```

---

## Development Workflow

### Starting a New Feature

1. **Read Specifications**
   - Check `PROJECT-OVERVIEW.md` for architecture
   - Review `DESIGN.md` for detailed specs
   - Check `CURRENT-STATE.md` for implementation status

2. **Create Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Implement**
   - Follow existing code patterns
   - Add comprehensive error handling
   - Write JSDoc comments
   - Add logging for debugging

4. **Test**
   - Write unit tests
   - Manual testing
   - Check linter: `npm run lint`

5. **Commit & Push**
   ```bash
   git add .
   git commit -m "feat: description of feature"
   git push origin feature/your-feature-name
   ```

### Testing Workflow

**Before Committing:**
```bash
# Backend
cd server
npm run lint
npm test

# Frontend
cd client
npm run lint
npm run build  # Ensure production build works

# Contracts
cd contracts
npx hardhat compile
npx hardhat test
```

---

## API Reference

### Backend Endpoints

#### Health & Info
```http
GET /health
Response: { "status": "healthy", "timestamp": "..." }

GET /api/classes
Response: { "success": true, "classes": [...] }

GET /api/classes/:classId
Response: { "success": true, "class": {...} }

GET /api/classes/:classId/models
Response: { "success": true, "models": [...], "modelsByProvider": {...} }
```

#### IPFS Operations
```http
POST /api/bounties
Body: { "rubricJson": {...}, "classId": 128 }
Response: { "success": true, "rubricCid": "QmXxx...", "size": 1234 }

POST /api/bounties/:bountyId/submit
Body: multipart/form-data with "file" field
Response: { "success": true, "deliverableCid": "QmYyy...", "filename": "..." }

GET /api/fetch/:cid
Response: Raw content with appropriate Content-Type header

POST /api/rubrics/validate
Body: { "rubric": {...} }
Response: { "valid": true, "errors": [], "warnings": [] }
```

#### Blockchain Queries (After Contract Deployment)
```http
GET /api/bounties
Query: ?status=open&limit=20&offset=0
Response: { "success": true, "bounties": [...], "total": 42 }

GET /api/bounties/:bountyId
Response: { "success": true, "bounty": {...}, "submissions": [...] }

GET /api/bounties/:bountyId/submissions
Response: { "success": true, "submissions": [...] }

GET /api/submissions/:submissionId
Response: { "success": true, "submission": {...} }
```

---

## Frontend Service Patterns

### API Service (client/src/services/api.js)

```javascript
import api from '../services/api';

// Upload rubric to IPFS
const response = await api.uploadRubric(rubricJson, classId);
// Returns: { rubricCid, size, criteriaCount }

// Upload file to IPFS
const response = await api.uploadDeliverable(bountyId, file);
// Returns: { deliverableCid, filename, size }

// Fetch from IPFS
const content = await api.fetchFromIPFS(cid);

// Validate rubric
const result = await api.validateRubric(rubricJson);
// Returns: { valid, errors, warnings }

// Get classes
const classes = await api.listClasses();

// Get class details
const classInfo = await api.getClass(classId);

// Get available models
const models = await api.getClassModels(classId);
```

### Wallet Service (client/src/services/wallet.js)

```javascript
import walletService from '../services/wallet';

// Connect wallet
await walletService.connect();

// Disconnect
walletService.disconnect();

// Get current state
const { isConnected, account, network, chainId } = walletService.getState();

// Switch network
await walletService.switchNetwork('baseSepolia');  // or 'base'

// Get provider/signer
const provider = walletService.getProvider();
const signer = walletService.getSigner();

// Format address
const short = walletService.formatAddress('0x1234...', 6, 4);
// Returns: "0x1234...5678"
```

### Rubric Storage Service (client/src/services/rubricStorage.js)

```javascript
import rubricStorage from '../services/rubricStorage';

// Save rubric
rubricStorage.saveRubric(walletAddress, {
  cid: 'QmXxx...',
  title: 'My Rubric',
  rubricJson: {...}
});

// Get all saved rubrics
const rubrics = rubricStorage.getSavedRubrics(walletAddress);

// Delete rubric
rubricStorage.deleteRubric(walletAddress, cid);

// Increment usage count
rubricStorage.incrementUsageCount(walletAddress, cid);
```

### Contract Service (client/src/services/contract.js) - TO BE IMPLEMENTED

```javascript
import contractService from '../services/contract';

// Create bounty
const { bountyId, txHash } = await contractService.createBounty(
  signer,
  rubricCid,
  classId,
  payoutEth
);

// Submit and evaluate
const { submissionId, txHash } = await contractService.submitAndEvaluate(
  signer,
  bountyId,
  deliverableCid
);

// Get bounty details
const bounty = await contractService.getBounty(provider, bountyId);

// Get submission details
const submission = await contractService.getSubmission(provider, submissionId);

// Cancel bounty
const txHash = await contractService.cancelBounty(signer, bountyId);
```

---

## Smart Contract Patterns

### Reading Data (No Gas)

```javascript
const { ethers } = require('ethers');

// Setup
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contract = new ethers.Contract(address, abi, provider);

// Get bounty
const bounty = await contract.getBounty(bountyId);
console.log(bounty.creator, bounty.payoutAmount, bounty.status);

// Get submission
const submission = await contract.getSubmission(submissionId);
console.log(submission.hunter, submission.score, submission.status);
```

### Writing Data (Requires Gas)

```javascript
// Setup with signer
const signer = new ethers.Wallet(privateKey, provider);
const contract = new ethers.Contract(address, abi, signer);

// Create bounty
const tx = await contract.createBounty(rubricCid, classId, {
  value: ethers.parseEther("0.1")  // 0.1 ETH payout
});
const receipt = await tx.wait();
console.log('Transaction hash:', receipt.hash);

// Extract event data
const event = receipt.logs.find(log => log.fragment?.name === 'BountyCreated');
const bountyId = event.args.bountyId;
```

### Event Listening

```javascript
// Listen for new bounties
contract.on('BountyCreated', (bountyId, creator, payoutAmount, rubricCid) => {
  console.log('New bounty created:', bountyId);
  // Update UI or database
});

// Query past events
const filter = contract.filters.BountyCreated();
const events = await contract.queryFilter(filter, -1000, 'latest');
console.log('Found', events.length, 'bounties in last 1000 blocks');
```

---

## Common Code Patterns

### Error Handling

```javascript
// Backend routes
router.post('/api/endpoint', async (req, res) => {
  try {
    // Validate input
    if (!req.body.required) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field'
      });
    }

    // Process
    const result = await someAsyncOperation();

    // Success response
    res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Operation failed:', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});
```

### React Component Pattern

```javascript
import React, { useState, useEffect } from 'react';
import api from '../services/api';
import './Component.css';

export default function Component() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.fetchSomething();
      setData(result);
    } catch (err) {
      setError(err.message);
      console.error('Failed to load:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div>No data</div>;

  return (
    <div className="component">
      {/* Render data */}
    </div>
  );
}
```

### Form Validation

```javascript
// Frontend validation
const validateForm = () => {
  const errors = [];

  if (!title || title.trim().length === 0) {
    errors.push('Title is required');
  }

  if (payoutAmount <= 0) {
    errors.push('Payout must be greater than 0');
  }

  const weightSum = criteria.reduce((sum, c) => sum + (c.must ? 0 : c.weight), 0);
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push(`Weights must sum to 1.00 (currently ${weightSum.toFixed(2)})`);
  }

  if (errors.length > 0) {
    setError(errors.join('. '));
    return false;
  }

  return true;
};
```

---

## Testing Patterns

### Backend Unit Tests (Jest)

```javascript
const request = require('supertest');
const app = require('../server');

describe('API Endpoints', () => {
  it('should return health status', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body.status).toBe('healthy');
  });

  it('should validate rubric', async () => {
    const rubric = {
      threshold: 82,
      criteria: [
        { id: 'test', must: false, weight: 1.0, description: 'Test' }
      ]
    };

    const response = await request(app)
      .post('/api/rubrics/validate')
      .send({ rubric })
      .expect(200);

    expect(response.body.valid).toBe(true);
  });
});
```

### Smart Contract Tests (Hardhat)

```javascript
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('BountyEscrow', () => {
  let bountyEscrow, owner, hunter;

  beforeEach(async () => {
    [owner, hunter] = await ethers.getSigners();
    const BountyEscrow = await ethers.getContractFactory('BountyEscrow');
    bountyEscrow = await BountyEscrow.deploy(verdiktaAddress, linkAddress);
  });

  it('should create a bounty', async () => {
    const rubricCid = 'QmXxx...';
    const classId = 128;
    const payoutAmount = ethers.parseEther('0.1');

    const tx = await bountyEscrow.createBounty(rubricCid, classId, {
      value: payoutAmount
    });

    await expect(tx)
      .to.emit(bountyEscrow, 'BountyCreated')
      .withArgs(1, owner.address, payoutAmount, rubricCid, classId);

    const bounty = await bountyEscrow.getBounty(1);
    expect(bounty.creator).to.equal(owner.address);
    expect(bounty.payoutAmount).to.equal(payoutAmount);
    expect(bounty.status).to.equal(0); // Open
  });

  it('should not allow cancellation before 24 hours', async () => {
    await bountyEscrow.createBounty('QmXxx...', 128, {
      value: ethers.parseEther('0.1')
    });

    await expect(
      bountyEscrow.cancelBounty(1)
    ).to.be.revertedWith('Cancellation locked for 24 hours');
  });
});
```

---

## Debugging Tips

### Backend Debugging

**Enable Verbose Logging:**
```javascript
// server/utils/logger.js
logger.level = 'debug';  // Shows all debug messages
```

**Check Logs:**
```bash
cd server
tail -f logs/app.log  # Watch logs in real-time
```

**Common Issues:**
- IPFS upload fails → Check `IPFS_PINNING_KEY` in .env
- CORS errors → Check `server.js` CORS configuration
- Port in use → Kill process: `lsof -i :5005 && kill -9 <PID>`

### Frontend Debugging

**React DevTools:**
- Install React Developer Tools extension
- Inspect component state and props
- Check performance with Profiler

**Console Logging:**
```javascript
console.log('State:', state);
console.log('API response:', response);
```

**Network Tab:**
- Open browser DevTools → Network
- Check API calls (XHR/Fetch)
- Verify request/response data

**Common Issues:**
- White screen → Check console for errors
- API call fails → Check backend is running, check CORS
- MetaMask issues → Refresh page, check network

### Smart Contract Debugging

**Hardhat Console:**
```bash
npx hardhat console --network baseSepolia
```

**Contract Events:**
```javascript
// Listen to all events
const events = await contract.queryFilter('*');
console.log(events);
```

**Revert Reasons:**
```javascript
try {
  await contract.someFunction();
} catch (error) {
  console.log('Revert reason:', error.reason || error.message);
}
```

---

## Deployment

### Backend Deployment (Render/Heroku)

**Prepare:**
```bash
cd server
npm run build  # If using TypeScript
```

**Environment Variables (Set in hosting dashboard):**
- `PORT` (usually auto-set)
- `IPFS_PINNING_KEY`
- `BOUNTY_ESCROW_ADDRESS`
- `RPC_URL`
- `NODE_ENV=production`

**Deploy:**
- Push to GitHub
- Connect repository in Render/Heroku
- Auto-deploys on push to main

### Frontend Deployment (Vercel/Netlify)

**Build:**
```bash
cd client
npm run build
# Output in dist/
```

**Environment Variables (Set in hosting dashboard):**
- `VITE_API_URL` (deployed backend URL)
- `VITE_BOUNTY_ESCROW_ADDRESS`

**Deploy:**
- Connect GitHub repository
- Set build command: `npm run build`
- Set output directory: `dist`
- Auto-deploys on push

### Smart Contract Deployment

**Compile:**
```bash
cd contracts
npx hardhat compile
```

**Deploy:**
```bash
# Testnet
npx hardhat run deploy/01_deploy_bounty.js --network baseSepolia

# Mainnet (when ready)
npx hardhat run deploy/01_deploy_bounty.js --network base
```

**Verify:**
```bash
npx hardhat verify --network baseSepolia DEPLOYED_ADDRESS \
  VERDIKTA_ADDRESS LINK_ADDRESS
```

**Save Deployment Info:**
```json
{
  "network": "baseSepolia",
  "address": "0x...",
  "deployer": "0x...",
  "timestamp": "2025-10-14T...",
  "txHash": "0x...",
  "blockNumber": 123456
}
```

---

## Performance Optimization

### Backend

- Enable compression: `app.use(compression())`
- Cache IPFS fetches (Redis or in-memory)
- Rate limit API endpoints
- Use connection pooling for RPC
- Index contract events in database

### Frontend

- Lazy load components: `React.lazy()`
- Memoize expensive computations: `useMemo()`
- Debounce user inputs
- Optimize bundle size: `npm run build -- --analyze`
- Cache wallet state in sessionStorage

### Smart Contracts

- Batch operations where possible
- Use events for off-chain indexing
- Minimize storage writes
- Use `calldata` instead of `memory` for external functions
- Consider L2 solutions for lower gas

---

## Security Checklist

### Backend

- [ ] Validate all inputs
- [ ] Sanitize file uploads
- [ ] Rate limit endpoints
- [ ] Use HTTPS in production
- [ ] Set secure CORS policy
- [ ] Don't expose sensitive errors
- [ ] Keep dependencies updated
- [ ] Use environment variables for secrets

### Frontend

- [ ] Validate user inputs
- [ ] Sanitize displayed data
- [ ] Use Content Security Policy
- [ ] Verify contract addresses
- [ ] Show transaction details before signing
- [ ] Handle wallet disconnection
- [ ] Don't trust client-side data

### Smart Contracts

- [ ] Use OpenZeppelin libraries
- [ ] Implement ReentrancyGuard
- [ ] Use SafeERC20 for token transfers
- [ ] Follow Checks-Effects-Interactions
- [ ] Add access control
- [ ] Emit events for state changes
- [ ] Test edge cases thoroughly
- [ ] Get security audit (for mainnet)

---

## Useful Resources

### Documentation
- **Ethers.js v6:** https://docs.ethers.org/v6/
- **Hardhat:** https://hardhat.org/docs
- **React:** https://react.dev/
- **Vite:** https://vitejs.dev/
- **Pinata:** https://docs.pinata.cloud/

### Tools
- **Base Sepolia Explorer:** https://sepolia.basescan.org/
- **Base Sepolia Faucet:** https://www.alchemy.com/faucets/base-sepolia
- **LINK Faucet:** https://faucets.chain.link/
- **ABI Encoder:** https://abi.hashex.org/

### Example Code
- **Example Frontend:** `../example-frontend/`
- **Verdikta Common:** `node_modules/@verdikta/common/`
- **OpenZeppelin:** `node_modules/@openzeppelin/contracts/`

---

## Keyboard Shortcuts (VSCode)

- `Cmd/Ctrl + P` - Quick file open
- `Cmd/Ctrl + Shift + F` - Search in all files
- `Cmd/Ctrl + /` - Toggle comment
- `Cmd/Ctrl + D` - Select next occurrence
- `Cmd/Ctrl + Shift + L` - Select all occurrences
- `Alt + Click` - Multiple cursors
- `F12` - Go to definition
- `Shift + F12` - Find all references

---

## Git Best Practices

### Commit Message Format
```
<type>: <description>

[optional body]

[optional footer]
```

**Types:**
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `style:` Formatting
- `refactor:` Code restructuring
- `test:` Adding tests
- `chore:` Maintenance

**Examples:**
```bash
git commit -m "feat: add jury configuration UI"
git commit -m "fix: resolve IPFS upload timeout"
git commit -m "docs: update API documentation"
```

### Branching Strategy

- `main` - Production-ready code
- `develop` - Integration branch
- `feature/name` - New features
- `fix/name` - Bug fixes
- `hotfix/name` - Urgent production fixes

---

**Happy coding! 🚀**

---

**Document Version:** 1.0  
**Last Updated:** October 14, 2025

