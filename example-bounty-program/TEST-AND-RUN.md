# 🧪 Test & Run Guide

**Quick guide to test what's working right now!**

---

## 🎯 What You Can Test Today

### ✅ Working (No Smart Contracts Needed)

1. **Backend API** - IPFS upload/fetch
2. **Frontend UI** - All pages, wallet connection
3. **Full IPFS Flow** - Upload rubric → Upload file → Fetch content

---

## Step-by-Step Testing

### Part 1: Backend API (5 minutes)

```bash
# Terminal 1: Start backend server
cd example-bounty-program/server
npm install
cp .env.example .env
# Edit .env and add your IPFS_PINNING_KEY from Pinata
npm run dev
```

You should see:
```
🚀 Bounty API server listening on 0.0.0.0:5005
```

```bash
# Terminal 2: Run tests
cd example-bounty-program/server
./test/run-tests.sh
```

**Expected Results:**
- ✅ Health check passes
- ✅ Classes API works
- ✅ Rubric validation works
- ✅ Rubric uploads to IPFS (if credentials set)
- ✅ File uploads to IPFS (if credentials set)
- ✅ Content fetches from IPFS

---

### Part 2: Frontend UI (10 minutes)

```bash
# Terminal 3: Start frontend
cd example-bounty-program/client
npm install
cp .env.example .env
# Edit .env: Set VITE_API_URL=http://localhost:5005
npm run dev
```

Opens at `http://localhost:5173`

**Test Wallet Connection:**
1. Click "Connect Wallet" in header
2. Approve in MetaMask
3. ✅ Should show your address
4. ✅ Should show "Base Sepolia" network
5. Try disconnecting → ✅ Should work

**Test Create Bounty:**
1. Navigate to "Create Bounty"
2. Fill in:
   - Title: "Test Bounty"
   - Description: "Testing the system"
   - Payout: "0.01"
   - Leave criteria as default
3. Click "Create Bounty"
4. ✅ Should upload rubric to IPFS
5. ✅ Should show success alert with CID
6. Check browser console for CID

**Test Submit Work:**
1. Navigate to "Submit Work" (any bounty ID works, e.g., /bounty/1/submit)
2. Click file input, select `server/test/sample-essay.md`
3. ✅ Should show file preview
4. Click "Submit Work"
5. ✅ Should upload to IPFS
6. ✅ Should show success with CID

---

### Part 3: End-to-End IPFS Flow (5 minutes)

**Full workflow test:**

1. **Create Bounty** → Get rubric CID (e.g., `QmAbc123...`)
2. **Copy CID** from success message
3. **Open new tab**: `http://localhost:5005/api/fetch/QmAbc123...`
4. ✅ Should display rubric JSON

5. **Submit Work** → Get deliverable CID (e.g., `QmDef456...`)
6. **Copy CID** from success message
7. **Open new tab**: `http://localhost:5005/api/fetch/QmDef456...`
8. ✅ Should display file content

**This proves IPFS is working perfectly!** 🎉

---

## 🔍 What to Look For

### Backend Logs (Terminal 1)

```
[INFO] POST /api/bounties called { criteriaCount: 2, threshold: 82, classId: 128 }
[INFO] Rubric uploaded to IPFS successfully { cid: 'QmXxxxxx...', size: 1234 }
```

### Frontend Console (Browser DevTools)

```
🌐 API Request: POST /api/bounties
✅ API Response: 200 /api/bounties
Rubric uploaded to IPFS: QmXxxxxx...
```

### MetaMask

- Should prompt to connect on first "Connect Wallet"
- Should prompt to switch network if wrong chain
- Should show connected address in header

---

## ❌ What Won't Work Yet (Needs Smart Contracts)

1. **List Bounties** - Needs contract deployment
2. **View Bounty Details** - Needs contract queries
3. **Submit On-Chain** - Needs submitAndEvaluate() contract call
4. **See Evaluation Results** - Needs Verdikta integration
5. **Receive Payout** - Needs contract payout logic

**These will work immediately once contracts are deployed!**

---

## 🐛 Troubleshooting

### "Server is not running"
```bash
cd example-bounty-program/server
npm run dev
```

### "IPFS uploads failing"
- Check `.env` has `IPFS_PINNING_KEY`
- Get JWT from https://app.pinata.cloud/
- Verify you have storage quota

### "MetaMask not connecting"
- Check MetaMask is installed
- Refresh page
- Try incognito mode
- Check browser console for errors

### "Wrong network" warning
- Click wallet address
- Should auto-prompt to switch
- Or manually switch in MetaMask

### "File upload rejected"
- Check file is < 20 MB
- Check file type (txt, md, jpg, png, pdf, docx)
- Check server logs for details

---

## ✅ Success Checklist

Test everything and check off:

**Backend:**
- [ ] Server starts without errors
- [ ] Health check returns "healthy"
- [ ] Classes API returns list
- [ ] Rubric validation works (with sample-rubric.json)
- [ ] Rubric uploads to IPFS (returns CID)
- [ ] Can fetch uploaded rubric by CID
- [ ] File uploads to IPFS (returns CID)
- [ ] Can fetch uploaded file by CID

**Frontend:**
- [ ] Loads at localhost:5173
- [ ] MetaMask connects
- [ ] Network switches to Base Sepolia
- [ ] Address displays in header
- [ ] Home page renders
- [ ] Create Bounty page works
- [ ] Submit Work page works
- [ ] Forms validate inputs
- [ ] Loading states show
- [ ] Error messages are clear

**Integration:**
- [ ] Frontend can upload rubric via backend
- [ ] Frontend can upload file via backend
- [ ] Browser can fetch IPFS content
- [ ] All API calls succeed
- [ ] No console errors

---

## 📊 Expected Test Results

### Without IPFS Credentials

```
✅ Health check
✅ Classes API
✅ Rubric validation (valid)
✅ Rubric validation (invalid - should fail)
✅ Invalid CID rejection
⚠️  Rubric upload (skipped - no credentials)
⚠️  File upload (skipped - no credentials)
⚠️  IPFS fetch (skipped - no CID)
```

### With IPFS Credentials

```
✅ Health check
✅ Classes API  
✅ Rubric validation (valid)
✅ Rubric validation (invalid)
✅ Invalid CID rejection
✅ Rubric upload → Get CID
✅ Fetch rubric by CID
✅ File upload → Get CID
✅ Fetch file by CID
```

---

## 🚀 Quick Start (TL;DR)

```bash
# Backend (with IPFS credentials)
cd server
npm install && cp .env.example .env
# Add IPFS_PINNING_KEY to .env
npm run dev

# Frontend (separate terminal)
cd client
npm install && cp .env.example .env
npm run dev

# Open browser: http://localhost:5173
# Click "Connect Wallet" → Create Bounty → Success! 🎉
```

---

## 📝 Next Steps After Testing

1. ✅ **Verify IPFS works** - Upload rubric, upload file, fetch both
2. ✅ **Test wallet integration** - Connect, switch networks, disconnect
3. ✅ **UI/UX check** - Navigate all pages, check responsive design
4. ⏳ **Wait for contracts** - Smart contract team deploys BountyEscrow
5. ⏳ **Integration session** - Connect frontend/backend to contracts
6. ⏳ **Full E2E test** - Complete user flow with real transactions

---

## 🎉 You're Ready!

Everything is set up and **ready to test**. The MVP is 85% complete with only smart contract integration remaining.

**Happy testing!** 🚀

---

*Last Updated: October 2, 2025*

