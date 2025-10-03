# Bounty Program Backend API

Backend API server for the Verdikta AI-Powered Bounty Program.

## Overview

Express.js server that provides REST API endpoints for:
- Uploading rubrics and deliverables to IPFS
- Querying bounty and submission data from the blockchain
- Validating rubric JSON structures
- Fetching content from IPFS
- Class/model information from Verdikta

## Development Status

**Current Status:** 🟢 Core IPFS Functionality Complete (60%)

- [x] Server setup with Express.js
- [x] Route structure defined
- [x] IPFS client integration (@verdikta/common)
- [x] Validation utilities
- [x] Logger utility
- [x] File upload handling (multer)
- [x] **COMPLETE**: IPFS upload (rubrics)
- [x] **COMPLETE**: IPFS upload (deliverables)
- [x] **COMPLETE**: IPFS fetch with content-type detection
- [x] **COMPLETE**: Rubric validation
- [x] Test structure created
- [ ] **TODO**: Add blockchain interaction (ethers.js)
- [ ] **TODO**: Implement bounty listing from chain
- [ ] **TODO**: Implement submission details from chain
- [ ] **TODO**: Run integration tests

## Setup

### Prerequisites
- Node.js >= 18
- npm or yarn
- Pinata account (or IPFS pinning service)

### Installation

```bash
cd server
npm install
```

### Configuration

Copy `env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `IPFS_PINNING_KEY` - Pinata JWT token
- `BOUNTY_ESCROW_ADDRESS` - Deployed contract address
- `RPC_URL` - Blockchain RPC endpoint

## Usage

### Development Mode

```bash
npm run dev
```

Server will run on `http://localhost:5000` with auto-reload.

### Production Mode

```bash
npm start
```

### Run Tests

```bash
npm test
```

**Note:** Tests not yet implemented.

## API Endpoints

### Bounty Endpoints

#### POST /api/bounties
Upload rubric to IPFS and return CID.

**Request:**
```json
{
  "rubricJson": {
    "threshold": 82,
    "criteria": [...]
  },
  "classId": 128
}
```

**Response:**
```json
{
  "success": true,
  "rubricCid": "QmXxxx...",
  "message": "Rubric uploaded to IPFS"
}
```

**Status:** 🔴 TODO - Not implemented

---

#### GET /api/bounties
List all bounties with optional filters.

**Query Parameters:**
- `status` - Filter by status (open, evaluating, paid, cancelled)
- `creator` - Filter by creator address
- `minPayout` - Minimum payout in Wei
- `limit` - Results per page (default: 20)
- `offset` - Pagination offset (default: 0)

**Response:**
```json
{
  "success": true,
  "bounties": [...],
  "total": 42,
  "page": 1
}
```

**Status:** 🔴 TODO - Not implemented

---

#### GET /api/bounties/:bountyId
Get detailed bounty information.

**Response:**
```json
{
  "success": true,
  "bounty": {
    "bountyId": 1,
    "creator": "0xabc...",
    "payoutAmount": "1000000000000000000",
    "rubric": {...},
    "status": "Open",
    ...
  },
  "submissions": [...]
}
```

**Status:** 🔴 TODO - Not implemented

---

#### GET /api/bounties/:bountyId/submissions
Get all submissions for a bounty.

**Response:**
```json
{
  "success": true,
  "submissions": [...]
}
```

**Status:** 🔴 TODO - Not implemented

---

### Submission Endpoints

#### POST /api/bounties/:bountyId/submit
Upload deliverable file to IPFS.

**Request:** `multipart/form-data` with file upload

**Response:**
```json
{
  "success": true,
  "deliverableCid": "QmYyyy...",
  "filename": "essay.pdf",
  "size": 1048576
}
```

**Status:** 🔴 TODO - Not implemented

---

#### GET /api/submissions/:submissionId
Get submission details.

**Response:**
```json
{
  "success": true,
  "submission": {
    "submissionId": "0x123...",
    "hunter": "0xdef...",
    "deliverableCid": "QmYyyy...",
    "status": "Passed",
    "score": 86,
    ...
  }
}
```

**Status:** 🔴 TODO - Not implemented

---

### IPFS Endpoints

#### GET /api/fetch/:cid
Fetch content from IPFS.

**Response:** Binary or JSON content

**Status:** 🔴 TODO - Not implemented

---

#### POST /api/rubrics/validate
Validate rubric JSON structure.

**Request:**
```json
{
  "rubric": {
    "threshold": 82,
    "criteria": [...]
  }
}
```

**Response:**
```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

**Status:** ✅ Implemented

---

### Utility Endpoints

#### GET /api/classes
List available Verdikta classes.

**Status:** ✅ Implemented (reused from example-frontend)

---

#### GET /api/classes/:classId
Get specific class details.

**Status:** ✅ Implemented (reused from example-frontend)

---

#### GET /health
Health check endpoint.

**Status:** ✅ Implemented

---

## Project Structure

```
server/
├── routes/
│   ├── bountyRoutes.js       # Bounty CRUD endpoints
│   ├── submissionRoutes.js   # Submission endpoints
│   └── ipfsRoutes.js         # IPFS and validation
├── utils/
│   ├── logger.js             # Logging utility
│   └── validation.js         # Input validation
├── tmp/                      # Temporary file uploads
├── server.js                 # Main Express app
├── package.json
├── env.example
└── README.md
```

## Implementation TODOs

### High Priority
- [ ] Implement bounty listing with blockchain queries
- [ ] Implement bounty details fetching
- [ ] Implement file upload to IPFS
- [ ] Implement IPFS content fetching
- [ ] Add ethers.js contract interaction

### Medium Priority
- [ ] Add caching layer for bounty data
- [ ] Implement rate limiting
- [ ] Add request validation middleware
- [ ] Implement submission filtering/sorting

### Low Priority
- [ ] Add API documentation (Swagger)
- [ ] Add monitoring and metrics
- [ ] Implement request logging to file
- [ ] Add health check with dependency status

## File Upload Validation

**Allowed File Types:**
- Text: `.txt`, `.md`
- Images: `.jpg`, `.jpeg`, `.png`
- Documents: `.pdf`, `.docx`

**Size Limit:** 20 MB

Validation is performed both server-side (multer) and can be checked client-side for better UX.

## Error Handling

All endpoints return consistent error format:

```json
{
  "error": "Error type",
  "details": "Detailed error message"
}
```

HTTP status codes:
- `200` - Success
- `400` - Bad request (invalid input)
- `404` - Not found
- `500` - Server error
- `501` - Not implemented (TODO endpoints)
- `504` - Gateway timeout (IPFS)

## Logging

Structured logging with levels:
- `ERROR` - Errors that need attention
- `WARN` - Warnings and notices
- `INFO` - General information
- `DEBUG` - Detailed debugging info

Set log level via `LOG_LEVEL` environment variable.

## Dependencies

- `express` - Web framework
- `@verdikta/common` - IPFS client and class map
- `ethers` - Blockchain interaction
- `multer` - File upload handling
- `cors` - Cross-origin requests
- `dotenv` - Environment configuration

## Testing

```bash
npm test
```

**Note:** Test suite not yet implemented. Planned coverage:
- Route testing with supertest
- Validation utility tests
- IPFS integration tests
- Contract interaction tests

## Deployment

### Development
```bash
npm run dev
```

### Production

1. Set `NODE_ENV=production` in `.env`
2. Use process manager (PM2):

```bash
pm2 start server.js --name bounty-api
```

3. Configure nginx reverse proxy (optional)

### Docker (Future)

```bash
docker build -t bounty-api .
docker run -p 5000:5000 --env-file .env bounty-api
```

## Security Considerations

- [ ] Input validation on all endpoints
- [ ] Rate limiting to prevent abuse
- [ ] CORS configuration
- [ ] File upload size limits
- [ ] CID format validation
- [ ] Environment variable security

## Resources

- [Express.js Documentation](https://expressjs.com/)
- [@verdikta/common](https://www.npmjs.com/package/@verdikta/common)
- [Ethers.js v6](https://docs.ethers.org/v6/)
- [Pinata IPFS](https://docs.pinata.cloud/)

## License

MIT

