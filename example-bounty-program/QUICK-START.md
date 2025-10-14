# Quick Start Guide

## What's New

This implementation adds a complete job management system that generates Verdikta-compatible multi-CID archives for testing before smart contracts are deployed.

## Key Features

✅ **Create Jobs** with bounty amounts, thresholds, and custom rubrics  
✅ **Browse & Search** jobs with filters  
✅ **Submit Work** and get CIDs for testing with example-frontend  
✅ **Full IPFS integration** with proper archive formats  
✅ **ETH/USD conversion** for bounty amounts  
✅ **Submission windows** with time tracking  

## 5-Minute Setup

### 1. Backend Setup
```bash
cd example-bounty-program/server
npm install
echo "IPFS_PINNING_KEY=your_pinata_jwt" > .env
echo "PORT=5000" >> .env
npm run dev
```

### 2. Frontend Setup
```bash
cd example-bounty-program/client
npm install
echo "VITE_API_URL=http://localhost:5000" > .env
npm run dev
```

### 3. Test the Workflow

**Create a Job:**
1. Open http://localhost:5173
2. Connect MetaMask
3. Go to "Create Bounty"
4. Fill in details (Title, Description, 0.01 ETH, etc.)
5. Set threshold to 80%
6. Submit → Get Job ID and CIDs

**Browse Jobs:**
1. Go to Home page
2. See your job listed
3. Try filters: search, status, minimum ETH

**Submit Work:**
1. Click on your job
2. Click "Submit Work"
3. Upload a test file (e.g., blog-post.txt)
4. Get CID dialog with:
   - Hunter Submission CID
   - Updated Primary CID
   - Evaluation format: `PRIMARY_CID,HUNTER_CID`

**Test with example-frontend:**
1. Copy evaluation format from dialog
2. Go to example-frontend "Run Query" page
3. Paste: `PRIMARY_CID,HUNTER_CID`
4. Submit for evaluation
5. Wait 1-5 minutes for AI jury result

## What Gets Generated

### Primary CID Archive
```
primary-archive.zip
├── manifest.json          # Jury config, rubric ref, hunter CID
└── primary_query.json     # Evaluation instructions
```

### Hunter CID Archive
```
hunter-archive.zip
├── manifest.json          # Work product references
├── primary_query.json     # Submission message
└── submission/
    └── your-work.txt      # Uploaded work product
```

These match the format tested in:
`/verdikta-arbiter/external-adapter/test-artifacts/blog-post-test/`

## Key Files

### Backend
- `server/utils/archiveGenerator.js` - Creates ZIP archives
- `server/utils/jobStorage.js` - Local job database
- `server/routes/jobRoutes.js` - Job API endpoints
- `server/data/jobs.json` - Job storage (auto-created)

### Frontend
- `client/src/pages/CreateBounty.jsx` - Job creation
- `client/src/pages/Home.jsx` - Job browsing
- `client/src/pages/BountyDetails.jsx` - Job details
- `client/src/pages/SubmitWork.jsx` - Work submission + CID dialog
- `client/src/services/api.js` - API methods

## API Endpoints

```
POST   /api/jobs/create              # Create job
GET    /api/jobs                     # List jobs
GET    /api/jobs/:jobId              # Get job details
POST   /api/jobs/:jobId/submit       # Submit work
GET    /api/jobs/:jobId/submissions  # Get submissions
```

## Data Flow

```
1. Job Creation
   ┌──────────────┐
   │ Create Job   │
   │ (Frontend)   │
   └──────┬───────┘
          │
          ↓
   ┌──────────────────┐
   │ Upload Rubric    │ → IPFS → RUBRIC_CID
   │ Generate Primary │ → IPFS → PRIMARY_CID
   │ Store Job        │ → jobs.json
   └──────────────────┘

2. Work Submission
   ┌──────────────┐
   │ Submit Work  │
   │ (Frontend)   │
   └──────┬───────┘
          │
          ↓
   ┌──────────────────┐
   │ Upload File      │ → IPFS → (internal)
   │ Create Hunter    │ → IPFS → HUNTER_CID
   │ Update Primary   │ → IPFS → UPDATED_PRIMARY_CID
   │ Add Submission   │ → jobs.json
   └──────┬───────────┘
          │
          ↓
   ┌──────────────────┐
   │ Display CIDs     │
   │ for Testing      │
   └──────────────────┘

3. Testing (with example-frontend)
   ┌──────────────────────┐
   │ UPDATED_PRIMARY_CID, │
   │ HUNTER_CID           │
   └──────┬───────────────┘
          │
          ↓
   ┌──────────────────┐
   │ Verdikta         │
   │ Aggregator       │
   └──────┬───────────┘
          │
          ↓
   ┌──────────────────┐
   │ FUND/DONT_FUND   │
   │ + Justification  │
   └──────────────────┘
```

## Troubleshooting

**Backend won't start:**
```bash
npm install
# Check .env file exists with IPFS_PINNING_KEY
```

**IPFS upload fails:**
```bash
# Verify Pinata key:
curl -X POST https://api.pinata.cloud/data/testAuthentication \
  -H "Authorization: Bearer YOUR_JWT"
```

**Frontend can't connect:**
```bash
# Check .env has correct API URL
cat client/.env
# Should be: VITE_API_URL=http://localhost:5000
```

**No jobs showing:**
```bash
# Check jobs.json exists and has data
cat server/data/jobs.json
```

## Next Steps

1. **Test the workflow** - Create a job, browse, submit work
2. **Get CIDs** - Use the CID dialog to copy evaluation format
3. **Test with example-frontend** - Verify AI evaluation works
4. **Review archives** - Inspect generated ZIP files in `server/tmp/`
5. **Read full docs** - See TESTING-GUIDE.md and IMPLEMENTATION-SUMMARY.md

## Integration Checklist (For Smart Contracts)

When BountyEscrow is ready:

- [ ] Replace `apiService.createJob()` with contract call
- [ ] Replace `apiService.submitWork()` with contract call
- [ ] Add ETH escrow locking
- [ ] Add LINK fee payment
- [ ] Add Verdikta callback handling
- [ ] Add winner payment logic
- [ ] Keep CID generation (already working!)

The current implementation generates all necessary CIDs and archives, so smart contract integration will be straightforward.

## Important Notes

✅ **Threshold is separate** - Not stored in rubric, matches recent change  
✅ **Same rubric, different jobs** - Rubric CID can be reused with different thresholds  
✅ **Archive format matches** - Compatible with blog-post-test example  
✅ **Ready for contracts** - All IPFS functionality working  

## Questions?

- Check [TESTING-GUIDE.md](TESTING-GUIDE.md) for detailed testing
- Check [IMPLEMENTATION-SUMMARY.md](IMPLEMENTATION-SUMMARY.md) for technical details
- Check [README.md](README.md) for project overview
- Check [DESIGN.md](DESIGN.md) for architecture details

