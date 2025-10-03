# Rubric Template System - Testing Guide

## Quick Start

### 1. Start Backend
```bash
cd example-bounty-program/server
npm run dev
# Should run on http://localhost:5005
```

### 2. Start Frontend
```bash
cd example-bounty-program/client
npm run dev
# Should run on http://localhost:5173
```

### 3. Connect Wallet
- Open http://localhost:5173
- Connect MetaMask wallet
- Navigate to "Create Bounty"

---

## Test Plan

### Part 1: Template Selection ✅

**Test 1.1: Load Default Template**
1. Go to Create Bounty page
2. Observe "Choose Template" dropdown
3. Default should be "Create from Scratch"
4. Should show 1 default criterion

**Test 1.2: Select Blog Post Template**
1. Select "📝 Blog Post" from dropdown
2. Observe:
   - ✅ Title changes to "Blog Post for Verdikta.org"
   - ✅ Threshold is 82%
   - ✅ 7 criteria loaded (2 must-pass, 5 scored)
   - ✅ Forbidden content populated

**Test 1.3: Select Code Review Template**
1. Select "💻 Code Review" from dropdown
2. Observe:
   - ✅ Title changes to "Code Review & Quality Assessment"
   - ✅ Threshold is 75%
   - ✅ 6 criteria loaded (1 must-pass, 5 scored)

**Test 1.4: Select Other Templates**
1. Try all templates:
   - Technical Documentation
   - Design Work
   - Video Content
   - General Submission
2. Each should load appropriate criteria

**Test 1.5: Switch Back to Scratch**
1. Select "Create from Scratch"
2. Observe:
   - ✅ Title clears
   - ✅ Resets to 1 default criterion

---

### Part 2: Rubric Editing ✏️

**Test 2.1: Edit Rubric Title**
1. Load "Blog Post" template
2. Change title to "My Custom Blog Post Rubric"
3. Observe title updates

**Test 2.2: Adjust Threshold**
1. Use slider to change threshold
2. Observe number input updates
3. Use number input to change threshold
4. Observe slider updates
5. Try values 0-100

**Test 2.3: Expand/Collapse Criteria**
1. Click on a criterion header
2. Observe it expands showing fields
3. Click again to collapse
4. Test with multiple criteria

**Test 2.4: Edit Criterion Fields**
1. Expand a criterion
2. Change the label
3. Change the instructions
4. Observe changes

**Test 2.5: Toggle Must-Pass**
1. Expand a scored criterion
2. Check "Must-Pass Criterion" checkbox
3. Observe:
   - ✅ Weight disappears
   - ✅ Weight set to 0.0
   - ✅ Border changes to red
   - ✅ Icon changes to 🔒
4. Uncheck to revert
5. Observe weight restored to default (0.20)

**Test 2.6: Adjust Weight Slider**
1. Expand a scored criterion
2. Drag weight slider
3. Observe number input updates
4. Type in number input
5. Observe slider updates
6. Observe total weight indicator updates

---

### Part 3: Add/Remove Criteria ➕➖

**Test 3.1: Add Scored Criterion**
1. Click "+ Add Scored Criterion"
2. Observe new criterion appears
3. Default weight should be 0.20
4. Expand and fill in fields

**Test 3.2: Add Must-Pass Criterion**
1. Click "+ Add Must-Pass Criterion"
2. Observe new must-pass criterion
3. Weight should be 0.0
4. Red border and 🔒 icon

**Test 3.3: Remove Criterion**
1. Click "🗑️ Remove Criterion"
2. Confirm removal
3. Observe criterion disappears
4. Observe weight total updates

**Test 3.4: Cannot Remove Last Criterion**
1. Remove all but one criterion
2. Try to remove last one
3. Observe button is disabled

---

### Part 4: Weight Validation 🔢

**Test 4.1: Valid Weights**
1. Load "Blog Post" template
2. Observe green "✓ Weights: 1.00" indicator
3. All weights should sum to 1.00

**Test 4.2: Invalid Weights (Too Low)**
1. Change a criterion weight from 0.20 to 0.10
2. Observe red "⚠️ Weights sum to 0.90" indicator
3. Try to save rubric
4. Should show alert about invalid weights

**Test 4.3: Invalid Weights (Too High)**
1. Change a criterion weight from 0.20 to 0.30
2. Observe red "⚠️ Weights sum to 1.10" indicator
3. Try to submit bounty
4. Should show alert about invalid weights

**Test 4.4: Fix Invalid Weights**
1. Adjust weights to sum to 1.00
2. Observe indicator turns green
3. Should now allow saving/submitting

---

### Part 5: Save Rubric to Library 💾

**Test 5.1: Save Without Title**
1. Clear rubric title
2. Click "💾 Save Rubric for Later"
3. Should show alert: "Please enter a rubric title"

**Test 5.2: Save With Invalid Weights**
1. Make weights invalid (e.g., 0.90 total)
2. Click "💾 Save Rubric for Later"
3. Should show alert: "Invalid weights"

**Test 5.3: Save Valid Rubric**
1. Load "Blog Post" template
2. Click "💾 Save Rubric for Later"
3. Observe:
   - ✅ Loading state
   - ✅ Success alert with CID
   - ✅ Green checkmark "✅ Loaded from IPFS: QmXxxx..."

**Test 5.4: Save Multiple Rubrics**
1. Create different rubrics
2. Save each one
3. Each should get unique CID
4. Should accumulate in localStorage

**Test 5.5: Check localStorage**
1. Open browser DevTools → Application → Local Storage
2. Find key: `verdikta_bounty_rubrics_{walletAddress}`
3. Should see array of saved rubrics with metadata

---

### Part 6: Load Rubric from Library 📁

**Test 6.1: Open Library (No Rubrics)**
1. Clear localStorage (optional)
2. Click "📁 Load My Rubrics"
3. Observe modal opens
4. Should show "No Saved Rubrics" message

**Test 6.2: Open Library (With Rubrics)**
1. Save at least 2 rubrics (Part 5.4)
2. Click "📁 Load My Rubrics"
3. Observe:
   - ✅ Modal opens
   - ✅ List of rubrics displayed
   - ✅ Shows title, CID, threshold, criteria count, created date

**Test 6.3: Load a Rubric**
1. Open library
2. Click "📂 Load Rubric" on one card
3. Observe:
   - ✅ Loading indicator
   - ✅ Modal closes
   - ✅ Form populates with rubric data
   - ✅ Criteria appear
   - ✅ Green indicator shows CID

**Test 6.4: Delete a Rubric**
1. Open library
2. Click "🗑️" button on a rubric
3. Confirm deletion
4. Observe:
   - ✅ Rubric disappears from list
   - ✅ Removed from localStorage

**Test 6.5: Close Library**
1. Open library
2. Click "Close" button or "✕"
3. Modal should close
4. Form should remain unchanged

---

### Part 7: End-to-End Bounty Creation 🎯

**Test 7.1: Create Bounty with Template**
1. Select "Technical Documentation" template
2. Fill in:
   - Bounty Title: "Write Python Tutorial"
   - Description: "Create comprehensive Python tutorial"
   - Payout: 0.1 ETH
3. Adjust threshold if needed
4. Configure AI jury (add 2 models)
5. Set iterations to 2
6. Click "Create Bounty"
7. Observe:
   - ✅ Rubric uploaded to IPFS
   - ✅ Success alert shows CID, class ID, jury count, criteria count
   - ✅ Console shows full rubric JSON

**Test 7.2: Create Bounty from Saved Rubric**
1. Load a saved rubric from library
2. Fill in bounty details
3. Configure jury
4. Submit
5. Should work same as Test 7.1

**Test 7.3: Create Custom Bounty from Scratch**
1. Select "Create from Scratch"
2. Set custom title: "Custom Content Review"
3. Set threshold to 85%
4. Add 3 criteria:
   - 1 must-pass: "No plagiarism"
   - 2 scored: "Quality" (0.6), "Originality" (0.4)
5. Save rubric for later
6. Fill bounty details
7. Configure jury
8. Submit
9. Success!

---

### Part 8: Edge Cases 🔍

**Test 8.1: Wallet Not Connected**
1. Disconnect wallet
2. Try to save rubric
3. Should show alert: "Please connect your wallet first"

**Test 8.2: Invalid IPFS Upload**
1. Stop backend server
2. Try to save rubric
3. Should show network error

**Test 8.3: Duplicate Rubric CID**
1. Save a rubric
2. Try to save exact same rubric again
3. Should show error: "This rubric is already saved"

**Test 8.4: Long Rubric Title**
1. Enter very long title (100+ chars)
2. Should handle gracefully
3. Display should not break

**Test 8.5: Many Criteria**
1. Add 10+ criteria
2. All should display correctly
3. Scrolling should work
4. Weight validation should still work

**Test 8.6: Quick Template Switching**
1. Rapidly switch between templates
2. Should not crash
3. Each template should load correctly

**Test 8.7: Browser Refresh**
1. Fill form halfway
2. Refresh page
3. Form resets (expected - no auto-save)
4. Saved rubrics in library should persist

---

## Success Criteria Checklist

### Template System
- [ ] All 6 templates load correctly
- [ ] Template switching works smoothly
- [ ] "Create from Scratch" resets form

### Rubric Editing
- [ ] Can edit all fields (title, threshold, criterion label, instructions)
- [ ] Expand/collapse works for all criteria
- [ ] Must-pass toggle works correctly
- [ ] Weight slider syncs with number input

### Add/Remove Criteria
- [ ] Can add scored criteria
- [ ] Can add must-pass criteria
- [ ] Can remove criteria (except last one)
- [ ] Last criterion cannot be removed

### Weight Validation
- [ ] Shows valid (green) when weights sum to 1.00
- [ ] Shows invalid (red) when weights don't sum to 1.00
- [ ] Prevents saving/submitting with invalid weights
- [ ] Updates in real-time as weights change

### Save to Library
- [ ] Can save rubric to localStorage
- [ ] Rubric uploads to IPFS
- [ ] Success alert shows CID
- [ ] Can save multiple rubrics
- [ ] Cannot save duplicate CIDs

### Load from Library
- [ ] Modal opens showing saved rubrics
- [ ] Displays rubric metadata correctly
- [ ] Can load rubric (fetches from IPFS)
- [ ] Can delete rubric from library
- [ ] Empty state shows when no rubrics

### End-to-End
- [ ] Can create bounty with template
- [ ] Can create bounty with saved rubric
- [ ] Can create bounty from scratch
- [ ] Rubric JSON includes all fields
- [ ] Integration with jury selection works

### Edge Cases
- [ ] Handles wallet disconnection
- [ ] Handles network errors
- [ ] Handles invalid data gracefully
- [ ] Works on mobile (responsive)
- [ ] No console errors
- [ ] No memory leaks

---

## Known Limitations

1. **localStorage Only**: Rubrics not synced across devices
2. **No Search**: Cannot search/filter saved rubrics
3. **No Tags**: Cannot categorize rubrics
4. **No Export**: Cannot export rubrics to JSON file
5. **No Import**: Cannot import rubrics from file
6. **No Sharing**: Cannot share rubrics with others

These are future enhancements.

---

## Debugging Tips

### Rubric Not Loading from Library
- Check browser console for errors
- Verify IPFS CID is valid
- Check backend is running
- Check network tab for failed requests

### Weights Won't Validate
- Sum all scored criterion weights
- Should be exactly 1.00 (±0.01 tolerance)
- Check for hidden criteria (scroll)

### Save Rubric Fails
- Ensure wallet connected
- Check rubric title is not empty
- Verify weights are valid
- Check backend logs

### localStorage Issues
- Check browser allows localStorage
- Check storage quota not exceeded
- Try clearing localStorage and retry

---

## Performance Notes

- **Template Loading**: < 100ms (instant)
- **Save to localStorage**: < 50ms
- **Upload to IPFS**: 2-5 seconds
- **Load from IPFS**: 1-3 seconds
- **Modal Open**: < 200ms

All operations should feel instant or provide loading feedback.

---

## Browser Compatibility

Tested on:
- [ ] Chrome/Edge (Chromium)
- [ ] Firefox
- [ ] Safari
- [ ] Mobile Safari
- [ ] Mobile Chrome

Should work on all modern browsers with localStorage support.

---

**Test Duration**: ~30 minutes for complete test suite

**Report Issues**: Document any failures with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/device
- Console errors
- Screenshots if visual issue

