# Run Query

The Run Query page is where you execute your AI jury evaluation. You can choose from three different methods to run your query, each suited to different use cases and workflows.

!!! note "Checked against the code"
    Revised on 2026-11-22 against `example-frontend/client/src/pages/RunQuery.js` and `utils/timeoutUtils.js` in this repository, and against the aggregator on Base mainnet at `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`. A query is paid in ETH, in the same transaction that submits it. There is no LINK step.

## Execution Methods

### Method 1: Use Current Configuration

This method uses the query and jury settings you configured in the previous steps.

#### When to Use
- You've just completed the Define Query and Jury Selection steps
- You want to run a new evaluation with your current settings
- This is the most common method for new queries

#### Configuration Summary
Before running, review the summary that displays:
- **Query Text**: The question you entered
- **Outcomes**: Number and labels of possible results
- **Supporting Files**: Count of uploaded files
- **IPFS CIDs**: Count of referenced content
- **Jury Members**: Number of AI models configured
- **Iterations**: Number of evaluation cycles
- **Reference URLs**: Any web links you included

#### Process
1. Select **"Use Current Configuration"**
2. Review the configuration summary
3. Click **"Run Query"**
4. Approve the transaction in MetaMask
5. Wait for evaluation completion

### Method 2: Upload Query Package

This method allows you to upload a pre-built query package as a ZIP file.

#### When to Use
- You have a previously exported query package
- You're rerunning a query from another system
- You want to share standardized query packages with others

#### File Requirements
- **Format**: ZIP file only
- **Contents**: Must include:
  - `manifest.json`: Configuration metadata
  - `primary_query.json`: Main query data
  - Supporting files (optional)

#### Process
1. Select **"Upload Query Package"**
2. Click **"Choose Files"** or drag a ZIP file into the upload area
3. Wait for file validation
4. Click **"Run Query"**
5. Monitor upload progress
6. Approve the transaction in MetaMask

#### Upload Progress
- Progress bar shows upload status
- File name and size are displayed
- Cancel upload by refreshing the page if needed

### Method 3: Use IPFS CID

This method references query packages already stored on IPFS using Content IDs.

#### When to Use
- Referencing publicly available query packages
- Using query packages uploaded by others
- Working with large datasets already on IPFS
- Running evaluations with multiple related packages

#### CID Input
- **Single CID**: Enter one IPFS Content ID
- **Multiple CIDs**: Separate multiple CIDs with commas
- **Default Example**: A sample CID is provided for testing

#### Optional Text Addendum
- Add supplementary text to modify or extend the original query
- Useful for adding context or instructions specific to your evaluation
- This text is appended to the original query content

#### Process
1. Select **"Use IPFS CID"**
2. Enter the CID(s) in the text field
3. Optionally add text addendum
4. Click **"Run Query"**
5. Approve the transaction in MetaMask

## Blockchain Transaction Process

### Prerequisites
- **Wallet Connected**: MetaMask must be connected
- **Network**: The wallet is switched to the network selected in the header, Base or Base Sepolia
- **ETH**: Your wallet needs ETH for the evaluation prepayment (0.0012 ETH with the application's settings, see [Cost Considerations](#cost-considerations)) and for gas. No LINK is needed

### Transaction Steps

#### 1. Network Check
- Application switches the wallet to the network selected in the header (Base or Base Sepolia)
- MetaMask will prompt for network change if needed

#### 2. ETH Prepayment
- There is no approval transaction: the fee is ETH sent with the query itself
- The page reads the worst-case fee from the aggregator (`maxTotalFee()`) and any prepay credit you already hold there (`ethOwed()`), and attaches the difference
- If your wallet holds less than that amount, the page stops with an "Insufficient ETH" message before anything is sent

#### 3. Query Execution
- One transaction submits your query to the blockchain and carries the prepayment
- The page sets a gas limit of 4,500,000 for this transaction
- Transaction includes the query package CID(s) and the request parameters

#### 4. Evaluation Wait
- The page waits for as long as the aggregator's own timeout, which it reads from the contract (`responseTimeoutSeconds()`): 300 seconds on Base mainnet, 900 seconds on Base Sepolia
- A countdown timer shows the time left
- System polls for results every 5 seconds until the timeout has passed. A result that arrives at any point in that time opens the Results page

#### 5. If No Result Arrives
A round that gets too few answers does not end by itself. It stays open, with the unspent part of your prepayment reserved in it, until someone calls `finalizeEvaluationTimeout(requestId)` on the aggregator after the timeout. Anyone can make that call. The page asks your wallet to make it:

- When the timeout has passed without a result, the page first checks, without a transaction, that the call would succeed. If the round completed at the last moment, the page shows the result instead. If another account has already closed the round, the page says so and your wallet is not asked for anything
- Otherwise your wallet asks you to confirm one more transaction. The page sets its gas limit to the network's estimate plus 50%, and to at least 3,000,000. On local copies of Base mainnet and Base Sepolia on 2026-11-22 the call used between 1.45 and 1.89 million gas when none of the six arbiters had answered
- **If you confirm**, the page waits for the transaction and then shows **"No result arrived. The round is closed."**, with a link to the transaction, the amount that came back as prepay credit and your prepay credit after it
- **If you decline**, or the transaction cannot be sent, the page shows **"No result arrived. The round is still open."** It states why nothing was sent, the request ID and the aggregator's address, and offers a **"Close the round now"** button that asks your wallet again. You can also make the call from any other wallet or tool. The notice is lost when you reload the page, so keep the request ID if you plan to close the round later
- In each of these cases the page stays on the Run Query page. The fees already credited to the arbiters that were polled are not returned (see [Cost Considerations](#cost-considerations))

### Status Messages

During execution, you'll see various status updates:
- **"Processing..."**: Initial setup
- **"Building archive from config..."**, **"Creating ZIP package..."**, **"Uploading ZIP to server..."**: Packaging and uploading your query (Method 1)
- **"Uploading file to server..."**: Uploading your ZIP file (Method 2)
- **"Applying ... ETH credit; attaching ... ETH…"**: Part of the prepayment comes from your prepay credit
- **"Fully covered by your existing prepay credit — no ETH needed beyond gas…"**: Your credit covers the whole prepayment
- **"Sending transaction..."**: Submitting main transaction
- **"Waiting for confirmation..."**: Transaction mining
- **"Waiting for evaluation results..."**: AI processing
- **"Fetching justification from server..."**: Retrieving results
- **"Waiting for the network to reach the timeout..."**: The page's timer has run out a few seconds before the blockchain's
- **"No result arrived in time. Confirm the transaction in your wallet to close the round and release your prepayment..."**: Your wallet is waiting for you (see [If No Result Arrives](#5-if-no-result-arrives))
- **"Closing the round on the blockchain..."**: The closing transaction is being mined

### Error Handling

Common errors and solutions:

#### "Insufficient ETH"
- **Cause**: Your wallet holds less ETH than the prepayment, or the transaction was sent with too little ETH (the contract's `InsufficientPayment` error)
- **Solution**: Add ETH to your wallet and try again. The message states the amount needed

#### "No eligible arbiters"
- **Cause**: Too few active arbiters serve the selected class, or their fee is above the application's fee limit
- **Solution**: Try a different class or contact the administrator

#### "User rejected transaction"
- **Cause**: You declined the transaction in MetaMask
- **Solution**: Try again and approve the transaction

#### "No result arrived. The round is closed."
- **Cause**: No result arrived within the aggregator's timeout, and the round was closed, by your wallet or by another account
- **Solution**: You can try again. The unspent part of the prepayment is back as prepay credit and is applied to your next query

#### "No result arrived. The round is still open."
- **Cause**: No result arrived within the aggregator's timeout, and the transaction that closes the round was not sent or did not succeed. The notice gives the reason, for example that you declined it
- **Solution**: Use the **"Close the round now"** button in the notice, or call `finalizeEvaluationTimeout(requestId)` on the aggregator yourself. Until then the unspent part of the prepayment stays reserved in the round. See [If No Result Arrives](#5-if-no-result-arrives)

#### Network or connectivity issues
- **Solution**: Check internet connection and try again

## Cost Considerations

### Fee Components
- **Evaluation Fee**: Paid in ETH to the arbiters that evaluate your query, out of a prepayment sent with the query
- **Gas Fees**: Blockchain transaction costs (paid in ETH)

### How the Prepayment Works
- The application sets a fee limit of 0.0001 ETH per arbiter (`MAX_FEE` in `client/src/App.js`). The aggregator requires a prepayment of 12 times that limit, 0.0012 ETH, which its `maxTotalFee()` function returns. The banner at the top of the page shows the amount
- The round then costs what the selected arbiters charge: each of the 6 arbiters polled is credited its own fee, and each of the 2 arbiters whose answers are clustered gets 3 times its fee on top
- On 2026-11-22 all 40 arbiters registered on Base mainnet charged 0.00002 ETH, so a completed query cost 0.00024 ETH in arbiter fees and a query that timed out cost 0.00012 ETH, plus gas. A query that times out needs gas twice: for the query and for the transaction that closes the round
- The rest of the prepayment is returned as **prepay credit** held in the aggregator. It is applied automatically to your next query, and the **"Withdraw credit"** button on this page sends it back to your wallet

### Cost Factors
- **Arbiter fees**: Set by the arbiters that are selected, up to the application's fee limit
- **Outcome of the round**: A completed round pays bonuses to two arbiters; a round that times out pays base fees only
- The number of AI models, runs per model, iterations and the size of the query do not change the on-chain fee
## Best Practices

### Before Running
- **Review Configuration**: Double-check all settings in the summary
- **Test with Simple Queries**: Start with basic queries to understand the process
- **Check Wallet Balance**: Ensure sufficient ETH for the prepayment and gas fees

### During Execution
- **Stay Connected**: Keep browser tab active during evaluation
- **Don't Refresh**: Page refresh will lose progress tracking
- **Monitor Status**: Watch status messages for any issues

### After Completion
- **Save Result CID**: Note the result CID for future reference
- **Review Justification**: Read the AI jury's reasoning
- **Export Results**: Copy important data before starting new queries

## Troubleshooting

### Transaction Failures
1. Check MetaMask connection
2. Verify network (the one selected in the header: Base or Base Sepolia)
3. Ensure sufficient ETH balance for the prepayment and gas
4. Try again with fresh page load

### Upload Issues
1. Verify file is a valid ZIP
2. Check file size (under 50MB recommended)
3. Ensure stable internet connection
4. Try compressing large files

### IPFS Access Problems
1. Verify CID format is correct
2. Check IPFS content is accessible
3. Try using IPFS gateway directly
4. Use alternative CID if available

## Navigation

- **Back to Jury Selection**: Modify your AI jury configuration
- **Automatic**: Successfully completed queries automatically navigate to Results
- **Results Page**: Manual navigation available via header tabs 