# Backend API Testing

## Quick Test (No IPFS Credentials Needed)

Tests validation and non-IPFS endpoints:

```bash
cd server

# Start server in one terminal
npm run dev

# In another terminal, run tests
./test/run-tests.sh
```

**Expected Results:**
- ✅ Health check
- ✅ List classes
- ✅ Valid rubric validation
- ✅ Invalid rubric rejection
- ✅ Invalid CID rejection
- ⚠️ IPFS tests skipped (no credentials)

---

## Full Test (With IPFS Credentials)

1. **Get Pinata JWT:**
   - Go to https://app.pinata.cloud/
   - Sign up/login
   - Create API key with admin permissions
   - Copy the JWT token

2. **Configure:**
   ```bash
   cd server
   cp env.example .env
   # Edit .env and add: IPFS_PINNING_KEY=your_jwt_token_here
   ```

3. **Run tests:**
   ```bash
   npm run dev  # In one terminal
   ./test/run-tests.sh  # In another terminal
   ```

**Expected Results:**
- ✅ All 9 tests pass
- ✅ Rubric uploads to IPFS
- ✅ Rubric can be fetched
- ✅ Deliverable uploads to IPFS
- ✅ Deliverable can be fetched

---

## Test Files

- `sample-rubric.json` - Valid rubric for testing
- `sample-essay.md` - Sample deliverable file
- `run-tests.sh` - Automated test script
- `manual-tests.md` - Manual curl commands

---

## Individual Endpoint Tests

### Without Credentials

```bash
# Health check
curl http://localhost:5000/health

# List classes
curl http://localhost:5000/api/classes

# Validate rubric
curl -X POST http://localhost:5000/api/rubrics/validate \
  -H "Content-Type: application/json" \
  -d @test/sample-rubric.json
```

### With Credentials

```bash
# Upload rubric
curl -X POST http://localhost:5000/api/bounties \
  -H "Content-Type: application/json" \
  -d @test/sample-rubric.json

# Upload deliverable
curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@test/sample-essay.md"

# Fetch content (replace CID)
curl http://localhost:5000/api/fetch/QmXxxxxx
```

---

## Troubleshooting

**Server not starting:**
- Check .env file exists
- Verify PORT is not in use
- Run `npm install`

**IPFS tests failing:**
- Verify IPFS_PINNING_KEY is correct
- Check Pinata account has storage
- Wait a few seconds for IPFS propagation

**Tests timing out:**
- IPFS can be slow (30s timeout set)
- Check your internet connection
- Try again - gateway issues are common

---

## What's Tested

✅ **Server Health** - Basic connectivity  
✅ **Validation** - Rubric structure validation  
✅ **Classes API** - Verdikta class information  
✅ **IPFS Upload** - Rubric and file uploads  
✅ **IPFS Fetch** - Content retrieval  
✅ **Error Handling** - Invalid inputs handled gracefully  

---

## What's NOT Tested (Requires Smart Contracts)

⏳ **GET /api/bounties** - List bounties  
⏳ **GET /api/bounties/:id** - Bounty details  
⏳ **GET /api/submissions/:id** - Submission details  

These will be tested once contracts are deployed.



