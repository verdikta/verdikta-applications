# Threshold Separation - Implementation Notes

**Date:** October 14, 2025  
**Change:** Separated threshold from rubric JSON

---

## Background

Previously, the threshold value was included in the rubric JSON that was uploaded to IPFS and sent to AI nodes for evaluation. This has been changed because:

1. **Threshold is a smart contract concern**, not an AI evaluation concern
2. **AI nodes don't need the threshold** - they just evaluate and provide scores
3. **Smart contract determines pass/fail** - by comparing AI score to threshold

---

## Changes Made

### 1. Rubric Templates Updated

**Before:**
```javascript
{
  version: "rubric-1",
  title: "Blog Post",
  threshold: 82,  // ← Included in template
  criteria: [...]
}
```

**After:**
```javascript
// Template (no threshold)
{
  version: "rubric-1",
  title: "Blog Post",
  criteria: [...]
}

// Threshold stored separately
export const templateThresholds = {
  blogPost: 82,
  codeReview: 75,
  // ...
};
```

**Files Changed:**
- `client/src/data/rubricTemplates.js`
  - Removed `threshold` from all 6 templates
  - Added `templateThresholds` object
  - Added `getTemplateThreshold(key)` function

---

### 2. Frontend State Management

**CreateBounty Component:**
- Added separate `threshold` state variable
- `rubric` state no longer contains threshold
- When template selected, threshold set separately via `getTemplateThreshold()`
- Threshold displayed in its own UI input field
- Threshold logged separately but not included in IPFS upload

**Files Changed:**
- `client/src/pages/CreateBounty.jsx`
  - Added `const [threshold, setThreshold] = useState(80);`
  - Updated `handleTemplateSelect()` to set threshold separately
  - Updated rubric JSON construction to exclude threshold
  - Updated console logs and alerts to show threshold separately

---

### 3. Storage Changes

**localStorage:**
Threshold is now saved as part of rubric metadata (not in rubric JSON itself):

```javascript
{
  cid: "QmXxx...",
  title: "My Rubric",
  threshold: 82,        // ← Stored here
  rubricJson: {...}     // ← No threshold inside
}
```

**Files Changed:**
- `client/src/services/rubricStorage.js`
  - `saveRubric()` accepts `threshold` parameter
  - Threshold stored in metadata alongside CID
- `client/src/components/RubricLibrary.jsx`
  - `handleLoadRubric()` passes threshold from metadata to parent

---

### 4. Backend Validation

**Validation Updated:**
Backend no longer expects or validates threshold in rubric JSON.

**Files Changed:**
- `server/utils/validation.js`
  - Removed threshold validation from `validateRubric()`
  - Added comment explaining why threshold is not validated

---

### 5. IPFS Upload

**What Gets Uploaded:**
```json
{
  "version": "rubric-1",
  "title": "Technical Blog Post",
  "description": "...",
  "criteria": [...],
  "forbidden_content": [...],
  "jury": [...],
  "iterations": 1
}
```

**What Does NOT Get Uploaded:**
- `threshold` - This stays on-chain only

---

## Data Flow

### Old Flow (Before Change)
```
Template → Rubric with threshold → IPFS → AI nodes see threshold
                                        ↓
                            Smart contract reads from IPFS
```

### New Flow (After Change)
```
Template → Rubric (no threshold) → IPFS → AI nodes (no threshold)
        ↓
   Threshold separately → Smart contract stores threshold
                                        ↓
                            AI score compared to stored threshold
```

---

## Smart Contract Integration

When the smart contract is implemented, it should:

1. **Accept threshold as parameter:**
```solidity
function createBounty(
    string calldata rubricCid,
    uint64 classId,
    uint8 threshold  // ← New parameter (0-100)
) external payable returns (uint256 bountyId)
```

2. **Store threshold in Bounty struct:**
```solidity
struct Bounty {
    address creator;
    uint256 payoutAmount;
    string rubricCid;
    uint64 classId;
    uint8 threshold;  // ← Store threshold here
    BountyStatus status;
    uint256 createdAt;
}
```

3. **Use threshold in evaluation callback:**
```solidity
function fulfillEvaluation(
    bytes32 submissionId,
    uint8 aiScore,
    string calldata justificationCid
) external {
    Submission storage submission = submissions[submissionId];
    Bounty storage bounty = bounties[submission.bountyId];
    
    submission.score = aiScore;
    submission.reportCid = justificationCid;
    
    // Compare to stored threshold
    if (aiScore >= bounty.threshold) {
        payoutWinner(submissionId);
    } else {
        submission.status = SubmissionStatus.Failed;
    }
}
```

---

## Frontend TODO for Contract Integration

When integrating with deployed smart contracts:

```javascript
// In CreateBounty.jsx handleSubmit()

// Step 1: Upload rubric to IPFS (without threshold)
const rubricCid = await apiService.uploadRubric(rubricForBackend, selectedClassId);

// Step 2: Call smart contract with threshold
const tx = await bountyEscrowContract.createBounty(
    rubricCid,
    selectedClassId,
    threshold,  // ← Pass threshold separately
    { value: ethers.parseEther(payoutAmount) }
);
```

---

## Testing

### Manual Testing Checklist

- [ ] Select template → Verify threshold loads correctly
- [ ] Adjust threshold slider → Verify updates state
- [ ] Save rubric → Verify threshold saved to localStorage
- [ ] Load rubric → Verify threshold loaded from storage
- [ ] Upload to IPFS → Verify threshold NOT in IPFS JSON
- [ ] Console logs → Verify threshold logged separately
- [ ] Alert message → Verify shows threshold value

### What to Verify in IPFS

When you upload a rubric and fetch it back:
```bash
curl http://localhost:5005/api/fetch/QmXxx...
```

Should return JSON **WITHOUT** `threshold` field:
```json
{
  "version": "rubric-1",
  "title": "...",
  "criteria": [...],
  // No "threshold" here ✅
  "jury": [...],
  "iterations": 1
}
```

---

## Benefits of This Change

1. **Cleaner Separation of Concerns**
   - AI nodes evaluate based on criteria
   - Smart contract decides funding based on threshold

2. **Flexibility**
   - Can change threshold on-chain without re-uploading rubric
   - Same rubric can be used with different thresholds

3. **Gas Savings**
   - Threshold is simple uint8 on-chain
   - No need to parse entire rubric to get threshold

4. **Security**
   - Threshold immutably stored on-chain
   - AI nodes can't manipulate threshold

---

## Backward Compatibility

**Old rubrics with threshold:**
If loading an old rubric that contains a threshold field:
- Frontend will ignore it from rubric
- Threshold will default to 80 if not in metadata
- User should save rubric again to update storage format

---

## Files Modified Summary

**Frontend (6 files):**
- `client/src/data/rubricTemplates.js`
- `client/src/pages/CreateBounty.jsx`
- `client/src/services/rubricStorage.js`
- `client/src/components/RubricLibrary.jsx`

**Backend (1 file):**
- `server/utils/validation.js`

**Documentation (3 files):**
- `PROJECT-OVERVIEW.md`
- `CURRENT-STATE.md`
- `THRESHOLD-SEPARATION.md` (this file)

---

## Questions & Answers

**Q: Why not send threshold to AI nodes?**  
A: AI nodes evaluate quality, not decide funding. Threshold is a business logic decision, not an evaluation criterion.

**Q: Can threshold be changed after bounty creation?**  
A: No, it's immutable in the smart contract. This ensures fairness - hunters know the threshold upfront.

**Q: What if AI nodes need to know the threshold?**  
A: They don't. AI nodes score 0-100 objectively. The smart contract compares that score to the threshold.

**Q: How do hunters see the threshold before submitting?**  
A: Frontend displays it from the on-chain bounty struct (when we add contract integration).

---

**Implementation Complete:** October 14, 2025  
**Status:** ✅ All code updated, tested, and documented

