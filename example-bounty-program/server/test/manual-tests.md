# Manual API Tests

Since these endpoints require IPFS credentials and running contracts, here are curl commands for manual testing.

## Prerequisites

1. Start the server:
```bash
cd server
cp env.example .env
# Edit .env with your IPFS_PINNING_KEY
npm install
npm run dev
```

2. Server should be running on `http://localhost:5000`

---

## Test 1: Health Check

```bash
curl http://localhost:5000/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-10-02T...",
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

## Test 3: Validate Rubric

```bash
curl -X POST http://localhost:5000/api/rubrics/validate \
  -H "Content-Type: application/json" \
  -d '{
    "rubric": {
      "threshold": 82,
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
  "warnings": []
}
```

---

## Test 4: Upload Rubric to IPFS

**⚠️ Requires valid IPFS_PINNING_KEY in .env**

```bash
curl -X POST http://localhost:5000/api/bounties \
  -H "Content-Type: application/json" \
  -d '{
    "rubricJson": {
      "title": "Technical Blog Post",
      "threshold": 82,
      "criteria": [
        {
          "id": "originality",
          "description": "Content must be original",
          "must": true,
          "weight": 0.0
        },
        {
          "id": "accuracy",
          "description": "Technical accuracy",
          "must": false,
          "weight": 0.3
        },
        {
          "id": "clarity",
          "description": "Clear writing",
          "must": false,
          "weight": 0.3
        },
        {
          "id": "completeness",
          "description": "Covers all topics",
          "must": false,
          "weight": 0.4
        }
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
  "rubricCid": "QmXxxxxx...",
  "size": 1234,
  "criteriaCount": 4,
  "message": "Rubric uploaded to IPFS. Use this CID when calling createBounty()."
}
```

**Save the returned CID for the next tests!**

---

## Test 5: Fetch Rubric from IPFS

Replace `QmXxxxxx` with the CID from Test 4:

```bash
curl http://localhost:5000/api/fetch/QmXxxxxx
```

**Expected Response:**
The rubric JSON you uploaded, prettified.

---

## Test 6: Upload Deliverable File

**⚠️ Requires valid IPFS_PINNING_KEY in .env**

Create a test file first:

```bash
# Create a test file
echo "# Technical Blog Post

This is a sample blog post about Solidity smart contracts.

## Introduction
Solidity is a statically-typed programming language..." > test-essay.md
```

Then upload:

```bash
curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@test-essay.md"
```

**Expected Response:**
```json
{
  "success": true,
  "deliverableCid": "QmYyyyyy...",
  "filename": "test-essay.md",
  "size": 1234,
  "mimetype": "text/markdown",
  "message": "File uploaded to IPFS. Call submitAndEvaluate() with this CID."
}
```

---

## Test 7: Upload PDF File

```bash
# If you have a PDF file:
curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@sample.pdf"
```

---

## Test 8: Upload Image File

```bash
# If you have an image:
curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@sample.jpg"
```

---

## Test 9: Try Invalid File Type (should fail)

```bash
# Create an executable file (not allowed)
echo "#!/bin/bash" > test.sh
chmod +x test.sh

curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@test.sh"
```

**Expected Response:**
```json
{
  "error": "Invalid file type",
  "details": "Invalid file type: application/x-sh. Allowed: txt, md, jpg, png, pdf, docx"
}
```

---

## Test 10: Try File Too Large (should fail)

```bash
# Create a large file (over 20MB)
dd if=/dev/zero of=large-file.bin bs=1M count=21

curl -X POST http://localhost:5000/api/bounties/1/submit \
  -F "file=@large-file.bin"
```

**Expected Response:**
```json
{
  "error": "File too large",
  "details": "File size must be <= 20 MB"
}
```

---

## Test 11: Invalid CID Format

```bash
curl http://localhost:5000/api/fetch/not-a-valid-cid
```

**Expected Response:**
```json
{
  "error": "Invalid CID format",
  "details": "The provided CID does not match the expected format"
}
```

---

## Test Results Checklist

- [ ] Health check returns status
- [ ] Classes endpoint returns list
- [ ] Rubric validation works (valid rubric)
- [ ] Rubric validation rejects invalid rubric
- [ ] Rubric uploads to IPFS and returns CID
- [ ] Can fetch uploaded rubric from IPFS
- [ ] Deliverable file uploads (markdown)
- [ ] PDF uploads work
- [ ] Image uploads work
- [ ] Invalid file types are rejected
- [ ] Files over 20MB are rejected
- [ ] Invalid CID format is rejected

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

### "File upload failed"
- Check file permissions
- Verify file exists at the specified path
- Make sure file meets size/type requirements

---

## Next Steps

After verifying these endpoints work:
1. ✅ IPFS upload/fetch is working
2. ⏳ Add contract interaction endpoints
3. ⏳ Implement bounty listing from blockchain
4. ⏳ Add submission details fetching

See `STATUS.md` for full implementation checklist.

