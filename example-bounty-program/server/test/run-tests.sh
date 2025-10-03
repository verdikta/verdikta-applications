#!/bin/bash

# Test script for Bounty API endpoints
# Run this after starting the server with: npm run dev

set -e  # Exit on error

BASE_URL="http://localhost:5005"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing Bounty API Endpoints"
echo "================================"
echo ""

# Check if server is running
echo "📡 Checking if server is running..."
if ! curl -s "$BASE_URL/health" > /dev/null; then
    echo -e "${RED}❌ Server is not running!${NC}"
    echo "Start server with: npm run dev"
    exit 1
fi
echo -e "${GREEN}✅ Server is running${NC}"
echo ""

# Test 1: Health Check
echo "Test 1: Health Check"
echo "--------------------"
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "${GREEN}✅ PASS${NC} - Health check successful"
    echo "Response: $HEALTH"
else
    echo -e "${RED}❌ FAIL${NC} - Health check failed"
    echo "Response: $HEALTH"
fi
echo ""

# Test 2: List Classes
echo "Test 2: List Verdikta Classes"
echo "-----------------------------"
CLASSES=$(curl -s "$BASE_URL/api/classes")
if echo "$CLASSES" | grep -q "success"; then
    echo -e "${GREEN}✅ PASS${NC} - Classes endpoint working"
    echo "Found classes: $(echo "$CLASSES" | grep -o '"id":[0-9]*' | wc -l | tr -d ' ') classes"
else
    echo -e "${RED}❌ FAIL${NC} - Classes endpoint failed"
    echo "Response: $CLASSES"
fi
echo ""

# Test 3: Validate Rubric (Valid)
echo "Test 3: Validate Valid Rubric"
echo "------------------------------"
VALID_RUBRIC='{
  "rubric": {
    "threshold": 82,
    "criteria": [
      {"id": "quality", "description": "Quality", "must": false, "weight": 1.0}
    ]
  }
}'
VALIDATION=$(curl -s -X POST "$BASE_URL/api/rubrics/validate" \
  -H "Content-Type: application/json" \
  -d "$VALID_RUBRIC")

if echo "$VALIDATION" | grep -q '"valid":true'; then
    echo -e "${GREEN}✅ PASS${NC} - Valid rubric accepted"
else
    echo -e "${RED}❌ FAIL${NC} - Valid rubric rejected"
    echo "Response: $VALIDATION"
fi
echo ""

# Test 4: Validate Rubric (Invalid - missing threshold)
echo "Test 4: Validate Invalid Rubric (Missing Threshold)"
echo "----------------------------------------------------"
INVALID_RUBRIC='{
  "rubric": {
    "criteria": [
      {"id": "quality", "description": "Quality", "must": false, "weight": 1.0}
    ]
  }
}'
VALIDATION=$(curl -s -X POST "$BASE_URL/api/rubrics/validate" \
  -H "Content-Type: application/json" \
  -d "$INVALID_RUBRIC")

if echo "$VALIDATION" | grep -q '"valid":false'; then
    echo -e "${GREEN}✅ PASS${NC} - Invalid rubric correctly rejected"
    echo "Errors found: $(echo "$VALIDATION" | grep -o '"errors":\[.*\]')"
else
    echo -e "${RED}❌ FAIL${NC} - Invalid rubric should be rejected"
    echo "Response: $VALIDATION"
fi
echo ""

# Test 5: Invalid CID Format
echo "Test 5: Fetch with Invalid CID"
echo "-------------------------------"
INVALID_CID_RESPONSE=$(curl -s "$BASE_URL/api/fetch/not-a-valid-cid")
if echo "$INVALID_CID_RESPONSE" | grep -q "Invalid CID format"; then
    echo -e "${GREEN}✅ PASS${NC} - Invalid CID correctly rejected"
else
    echo -e "${RED}❌ FAIL${NC} - Should reject invalid CID"
    echo "Response: $INVALID_CID_RESPONSE"
fi
echo ""

# Tests requiring IPFS credentials
echo "⚠️  Tests Requiring IPFS Credentials"
echo "====================================="
echo ""

# Check if IPFS_PINNING_KEY is set
if [ -f .env ]; then
    source .env
fi

if [ -z "$IPFS_PINNING_KEY" ]; then
    echo -e "${YELLOW}⚠️  IPFS_PINNING_KEY not set in .env${NC}"
    echo "Skipping IPFS upload/fetch tests"
    echo ""
    echo "To test IPFS functionality:"
    echo "1. Get Pinata JWT from https://app.pinata.cloud/"
    echo "2. Add to .env: IPFS_PINNING_KEY=your_jwt_token"
    echo "3. Run this script again"
else
    echo -e "${GREEN}✅ IPFS_PINNING_KEY found${NC}"
    echo ""
    
    # Test 6: Upload Rubric
    echo "Test 6: Upload Rubric to IPFS"
    echo "------------------------------"
    if [ -f "test/sample-rubric.json" ]; then
        UPLOAD_RESPONSE=$(curl -s -X POST "$BASE_URL/api/bounties" \
          -H "Content-Type: application/json" \
          -d @test/sample-rubric.json)
        
        if echo "$UPLOAD_RESPONSE" | grep -q "rubricCid"; then
            echo -e "${GREEN}✅ PASS${NC} - Rubric uploaded to IPFS"
            RUBRIC_CID=$(echo "$UPLOAD_RESPONSE" | grep -o '"rubricCid":"[^"]*"' | cut -d'"' -f4)
            echo "CID: $RUBRIC_CID"
            
            # Save CID for next test
            echo "$RUBRIC_CID" > /tmp/rubric_cid.txt
            
            # Test 7: Fetch Rubric
            echo ""
            echo "Test 7: Fetch Rubric from IPFS"
            echo "-------------------------------"
            sleep 2  # Wait for IPFS propagation
            FETCH_RESPONSE=$(curl -s "$BASE_URL/api/fetch/$RUBRIC_CID")
            
            if echo "$FETCH_RESPONSE" | grep -q "threshold"; then
                echo -e "${GREEN}✅ PASS${NC} - Rubric fetched successfully"
                echo "Content preview: $(echo "$FETCH_RESPONSE" | head -c 100)..."
            else
                echo -e "${RED}❌ FAIL${NC} - Failed to fetch rubric"
                echo "Response: $FETCH_RESPONSE"
            fi
        else
            echo -e "${RED}❌ FAIL${NC} - Rubric upload failed"
            echo "Response: $UPLOAD_RESPONSE"
        fi
    else
        echo -e "${YELLOW}⚠️  Sample rubric file not found${NC}"
    fi
    
    echo ""
    
    # Test 8: Upload Deliverable
    echo "Test 8: Upload Deliverable File to IPFS"
    echo "----------------------------------------"
    if [ -f "test/sample-essay.md" ]; then
        DELIVERABLE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/bounties/1/submit" \
          -F "file=@test/sample-essay.md")
        
        if echo "$DELIVERABLE_RESPONSE" | grep -q "deliverableCid"; then
            echo -e "${GREEN}✅ PASS${NC} - Deliverable uploaded to IPFS"
            DELIVERABLE_CID=$(echo "$DELIVERABLE_RESPONSE" | grep -o '"deliverableCid":"[^"]*"' | cut -d'"' -f4)
            echo "CID: $DELIVERABLE_CID"
            
            # Test 9: Fetch Deliverable
            echo ""
            echo "Test 9: Fetch Deliverable from IPFS"
            echo "------------------------------------"
            sleep 2  # Wait for IPFS propagation
            FETCH_DELIVERABLE=$(curl -s "$BASE_URL/api/fetch/$DELIVERABLE_CID")
            
            if echo "$FETCH_DELIVERABLE" | grep -q "Solidity"; then
                echo -e "${GREEN}✅ PASS${NC} - Deliverable fetched successfully"
                echo "Content preview: $(echo "$FETCH_DELIVERABLE" | head -c 100)..."
            else
                echo -e "${RED}❌ FAIL${NC} - Failed to fetch deliverable"
                echo "Response: $FETCH_DELIVERABLE"
            fi
        else
            echo -e "${RED}❌ FAIL${NC} - Deliverable upload failed"
            echo "Response: $DELIVERABLE_RESPONSE"
        fi
    else
        echo -e "${YELLOW}⚠️  Sample essay file not found${NC}"
    fi
fi

echo ""
echo "================================"
echo "🏁 Test Suite Complete"
echo "================================"

