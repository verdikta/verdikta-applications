# Manual API Tests

Curl commands for hands-on testing of the read-only and IPFS-touching endpoints.
Anything that creates a job or submits on-chain is intentionally out of scope here —
those flows require a wallet, gas, and the BountyEscrow contract. See
`/agents.txt` for the full agent flow.

## Prerequisites

1. Start the server:
```bash
cd server
cp env.example .env
# Edit .env with your IPFS_PINNING_KEY (Pinata JWT)
npm install
npm run dev
```

2. Server should be running on `http://localhost:5000`.

---

## Test 1: Health Check

```bash
curl http://localhost:5000/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-04-27T...",
  "version": "0.1.0"
}
```

---

## Test 2: List Classes

```bash
curl http://localhost:5000/api/classes
```

**Expected Response:**
```json
{
  "success": true,
  "classes": [...]
}
```

---

## Test 3: Validate Rubric (free, no IPFS, no jobId increment)

This is the side-effect-free way to debug rubric shape before calling
`/jobs/create`. Pass `rubricJson` as a NATIVE JSON object — do NOT pre-stringify
it. Threshold is NOT part of the rubric; it's a top-level field on
`/jobs/create` and is enforced on-chain.

```bash
curl -X POST http://localhost:5000/api/jobs/rubric/validate \
  -H "Content-Type: application/json" \
  -d '{
    "rubricJson": {
      "criteria": [
        {
          "id": "originality",
          "description": "Content must be original",
          "must": true,
          "weight": 0.0
        },
        {
          "id": "quality",
          "description": "Overall quality",
          "must": false,
          "weight": 1.0
        }
      ]
    }
  }'
```

**Expected Response:**
```json
{
  "valid": true,
  "errors": [],
  "checkedAt": "2026-04-27T..."
}
```

**Rejection example — stringified rubric (the most common agent mistake):**
```bash
curl -X POST http://localhost:5000/api/jobs/rubric/validate \
  -H "Content-Type: application/json" \
  -d '{ "rubricJson": "{\"criteria\":[]}" }'
```
Returns 400 with `errors[0]` explaining that `rubricJson` must be a JSON object,
not a string, because the request body is already JSON.

**Rejection example — weights don't sum to 1.0:**
```bash
curl -X POST http://localhost:5000/api/jobs/rubric/validate \
  -H "Content-Type: application/json" \
  -d '{
    "rubricJson": {
      "criteria": [
        { "id": "a", "must": false, "weight": 0.5, "description": "x" },
        { "id": "b", "must": false, "weight": 0.4, "description": "y" }
      ]
    }
  }'
```
Returns `valid: false` with `errors: ["Rubric: Scored criteria weights must sum to 1.0 (got 0.900)"]`.

---

## Test 4: Validate an Evaluation Package CID (free, IPFS read-only)

After pinning a full evaluation package (or to inspect someone else's CID)
but BEFORE calling `createBounty` on-chain.

```bash
curl -X POST http://localhost:5000/api/jobs/validate \
  -H "Content-Type: application/json" \
  -d '{
    "evaluationCid": "QmXxxxxx...",
    "classId": 128
  }'
```

**Expected Response:**
```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "evaluationCid": "QmXxxxxx...",
  "checkedAt": "2026-04-27T..."
}
```

---

## Test 5: Pin a Rubric Directly to IPFS (low-level)

**⚠️ Requires valid IPFS_PINNING_KEY in .env**

Most callers should use `POST /api/jobs/create` instead — it builds a full
evaluation package (manifest + primary archive) and pins it. This endpoint
pins the bare rubric JSON only; the resulting CID is NOT a valid
`evaluationCid` for `createBounty()`.

Note: the field name here is `rubric` (legacy IPFS route), not `rubricJson`.

```bash
curl -X POST http://localhost:5000/api/rubrics \
  -H "Content-Type: application/json" \
  -d '{
    "rubric": {
      "title": "Technical Blog Post",
      "criteria": [
        { "id": "originality",  "description": "Content must be original", "must": true,  "weight": 0.0 },
        { "id": "accuracy",     "description": "Technical accuracy",       "must": false, "weight": 0.3 },
        { "id": "clarity",      "description": "Clear writing",            "must": false, "weight": 0.3 },
        { "id": "completeness", "description": "Covers all topics",        "must": false, "weight": 0.4 }
      ],
      "forbidden_content": ["NSFW", "Hate speech"]
    },
    "classId": 128
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "rubricCid": "QmXxxxxx..."
}
```

---

## Test 6: Fetch Content from IPFS

Replace `QmXxxxxx` with a CID from a previous test:

```bash
curl http://localhost:5000/api/fetch/QmXxxxxx
```

**Expected Response:**
The pinned content as `text/plain` (JSON content comes back as a JSON string,
not a parsed object — the endpoint streams raw bytes from the gateway).

---

## Test 7: Upload Submission Files

**⚠️ Requires:**
- Valid `IPFS_PINNING_KEY` in `.env`
- A bounty whose API job is linked to an on-chain bounty (`onChain: true` or
  `syncedFromBlockchain: true`). Without that, the endpoint returns
  `400 BOUNTY_NOT_ONCHAIN`.

This endpoint pins files only — it does NOT create an on-chain submission or a
backend record. Carry the returned `hunterCid` into `POST /submit/prepare` (or
`/submit/bundle`), then `POST /submissions/confirm` after the on-chain prepare
succeeds.

Create a test file first:

```bash
echo "# Technical Blog Post

This is a sample blog post about Solidity smart contracts.

## Introduction
Solidity is a statically-typed programming language..." > test-essay.md
```

Then upload (replace `:id` with a real, on-chain-linked bounty id):

```bash
curl -X POST http://localhost:5000/api/jobs/1/submit \
  -F "files=@test-essay.md" \
  -F "hunter=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Files uploaded to IPFS successfully! Call /submissions/confirm after on-chain prepareSubmission succeeds.",
  "submission": {
    "hunter": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    "hunterCid": "QmYyyyyy...",
    "fileCount": 1,
    "files": [
      { "filename": "test-essay.md", "size": 1234, "description": "..." }
    ],
    "totalSize": 1234
  },
  "tips": [
    "Next: call prepareSubmission on-chain, then POST /api/jobs/:id/submissions/confirm",
    "Check submission status: GET /api/jobs/1/submissions"
  ]
}
```

The `files` field is an array — multiple files can be uploaded in a single
request (up to 10):

```bash
curl -X POST http://localhost:5000/api/jobs/1/submit \
  -F "files=@page1.md" \
  -F "files=@page2.pdf" \
  -F "hunter=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
```

---

## Test 8: Validate a Submission Without Paying

Read-only equivalent of Test 7 — checks file types, sizes, and bounty
requirements but pins nothing.

```bash
curl -X POST http://localhost:5000/api/jobs/1/submit/dry-run \
  -F "files=@test-essay.md" \
  -F "hunter=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
```

Returns validation checks, warnings, and an estimated cost.

---

## Test 9: Invalid File Type (should fail)

```bash
echo "#!/bin/bash" > test.sh
chmod +x test.sh

curl -X POST http://localhost:5000/api/jobs/1/submit \
  -F "files=@test.sh" \
  -F "hunter=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
```

**Expected Response:**
```json
{
  "error": "Invalid file type",
  "details": "Invalid file type: application/x-sh for file test.sh. Allowed: code files (.py, .sol, .cpp, .js, etc.), documents (.txt, .md, .pdf, .docx), images (.jpg, .png), and data files (.json, .xml, .yaml, .csv)"
}
```

---

## Test 10: File Too Large (should fail)

```bash
dd if=/dev/zero of=large-file.bin bs=1M count=21

curl -X POST http://localhost:5000/api/jobs/1/submit \
  -F "files=@large-file.bin" \
  -F "hunter=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
```

The 20 MB cap is enforced by multer; the response is the standard multer
"File too large" error (HTTP 400). Per-file limit is 20 MB.

---

## Test 11: Invalid CID Format

The fetch endpoint applies a minimal length check. A CID shorter than 10
characters is rejected up front:

```bash
curl http://localhost:5000/api/fetch/short
```

**Expected Response:**
```json
{
  "error": "Invalid CID"
}
```

A longer-but-bogus CID will pass the length check, attempt all gateways, and
fail with a 502 `{ error: "Fetch failed", details: ... }`.

---

## Test Results Checklist

- [ ] Health check returns status
- [ ] Classes endpoint returns list
- [ ] Rubric validation accepts a valid rubric
- [ ] Rubric validation rejects a stringified rubric
- [ ] Rubric validation rejects weights that don't sum to 1.0
- [ ] Evaluation-package CID validation returns `{valid, errors, warnings}`
- [ ] Direct rubric pin returns a CID (low-level path)
- [ ] Fetch returns content for a known CID
- [ ] Submission upload returns `hunterCid` for an on-chain-linked bounty
- [ ] Submission dry-run returns checks without pinning
- [ ] Invalid file types are rejected
- [ ] Files over 20 MB are rejected
- [ ] Short CID format is rejected up front

---

## Troubleshooting

### "IPFS_PINNING_KEY not set"
- Make sure you've copied `env.example` to `.env`
- Add your Pinata JWT token to the `.env` file

### "Failed to upload to IPFS"
- Check that your Pinata JWT token is valid
- Verify you have available storage on Pinata
- Check server logs for detailed error messages

### "ECONNREFUSED"
- Make sure the server is running (`npm run dev`)
- Check that you're using the correct port (default: 5000)

### "BOUNTY_NOT_ONCHAIN" (400) on `/jobs/:id/submit`
- The API job exists but isn't linked to an on-chain bounty.
- The error body's `fix` field names the exact PATCH call to make:
  `PATCH /api/jobs/:jobId/bountyId` with `{ bountyId, txHash }`.
- See `/agents.txt` § "Never create an API job without deploying its on-chain bounty".

### "File upload failed"
- Check file permissions
- Verify file exists at the specified path
- Make sure file meets size/type requirements

---

## Where to go next

For the full agent flow (create → submit → prepare → start → finalize), see
`GET /agents.txt` and `GET /api/docs` on a running server.
