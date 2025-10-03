# Jury Selection Testing Guide

Quick guide to test the new jury selection feature in the Create Bounty page.

## Prerequisites

1. **Backend Running:**
   ```bash
   cd example-bounty-program/server
   npm run dev
   # Should be on http://localhost:5005
   ```

2. **Frontend Running:**
   ```bash
   cd example-bounty-program/client
   npm run dev
   # Should be on http://localhost:5173
   ```

3. **Wallet:** MetaMask installed and connected to Base Sepolia testnet

## Test Steps

### 1. Class Selection

1. Navigate to "Create Bounty" page
2. Scroll to "AI Jury Configuration" section
3. Observe:
   - ✅ Default Class 128 selected
   - ✅ Multiple class cards displayed
   - ✅ Cards show: ID, name, status, model count, limits
   - ✅ Hover over cards to load details
4. Click on a different class card (e.g., Class 0)
5. Observe:
   - ✅ Card becomes highlighted
   - ✅ "Currently Selected" updates
   - ✅ Available models reload
   - ✅ Jury table updates with new providers/models

### 2. Iterations Configuration

1. Find "Number of Iterations" input
2. Click the **+** button
3. Observe:
   - ✅ Value increases
   - ✅ Jury summary updates "Total evaluations"
4. Click the **-** button
5. Observe:
   - ✅ Value decreases (minimum 1)
   - ✅ Button disables at 1
6. Type a number directly
7. Observe:
   - ✅ Value updates
   - ✅ Rejects negative numbers

### 3. Jury Composition

#### Adding Models

1. Default jury should have 1 model already
2. Click "+ Add Another AI Model" button
3. Observe:
   - ✅ New row appears
   - ✅ Dropdowns populated with providers/models
   - ✅ Jury summary updates "X models configured"
4. Add 2-3 more models

#### Configuring Models

1. Click provider dropdown
2. Observe:
   - ✅ List of providers (OpenAI, Anthropic, etc.)
3. Select a different provider
4. Observe:
   - ✅ Model dropdown updates automatically
   - ✅ Shows models for selected provider
5. Change the model dropdown
6. Observe:
   - ✅ Model selection updates

#### Runs and Weights

1. Change the "Runs" input
2. Observe:
   - ✅ Accepts numbers ≥ 1
   - ✅ Rejects 0 or negative
   - ✅ Jury summary updates "Total evaluations"
3. Change the "Weight" input
4. Observe:
   - ✅ Accepts 0.0 - 1.0
   - ✅ Step by 0.1
   - ✅ Rejects > 1.0 or < 0.0

#### Removing Models

1. Click the red **×** button on a jury row
2. Observe:
   - ✅ Row is removed
   - ✅ Jury summary updates
3. Try to remove the last remaining model
4. Observe:
   - ✅ Button is disabled (minimum 1 model required)

### 4. Jury Summary

1. Look at the blue summary box
2. Observe:
   - ✅ Shows total models
   - ✅ Shows iterations
   - ✅ Shows total evaluations (models × runs × iterations)
3. Change any value
4. Observe:
   - ✅ Summary updates in real-time

### 5. Form Submission

1. Fill in all required bounty fields:
   - Title
   - Description
   - Payout Amount
2. Configure your jury (already done)
3. Click "Create Bounty"
4. Observe:
   - ✅ Loading state appears
   - ✅ Success alert shows:
     - Rubric CID
     - Class ID
     - Number of jury models
5. Check browser console
6. Observe:
   - ✅ "Rubric uploaded to IPFS: QmXxxx..."
   - ✅ "Jury configuration: [{provider: 'openai', model: '...', runs: 1, weight: 1}, ...]"
7. Verify jury config format:
   ```javascript
   [{
     provider: "openai",    // API name, not display name
     model: "gpt-4",
     runs: 1,
     weight: 1.0
   }, ...]
   ```

### 6. Edge Cases

#### Empty Class

1. If there's an empty class (no models):
2. Observe:
   - ✅ Class card shows "EMPTY" badge
   - ✅ Card is grayed out
   - ✅ Cannot be selected

#### No Models Available

1. If somehow models fail to load:
2. Observe:
   - ✅ Jury table shows "No providers available"
   - ✅ Add button is disabled
   - ✅ Error message displayed

#### Network Error

1. Stop the backend server
2. Try to create a bounty
3. Observe:
   - ✅ Error alert appears
   - ✅ Helpful error message

### 7. Mobile Responsive

1. Resize browser to mobile width (< 768px)
2. Observe:
   - ✅ Class cards stack vertically
   - ✅ Jury table stacks (one field per row)
   - ✅ All functionality still works
   - ✅ Buttons remain accessible

## Expected API Calls

### On Page Load
1. `GET /api/classes` - List all classes
2. `GET /api/classes/128/models` - Load models for default class

### On Class Change
1. `GET /api/classes/{newClassId}/models` - Load models for new class

### On Form Submit
1. `POST /api/bounties` - Upload rubric to IPFS
   - Body includes `jury` array
   - Body includes `iterations`

## Console Logging

### Expected Console Output

```javascript
// On class load
"🔧 App Configuration: { apiUrl: 'http://localhost:5005', ... }"

// On class selection
"Loading models for class: 128"

// On form submission
"Rubric uploaded to IPFS: QmXxxx..."
"Jury configuration: [{ provider: 'openai', model: 'gpt-4', ... }]"
"✅ Rubric uploaded to IPFS!
CID: QmXxxx...
Class ID: 128
Jury Models: 2"
```

## Debugging Tips

### Models Not Loading

1. Check backend is running on port 5005
2. Check `VITE_API_URL` in `client/.env`
3. Check browser console for network errors
4. Check backend logs for errors

### Jury Config Not Saving

1. Check console for jury configuration object
2. Verify provider names are converted (e.g., "OpenAI" → "openai")
3. Check backend received correct format

### Styling Issues

1. Check if CSS files are imported
2. Clear browser cache
3. Check for CSS variable conflicts

## Success Criteria

- ✅ Can select different AI classes
- ✅ Can configure iterations
- ✅ Can add/remove jury models
- ✅ Can configure runs and weights
- ✅ Jury summary updates in real-time
- ✅ Form validates before submission
- ✅ Rubric includes jury configuration
- ✅ Backend receives correct format
- ✅ IPFS upload succeeds
- ✅ No console errors
- ✅ Mobile responsive

## Known Limitations

- **No Cost Estimation:** Future enhancement to show LINK fees
- **No Limits Enforcement:** Future enhancement to validate against class limits
- **No Model Details:** Future enhancement to show model capabilities

## Next Steps After Testing

1. Deploy smart contracts
2. Test end-to-end with live contract calls
3. Add cost estimation
4. Implement limits validation
5. Add model details tooltips

---

**Test Duration:** ~10-15 minutes for full test suite

**Report Issues:** Document any unexpected behavior with:
- Browser used
- Steps to reproduce
- Expected vs. actual behavior
- Console errors (if any)


