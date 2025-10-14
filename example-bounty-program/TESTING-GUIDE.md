# Testing Guide: Job Creation and Submission Workflow

## Overview
This guide walks you through testing the complete job creation and submission workflow without deployed smart contracts. The system generates Verdikta-compatible IPFS archives that can be tested with the example-frontend application.

## Prerequisites
- Node.js ≥18 installed
- MetaMask wallet installed and configured
- IPFS Pinata API key (get from https://pinata.cloud)

## Setup

### 1. Start the Backend Server

```bash
cd example-bounty-program/server
npm install
npm install adm-zip  # If not already installed
cp .env.example .env
```

Edit `.env` and add your Pinata credentials:
```env
IPFS_PINNING_SERVICE=https://api.pinata.cloud
IPFS_PINNING_KEY=your_pinata_jwt_token_here
PORT=5000
```

Start the server:
```bash
npm run dev
```

Server should be running on `http://localhost:5000`

### 2. Start the Frontend Client

```bash
cd example-bounty-program/client
npm install
cp .env.example .env
```

Edit `.env`:
```env
VITE_API_URL=http://localhost:5000
```

Start the client:
```bash
npm run dev
```

Client should be running on `http://localhost:5173`

## Testing Workflow

### Part 1: Create a Job (Bounty Owner)

1. **Open the app** in your browser: `http://localhost:5173`

2. **Connect your wallet** using the "Connect Wallet" button

3. **Navigate to "Create Bounty"**

4. **Fill in Job Details:**
   - Title: "Blog Post for Verdikta.org"
   - Description: "Write a compelling blog post about AI in dispute resolution"
   - Work Product Type: "Blog Post"
   - Payout Amount: 0.1 ETH (you'll see USD equivalent)
   - Submission Window: 24 hours (default)

5. **Configure AI Jury:**
   - Class ID: 128 (frontier models)
   - Add AI models (e.g., GPT-5, Claude Sonnet 4)
   - Set weights and runs

6. **Set up Rubric:**
   - Choose a template or create custom criteria
   - Set threshold (e.g., 80%)
   - Add evaluation criteria with weights

7. **Submit the form**
   - The system will:
     - Upload rubric to IPFS
     - Generate Primary CID archive
     - Upload Primary archive to IPFS
     - Store job in local database
   
8. **Note the Job ID** from the success message

### Part 2: Browse Jobs (Hunter)

1. **Navigate to Home page**

2. **Use filters to search:**
   - Search by keywords
   - Filter by status (Open/Completed/Closed)
   - Filter by minimum ETH payout

3. **Click on a job card** to view details

4. **Review job information:**
   - Job description
   - Work product type
   - Bounty amount (ETH and USD)
   - Threshold requirement
   - Time remaining
   - Evaluation criteria

### Part 3: Submit Work (Hunter)

1. **From the job details page**, click "Submit Work"

2. **Prepare your work product:**
   - For this test, create a simple text file: `blog-post.txt`
   - Add some content about AI in dispute resolution

3. **Upload your work:**
   - Select the file
   - Click "Submit Work"

4. **Wait for processing:**
   - File uploads to IPFS
   - Hunter Submission CID archive is created
   - Primary CID archive is updated with hunter submission
   - Archives are uploaded to IPFS

5. **CID Dialog appears** with:
   - Hunter Submission CID
   - Updated Primary CID
   - Evaluation format for testing

6. **Copy the CIDs for testing**

### Part 4: Test AI Evaluation (Optional)

If you have the example-frontend running:

1. **Navigate to example-frontend** (usually `http://localhost:3001`)

2. **Go to "Run Query" page**

3. **Paste the evaluation format:**
   ```
   PRIMARY_CID,HUNTER_CID
   ```

4. **Submit for evaluation**

5. **Wait 1-5 minutes** for AI jury results

6. **Review the results:**
   - FUND or DONT_FUND outcome
   - Score vectors
   - Justification CID
   - Voting details

## Expected Results

### Job Creation
- ✅ Job appears on home page
- ✅ Rubric CID is generated and valid
- ✅ Primary CID is generated and valid
- ✅ Job details include all entered information
- ✅ USD conversion displays correctly

### Job Browsing
- ✅ All jobs are listed on home page
- ✅ Filters work correctly
- ✅ Job cards display correct information
- ✅ Time remaining updates properly

### Work Submission
- ✅ File uploads successfully to IPFS
- ✅ Hunter CID is generated
- ✅ Primary CID is updated with hunter submission
- ✅ CID dialog displays all necessary information
- ✅ Submission appears in job's submissions list

### AI Evaluation (with example-frontend)
- ✅ Multi-CID format is accepted
- ✅ Primary archive references rubric correctly
- ✅ Hunter submission is properly formatted
- ✅ AI jury evaluates against rubric criteria
- ✅ Result includes FUND/DONT_FUND outcome
- ✅ Justification is uploaded to IPFS

## Troubleshooting

### Backend Issues

**Problem:** Server won't start
```bash
# Solution: Check dependencies
npm install
# Make sure adm-zip is installed
npm install adm-zip
```

**Problem:** IPFS upload fails
```bash
# Solution: Verify Pinata credentials in .env
# Test with a simple upload:
curl -X POST "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer YOUR_JWT"
```

### Frontend Issues

**Problem:** Can't connect to backend
```bash
# Solution: Verify API URL in .env
echo $VITE_API_URL
# Should be http://localhost:5000
```

**Problem:** ETH price not showing
```bash
# Solution: Check CoinGecko API (no auth needed)
curl https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
```

### Archive Issues

**Problem:** Invalid CID format
- Check that archives are created properly in `server/tmp/`
- Verify manifest.json and primary_query.json are valid JSON
- Ensure ZIP archives contain files at root level

**Problem:** Primary CID missing hunter submission
- Verify hunter CID was generated before updating primary
- Check that `bCIDs.submittedWork` is set in manifest
- Review server logs for errors

## Data Storage

Jobs are stored locally in:
```
example-bounty-program/server/data/jobs.json
```

You can inspect this file to see:
- All created jobs
- Submission records
- CIDs for rubrics, primary archives, hunter submissions

## Clean Up

To reset the database:
```bash
rm server/data/jobs.json
```

To clean up IPFS temporary files:
```bash
rm -rf server/tmp/*
```

## Next Steps

Once you've successfully tested the workflow:

1. **Review the generated archives** to understand the structure
2. **Test with different file types** (txt, md, pdf, images)
3. **Try multiple submissions** for the same job
4. **Test search and filter** functionality
5. **Experiment with different rubrics** and thresholds

## Integration with Smart Contracts

When smart contracts are deployed, the workflow will be:

1. **Job Creation:**
   - Frontend calls `BountyEscrow.createBounty(rubricCid, threshold, classId)`
   - ETH is locked in escrow
   - Job data is stored on-chain

2. **Work Submission:**
   - Hunter calls `BountyEscrow.submitAndEvaluate(jobId, hunterCid, updatedPrimaryCid)`
   - LINK fee is paid
   - Verdikta is triggered via Chainlink

3. **Evaluation:**
   - Verdikta receives PRIMARY_CID,HUNTER_CID
   - AI jury evaluates work
   - Result is returned to contract

4. **Payment:**
   - If FUND outcome and score >= threshold, ETH is released to hunter
   - If DONT_FUND, hunter can resubmit
   - First passing submission wins

The current implementation generates all the necessary CIDs and archives, so integration with smart contracts will be straightforward.

