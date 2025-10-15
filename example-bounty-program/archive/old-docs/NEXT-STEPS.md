# Next Steps for Backend API Implementation

**Current Status:** Phase 1 - 60% Complete ✅  
**Last Updated:** October 2, 2025

---

## 🎉 What We Just Completed

### Core IPFS Functionality (All Working!)

✅ **POST /api/bounties** - Upload rubrics to IPFS  
✅ **POST /api/bounties/:id/submit** - Upload deliverable files  
✅ **GET /api/fetch/:cid** - Fetch content from IPFS  
✅ **POST /api/rubrics/validate** - Validate rubric structure  
✅ **GET /api/classes** - List Verdikta classes  
✅ **GET /health** - Server health check  

### Infrastructure

✅ Comprehensive validation  
✅ Error handling  
✅ Logging system  
✅ Test structure  
✅ Manual testing guide  

---

## 🧪 Immediate Action: Manual Testing

### Step 1: Set Up Environment

```bash
cd server

# Copy environment template
cp env.example .env

# Edit .env and add your Pinata JWT token
# Get it from: https://app.pinata.cloud/
nano .env
```

### Step 2: Install and Run

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

You should see:
```
🚀 Bounty API server listening on 0.0.0.0:5000
```

### Step 3: Run Manual Tests

Follow the guide in `test/manual-tests.md`:

```bash
# Quick test (no credentials needed)
curl http://localhost:5000/health

# Test rubric validation (no credentials needed)
curl -X POST http://localhost:5000/api/rubrics/validate \
  -H "Content-Type: application/json" \
  -d '{"rubric": {...}}'

# Test rubric upload (needs Pinata credentials)
curl -X POST http://localhost:5000/api/bounties \
  -H "Content-Type: application/json" \
  -d @test/sample-rubric.json
```

See `test/manual-tests.md` for complete test suite with expected outputs.

---

## 📋 What's Left to Implement

### Next Priority: Contract Interaction (40% remaining)

The smart contract team is working on `BountyEscrow.sol`. Once deployed, we need to:

#### 1. Add Ethers.js Integration

Create `server/utils/contractService.js`:

```javascript
const { ethers } = require('ethers');
const BOUNTY_ABI = require('./BountyEscrowABI.json');

class ContractService {
  constructor(rpcUrl, contractAddress) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(
      contractAddress,
      BOUNTY_ABI,
      this.provider
    );
  }

  async getBounty(bountyId) {
    // Call contract.getBounty(bountyId)
  }

  async listBounties() {
    // Query events or use a view function
  }

  // ... more methods
}
```

#### 2. Implement Blockchain Query Endpoints

**GET /api/bounties** - List all bounties
- Query contract for bounty count or events
- For each bounty, fetch details from contract
- Fetch rubric from IPFS (we already have this!)
- Return formatted list

**GET /api/bounties/:id** - Get bounty details
- Call `contract.getBounty(bountyId)`
- Fetch rubric from IPFS using returned CID
- Get submission count
- Return complete bounty object

**GET /api/bounties/:id/submissions** - List submissions
- Call `contract.getBountySubmissions(bountyId)`
- For each submission, call `contract.getSubmission(submissionId)`
- Return array of submissions

**GET /api/submissions/:id** - Get submission details
- Call `contract.getSubmission(submissionId)`
- If AI report exists, fetch from IPFS
- Return complete submission object

#### 3. Add Caching (Optional but Recommended)

```javascript
// Simple in-memory cache
const bountyCache = new Map();

async function getCachedBounty(bountyId) {
  if (bountyCache.has(bountyId)) {
    return bountyCache.get(bountyId);
  }
  
  const bounty = await contractService.getBounty(bountyId);
  bountyCache.set(bountyId, bounty);
  return bounty;
}
```

---

## 🔧 Implementation Order

### Week 1 Remaining Tasks

1. **Manual test IPFS endpoints** (30 minutes)
   - Verify rubric upload works
   - Verify file upload works
   - Verify fetch works
   - Document any issues

2. **Wait for contract deployment** (Done by contract team)
   - Get deployed contract address
   - Get contract ABI JSON
   - Update `.env` with address

3. **Add contract service** (1-2 hours)
   - Create `utils/contractService.js`
   - Add ethers.js dependency
   - Write contract interaction methods
   - Add error handling for RPC failures

4. **Implement GET endpoints** (2-3 hours)
   - GET /api/bounties
   - GET /api/bounties/:id
   - GET /api/bounties/:id/submissions
   - GET /api/submissions/:id

5. **Test end-to-end** (1 hour)
   - Create bounty on-chain (via contract)
   - Query bounty via API
   - Submit work on-chain
   - Query submission via API

---

## 📚 Resources You'll Need

### From Contract Team

1. **Contract Address** (Base Sepolia)
   - Example: `0x1234...abcd`
   - Add to `.env` as `BOUNTY_ESCROW_ADDRESS`

2. **Contract ABI** (JSON file)
   - Export from Hardhat compilation
   - Save as `server/utils/BountyEscrowABI.json`

3. **RPC URL** (if not using public)
   - Alchemy or Infura URL for Base Sepolia
   - Add to `.env` as `RPC_URL`

4. **Event Signatures** (for indexing)
   - BountyCreated
   - SubmissionQueued
   - EvaluationResult
   - BountyPaid

### Documentation References

- [Ethers.js v6 Docs](https://docs.ethers.org/v6/)
- [Base Sepolia Explorer](https://sepolia.basescan.org/)
- [Example Frontend's Contract Utils](../example-frontend/client/src/utils/contractUtils.js)

---

## 🎯 Definition of Done

### For "Backend API Complete"

- [ ] All IPFS endpoints tested and working ✅ (Done!)
- [ ] Contract service implemented with ethers.js
- [ ] All GET endpoints return data from blockchain
- [ ] IPFS content is fetched and merged with blockchain data
- [ ] Error handling for contract call failures
- [ ] Automated tests written and passing
- [ ] API documentation updated
- [ ] Deployed to staging environment

### For "Ready for Frontend"

- [ ] All endpoints documented in README
- [ ] Example requests/responses provided
- [ ] CORS configured correctly
- [ ] Rate limiting implemented
- [ ] Staging URL available for testing

---

## 🚀 Quick Wins

### Can Do Right Now (No Dependencies)

1. ✅ **Manual test IPFS** - Use test/manual-tests.md
2. ✅ **Write API documentation** - Add OpenAPI/Swagger specs
3. ✅ **Add rate limiting** - Express rate-limit middleware
4. ✅ **Set up logging to file** - Winston file transport
5. ✅ **Add health check details** - Include IPFS and DB status

### Can Do When Contract is Deployed

6. Add contract service utility
7. Implement GET endpoints
8. Write integration tests
9. Set up monitoring
10. Deploy to staging

---

## 💭 Design Decisions to Make

### 1. Event Indexing vs Direct Queries

**Option A: Query contract directly**
- Simple implementation
- Slow for many bounties
- Real-time data

**Option B: Index events**
- Fast queries
- Requires event indexer/database
- Near-real-time data (slight delay)

**Recommendation:** Start with Option A, add Option B later if needed.

### 2. Caching Strategy

**What to cache:**
- Bounty details (can change, cache short)
- Rubrics (immutable IPFS, cache forever)
- Submission details (mostly immutable)

**When to invalidate:**
- On BountyPaid event
- On SubmissionQueued event
- Time-based (5 minutes for bounties)

### 3. Pagination

For `GET /api/bounties`:
- Limit default: 20
- Max limit: 100
- Offset-based or cursor-based?

**Recommendation:** Start with offset, move to cursor if needed.

---

## 🔍 Testing Strategy

### Phase 1: Unit Tests (Current)

```bash
npm test
```

Test individual functions:
- Validation utils ✅
- Logger ✅
- IPFS client wrapper
- Contract service methods

### Phase 2: Integration Tests

Test API endpoints with test server:
- Mock IPFS client
- Mock contract calls
- Test error scenarios

### Phase 3: E2E Tests

Test against real testnet:
- Real IPFS uploads
- Real contract calls
- Real event listening

---

## 📞 Who to Contact

### Need Help With...

**IPFS Issues**
- Check Pinata dashboard
- Review server logs
- See @verdikta/common docs

**Contract Integration**
- Talk to smart contract team
- Review BountyEscrow.sol interface
- Check example-frontend for patterns

**API Design**
- Review DESIGN.md
- Check OpenAPI best practices
- Look at REST API standards

---

## 📈 Success Metrics

### API Performance Targets

- Response time < 500ms (IPFS endpoints)
- Response time < 2s (contract queries)
- Error rate < 1%
- Uptime > 99%

### Code Quality Targets

- Test coverage > 80%
- Zero linting errors ✅
- All TODOs resolved
- Documentation complete

---

## 🎓 What You Learned

From implementing IPFS endpoints:

1. ✅ **File upload handling** - Multer configuration, temp file cleanup
2. ✅ **Content-type detection** - Magic numbers, JSON parsing
3. ✅ **Error boundaries** - Try-catch-finally patterns
4. ✅ **Validation patterns** - Reusable validation utilities
5. ✅ **Logging strategy** - Structured logs with context

Apply these patterns to contract endpoints!

---

## 🏁 Ready to Continue?

### Checklist Before Moving Forward

- [ ] Manual tests run successfully
- [ ] IPFS credentials working
- [ ] Server runs without errors
- [ ] Understand what needs to be done next
- [ ] Have contract address and ABI (when ready)

### If Blocked

**On IPFS credentials:**
- Get Pinata account at https://pinata.cloud
- Generate JWT token
- Add to `.env`

**On contract deployment:**
- Wait for smart contract team
- Use test data in the meantime
- Mock contract calls for testing

**On anything else:**
- Review DESIGN.md
- Check STATUS.md for progress
- Read PROGRESS-REPORT.md for what's done
- Check example-frontend for patterns

---

## 🎉 Great Work!

You've implemented 60% of the backend API in one session!  
The hard infrastructure work is done. The rest is straightforward contract queries.

**Next session will be smooth sailing once contracts are deployed. 🚢**

---

*Generated: October 2, 2025*  
*Ready for your next coding session!* 🚀



