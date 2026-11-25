# Run Query

The Run Query page is where you execute your AI jury evaluation. You can choose from three different methods to run your query, each suited to different use cases and workflows.

!!! note "Checked against the code"
    Revised on 2026-11-24 for the v2 aggregator (one aggregator, the jury sent with each request), against `example-frontend/client/src/pages/RunQuery.js` and `utils/timeoutUtils.js` in this repository and the v2 `ReputationAggregator` source (verdikta-dispatcher, `reputationBasedAggregator/contracts/ReputationAggregator.sol`). The v2 aggregator is not deployed yet, so no address is given here. A query is paid in ETH, in the transaction that submits it; there is no LINK step. Your wallet then sends the transactions that move the round on.

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

The aggregator is Verdikta's v2 `ReputationAggregator`. In v2 the query transaction only prepays the round. The round then needs a few more calls to move from one phase to the next, and the Run Query page makes them with **your wallet**: each one is a wallet transaction you confirm. A query therefore takes two to five wallet transactions, not one.

### Prerequisites
- **Wallet Connected**: MetaMask must be connected
- **Network**: The wallet is switched to the network selected in the header, Base or Base Sepolia
- **Aggregator**: A v2 aggregator address must be selected. The v1 aggregators do not work with this page (see [Contract Management](contract-management.md))
- **ETH**: Your wallet needs ETH for the evaluation prepayment (0.0018 ETH with the application's settings and the Small jury, see [Cost Considerations](#cost-considerations)) and for the gas of each transaction. No LINK is needed

### Transaction Steps

#### 1. Network Check
- Application switches the wallet to the network selected in the header (Base or Base Sepolia)
- MetaMask will prompt for network change if needed

#### 2. ETH Prepayment
- There is no approval transaction: the fee is ETH sent with the query itself
- The page reads the worst-case fee for the request's jury from the aggregator, `maxTotalFee(maxFee, minFee, withBeacons, K, P)`, and any prepay credit you already hold there (`ethOwed()`), and attaches the difference. The aggregator takes the attached ETH first and covers any shortfall from your credit
- If your wallet holds less than that amount, the page stops with an "Insufficient ETH" message before anything is sent

#### 3. Query Request (wallet transaction 1)
- `requestAIEvaluationWithApproval(cids, addendum, alpha, maxFee, minFee, estimatedBaseCost, scaling, class, withBeacons, jury)` submits your query and carries the prepayment. The application sends a fee floor (`minFee`) of 0 (`MIN_FEE` in `client/src/App.js`). The jury `(K, M, N, P, timeout)` and the beacon flag are the **Arbiter jury size** chosen on the Jury Selection page: Small 6/5/4/3, 300 s by default, Medium 8/5/4/3, 300 s, Large 21/16/13/10, 300 s, or Jumbo 50/38/27/17, 600 s with beacons. The banner on this page shows the jury and its worst-case fee
- A jury the aggregator does not accept (outside its rules, or above its `maxJury()`, its `maxTimeout()` or the one-day timeout cap) makes the request revert with `BadJury`, and the page says so
- The page sets a gas limit of 4,500,000 for this transaction. The request itself uses about 0.2 million gas; it may also settle up to two earlier rounds that are due
- The page reads the round's ID (`aggRequestId`) from the `RequestAIEvaluation` event. Round IDs count up from 1

#### 4. Driving the Round
From here the page reads the round's phase (`getRoundInfo()`) every few seconds and shows it in a **phase timeline**: the round's own jury (read with `getJury(aggId)`, so a resumed round shows the jury it was requested with), the phases, the one the round is in, the commits received, the time left to the round's deadline, and the transactions your wallet sent, with any reward they earned.

Before each transaction the page checks, without a transaction (a dry run from your address), that the call will succeed, and your wallet is asked to confirm only a call that will. The gas limit is the network's estimate plus 50%.

| Phase | What happens | Your wallet | Who earns what |
|---|---|---|---|
| 1 Draw | The jury has not been drawn yet | `drawJury(aggId)`, from two blocks after the request (a few seconds) | Within 30 seconds of the request only the requester earns the **draw reward**, 2 × the per-arbiter fee ceiling; after that anyone who draws earns it |
| 2 Beacons (only with beacons) | The first `drawJury` started a beacon stage | A second `drawJury` once the beacon values are in | The draw reward, within 30 seconds of the last needed beacon value |
| 3 Commit | The drawn arbiters commit their answers. The window closes by itself when enough have committed | `closeCommits(aggId)`, only if the commit window (`tPlus()`, 155 s by default) is over with at least M commits but not enough to close it | No reward |
| 4 Closing | The commit window is closed | `promote(aggId)`, from two blocks after the close | The caller earns the **promote reward**, 1 × the fee ceiling |
| 5 Reveal | The promoted arbiters reveal; the last needed reveal finalizes the round | Nothing | |
| 6 Final | The result is ready: the page opens the Results page | Nothing | |

Rewards and refunds are credited to your prepay credit, not sent to your wallet. Measured on the aggregator's test network, `drawJury` uses about 2.3 to 2.9 million gas (it sends the requests to the drawn arbiters), `promote` about 0.75 million and `settle` about 0.25 million.

#### 5. If the Round Misses Its Deadline
The deadline is the round's timeout after the draw (`getJury(aggId)`; 300 seconds for Small, Medium and Large, 600 for Jumbo), extended when needed so that promoted arbiters always get time to reveal. The page shows it as a countdown. If the round has not finished by then:

- **Too few commits, or too few reveals**: the page asks your wallet to send `settle(aggId)`. It fails the round and credits the unspent part of the prepayment to your prepay credit. The page then shows **"No result: the round failed."**, with a link to the transaction and the amount that came back
- **Enough commits, but the commit phase was not closed, or it closed and was not promoted**: the round fails and the unspent prepayment goes to the **treasury**, not back to you (a refund here would let a requester re-roll a jury it did not like). Settling it would return nothing to you, so the page does not ask your wallet to; it shows **"No result: the round can no longer finish."**
- A round whose jury cannot be drawn (no eligible arbiter at all) fails at the draw, and the prepayment is credited back to you. With some, but fewer than K, eligible arbiters the jury repeats arbiters instead
- **Jumbo (beacons) only**: if fewer than 2 of the 4 beacons answer within 120 seconds of the beacon stage's start, your second `drawJury` ends the round with no result. The beacon that answered is paid, and the rest of the prepayment goes to the treasury. If fewer than 2 beacon candidates qualify, the round fails at once and is refunded. If the jury cannot be drawn after the beacon stage, the prepayment is refunded only when the keeper's selection walk covers the whole class list; otherwise it goes to the treasury

#### 6. If You Decline a Transaction or Leave the Page
- **If you decline** one of these transactions, or it cannot be sent, the page stops and shows **"The round is waiting for ..."** (the jury draw, the commits to be promoted, ...). It says why nothing was sent, what the call does and who earns what, the round ID and the aggregator's address, and offers a button such as **"Draw the jury (wallet transaction)"** that picks the round up where it is. You can also make the call from any other wallet or tool: anyone may
- **If you switch to another tab of the application**, the page keeps driving the round in the background
- **If you close or reload the page**, nothing moves the round on from this browser. The page remembers the round in the browser's storage, and when you come back it shows **"The round is still open."** with a **"Resume the round"** button. Meanwhile:
    - an **undrawn round never times out**. After 30 seconds anyone may draw it (and earns the draw reward). If nobody does, the jury can no longer be drawn a day after the request, and the round can only be cancelled (`cancelUnsealed`), which sends the whole prepayment to the treasury
    - a round waiting for `closeCommits` or `promote` can be moved on by anyone (`promote` pays its caller). If nobody does before the deadline, the unspent prepayment goes to the treasury
    - a round that misses its deadline in the reveal phase is settled by anyone who calls `settle`, or by a later request to the same aggregator, and the unspent prepayment is credited to you either way

### Status Messages

During execution, you'll see various status updates:
- **"Processing..."**: Initial setup
- **"Building archive from config..."**, **"Creating ZIP package..."**, **"Uploading ZIP to server..."**: Packaging and uploading your query (Method 1)
- **"Uploading file to server..."**: Uploading your ZIP file (Method 2)
- **"Applying ... ETH credit; attaching ... ETH…"**: Part of the prepayment comes from your prepay credit
- **"Fully covered by your existing prepay credit — no ETH needed beyond gas…"**: Your credit covers the whole prepayment
- **"Confirm the request in your wallet..."**: Submitting the query
- **"Waiting for confirmation..."**: Transaction mining
- **"Request confirmed. Waiting two blocks before the jury can be drawn..."**: The draw is allowed from block B+2
- **"Confirm drawJury in your wallet..."**: Your wallet is asked to draw the jury; the message says what the call earns
- **"Waiting for the beacon values (up to 2 minutes)..."**: Only for rounds with beacons
- **"Waiting for the arbiters to commit (N so far)..."**: The commit phase
- **"Confirm closeCommits in your wallet..."**, **"Confirm promote in your wallet..."**: The next phase needs your wallet
- **"Waiting for the arbiters to reveal their answers..."**: The reveal phase
- **"The round missed its deadline. Confirm settle in your wallet..."**: See [If the Round Misses Its Deadline](#5-if-the-round-misses-its-deadline)
- **"Waiting for ... to be mined..."**: One of these transactions is being mined
- **"Fetching justification from server..."**: Retrieving results

### Error Handling

Common errors and solutions:

#### "Insufficient ETH"
- **Cause**: Your wallet holds less ETH than the prepayment, or the transaction was sent with too little ETH (the contract's `InsufficientPayment` error)
- **Solution**: Add ETH to your wallet and try again. The message states the amount needed

#### "BadInput"
- **Cause**: The aggregator rejected the request parameters: the estimated base cost must be below the fee ceiling, alpha at most 1000, the scaling factor between 1 and 65535, and the query 1 to 10 CIDs with an addendum of at most 1000 characters
- **Solution**: Check the parameters, or contact the administrator

#### "User rejected transaction"
- **Cause**: You declined the query transaction in MetaMask
- **Solution**: Try again and approve the transaction

#### "The round is waiting for ..."
- **Cause**: A transaction that moves the round on (draw, close, promote or settle) was declined, could not be sent, or failed
- **Solution**: Use the button in the notice, or make the named call with the round ID on the aggregator from any wallet. See [If You Decline a Transaction or Leave the Page](#6-if-you-decline-a-transaction-or-leave-the-page)

#### "No result: the round failed."
- **Cause**: The round ended without a result. The notice says in which phase, and where the unspent prepayment went: back to your prepay credit, or to the treasury
- **Solution**: You can try again. Prepay credit is applied to your next query

#### "No result: the round can no longer finish." / "the round was cancelled."
- **Cause**: The commit phase was not closed or not promoted in time, or the jury was not drawn within a day. The prepayment goes to the treasury
- **Solution**: Run the query again, and keep the page open until the result arrives

#### Network or connectivity issues
- **Solution**: Check internet connection and try again

## Cost Considerations

### Fee Components
- **Evaluation Fee**: Paid in ETH to the arbiters that evaluate your query, out of a prepayment sent with the query
- **Gas Fees**: Blockchain transaction costs (paid in ETH), for the query and for each transaction that moves the round on
- **Rewards back to you**: The draw reward (2 × the fee ceiling) and the promote reward (1 × the fee ceiling) are part of the prepayment. When your wallet makes those calls, they come back to your prepay credit

### How the Prepayment Works
- The application sets a fee ceiling of 0.0001 ETH per arbiter (`MAX_FEE` in `client/src/App.js`), clamped by the aggregator to its `maxOracleFee()`, and no fee floor (`MIN_FEE = 0`)
- The aggregator's worst case is `maxTotalFee(maxFee, minFee, withBeacons, K, P)` = max(fee, floor) × (K + B × P [+ beacon quorum]) + fee × (2 + 1), where K arbiters are drawn and P are paid a bonus of B times their fee (the request's jury), and 2 and 1 are the draw and promote rewards. With the Small jury (K = 6, P = 3) and B = 3 that is 0.0001 × 15 + 0.0001 × 3 = 0.0018 ETH; with Jumbo (K = 50, P = 17, beacons) 0.0001 × 103 + 0.0001 × 3 = 0.0106 ETH. The banner at the top of the page shows the amount the contract returns
- The round then costs what the drawn arbiters charge: each of the K arbiters drawn is credited its own fee (at least the floor), and each arbiter whose revealed answer is in the winning cluster gets B times its fee on top
- The rest of the prepayment is returned as **prepay credit** held in the aggregator, when the round finalizes or is settled, except in the cases listed in [If the Round Misses Its Deadline](#5-if-the-round-misses-its-deadline) and [If You Decline a Transaction or Leave the Page](#6-if-you-decline-a-transaction-or-leave-the-page), where it goes to the treasury. Credit is applied automatically to your next query, and the **"Withdraw credit"** button on this page sends it back to your wallet

### Cost Factors
- **Arbiter fees**: Set by the arbiters that are drawn, up to the application's fee ceiling
- **Outcome of the round**: A completed round pays bonuses to the clustered arbiters; a failed round pays base fees only
- **Who moves the round**: The draw and promote rewards come back to you only when your wallet makes those calls (the draw reward only within 30 seconds)
- The number of AI models, runs per model, iterations and the size of the query do not change the on-chain fee
## Best Practices

### Before Running
- **Review Configuration**: Double-check all settings in the summary
- **Test with Simple Queries**: Start with basic queries to understand the process
- **Check Wallet Balance**: Ensure sufficient ETH for the prepayment and gas fees

### During Execution
- **Stay Connected**: Keep browser tab active during evaluation
- **Don't Refresh**: The page, not the blockchain, moves the round on. After a refresh it offers to resume the round, but nothing moves it in the meantime
- **Confirm Promptly**: The draw reward is yours only if the draw is confirmed within 30 seconds of the request
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