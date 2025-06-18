# Run Query

The Run Query page is where you execute your AI jury evaluation. You can choose from three different methods to run your query, each suited to different use cases and workflows.

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
- **Network**: Automatically switches to Base Sepolia if needed
- **LINK Tokens**: Contract must have sufficient LINK for AI service fees

### Transaction Steps

#### 1. Network Check
- Application automatically switches to Base Sepolia network
- MetaMask will prompt for network change if needed

#### 2. LINK Token Approval
- System requests approval to spend LINK tokens
- This is a separate transaction from the main query execution
- Approve the maximum amount requested for seamless operation

#### 3. Query Execution
- Main transaction submits your query to the blockchain
- Gas fees are automatically calculated with appropriate buffers
- Transaction includes all query data and configuration

#### 4. Evaluation Wait
- 5-minute countdown timer shows remaining time
- Status updates show current evaluation progress
- System polls for results every 5 seconds

#### 5. Automatic Timeout Handling
- If no response after 5 minutes, timeout transaction is sent
- This marks the request as failed on the blockchain
- You're notified if timeout occurs

### Status Messages

During execution, you'll see various status updates:
- **"Processing..."**: Initial setup
- **"Checking contract funding..."**: Verifying LINK balance
- **"Requesting LINK approval..."**: LINK token approval step
- **"Sending transaction..."**: Submitting main transaction
- **"Waiting for confirmation..."**: Transaction mining
- **"Waiting for evaluation results..."**: AI processing
- **"Fetching justification..."**: Retrieving results

### Error Handling

Common errors and solutions:

#### "Insufficient LINK tokens"
- **Cause**: Contract doesn't have enough LINK to pay for AI services
- **Solution**: Contact administrator to fund the contract

#### "User rejected transaction"
- **Cause**: You declined the transaction in MetaMask
- **Solution**: Try again and approve the transaction

#### "Evaluation results not received in time"
- **Cause**: AI services didn't respond within 5 minutes
- **Solution**: System automatically handles timeout; you can try again

#### Network or connectivity issues
- **Solution**: Check internet connection and try again

## Cost Considerations

### Fee Components
- **Gas Fees**: Blockchain transaction costs (paid in ETH)
- **LINK Fees**: AI service costs (paid in LINK tokens by the contract)
- **Processing Fees**: Based on query complexity and jury configuration

### Cost Factors
- **Number of AI models**: More models = higher LINK costs
- **Runs per model**: Multiple runs increase costs linearly
- **Iterations**: Multiple iterations multiply costs
- **Query complexity**: Longer queries and more supporting data cost more

### Fee Optimization
- Use single models for testing
- Start with minimal configurations
- Increase complexity gradually as needed

## Best Practices

### Before Running
- **Review Configuration**: Double-check all settings in the summary
- **Test with Simple Queries**: Start with basic queries to understand the process
- **Check Wallet Balance**: Ensure sufficient ETH for gas fees

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
2. Verify network (should be Base Sepolia)
3. Ensure sufficient ETH balance for gas
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