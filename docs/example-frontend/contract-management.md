# Contract Management

The Contract Management feature allows administrators to add, configure, and manage AI Jury smart contracts. This is essential for setting up new evaluation environments or switching between different contract deployments.

## Accessing Contract Management

### From the Header
1. Click the contract dropdown in the header
2. Select **"Manage Contracts"** from the bottom of the dropdown
3. The Contract Management page will open

### When No Contracts Available
- If no contracts are configured, click the **"+"** button next to the contract dropdown
- This provides a quick way to add your first contract

## Contract Configuration

### Required Information

Each contract requires the following details:

#### Contract Address
- **Format**: Ethereum address (0x followed by 40 hexadecimal characters)
- **Example**: `0x1234567890123456789012345678901234567890`
- **Validation**: Address format is automatically verified
- **Network**: Must be deployed on Base Sepolia testnet

#### Contract Name
- **Purpose**: Human-readable identifier for the contract
- **Examples**: "Main Production", "Testing Environment", "Demo Contract"
- **Display**: Shown in the contract dropdown for easy selection
- **Uniqueness**: Names should be unique for clarity

#### Contract Class (Optional)
- **Range**: 0 to 99,999
- **Default**: 128 if not specified
- **Purpose**: Categorizes contracts by functionality or access level
- **Usage**: May affect available features or pricing

### Adding New Contracts

#### Manual Entry
1. Navigate to Contract Management page
2. Click **"Add Contract"** button
3. Fill in required fields:
   - Contract Address
   - Contract Name
   - Contract Class (optional)
4. Click **"Save"** to add the contract
5. Contract appears in the dropdown immediately

#### Validation Checks
- **Address Format**: Verifies proper Ethereum address format
- **Uniqueness**: Prevents duplicate addresses
- **Name Conflicts**: Warns about similar names
- **Network Compatibility**: Ensures contract is accessible

### Managing Existing Contracts

#### Editing Contracts
1. Find the contract in the management interface
2. Click **"Edit"** or the edit icon
3. Modify any field except the address
4. Save changes to update the configuration

#### Removing Contracts
1. Locate the contract to remove
2. Click **"Delete"** or the delete icon
3. Confirm the removal in the popup dialog
4. Contract is removed from all dropdowns

#### Reordering Contracts
- Contracts appear in the order they were added
- The first contract becomes the default selection
- Use the management interface to change display order

## Contract Information

### Contract Details

Each configured contract displays:
- **Address**: Full Ethereum address with copy functionality
- **Name**: Display name for easy identification
- **Class**: Numerical classification
- **Status**: Whether the contract is accessible
- **Network**: Blockchain network (should be Base Sepolia)

### Contract Validation

#### Automatic Checks
- **Accessibility**: Verifies contract responds to basic queries
- **Interface**: Confirms contract implements required methods
- **Network**: Validates deployment on correct blockchain
- **Funding**: Checks if contract has sufficient LINK tokens

#### Status Indicators
- **✅ Active**: Contract is working properly
- **⚠️ Warning**: Contract has issues but may still function
- **❌ Error**: Contract is not accessible or incompatible

### Contract Requirements

#### Smart Contract Interface
Contracts must implement the AI Jury interface:
- `requestAIEvaluationWithApproval()`: Main evaluation method
- `getEvaluation()`: Retrieve evaluation results
- `getContractConfig()`: Get contract configuration
- Other required interface methods

#### Funding Requirements
- **LINK Tokens**: Sufficient balance to pay for AI evaluations
- **Gas Fees**: Users need ETH for transaction costs
- **Allowances**: Proper token approvals for operation

## Best Practices

### Contract Organization

#### Environment Separation
- **Production**: Use for live evaluations and important decisions
- **Staging**: Test new features or configurations
- **Development**: Experiment with queries and settings
- **Demo**: Showcase functionality to stakeholders

#### Naming Conventions
- Use descriptive names that indicate purpose
- Include environment indicators (Prod, Test, Dev)
- Consider version numbers for contract upgrades
- Avoid confusing or ambiguous names

### Security Considerations

#### Address Verification
- **Double-check addresses**: Incorrect addresses can lose funds
- **Use trusted sources**: Only add contracts from verified deployments
- **Test small amounts**: Verify functionality before large evaluations
- **Monitor activity**: Watch for unexpected behavior

#### Access Control
- **Admin privileges**: Only authorized users should manage contracts
- **Audit trail**: Keep records of who added/modified contracts
- **Regular review**: Periodically verify all contracts are still needed
- **Remove unused**: Delete obsolete or test contracts

### Operational Guidelines

#### Contract Lifecycle
1. **Deployment**: Contract deployed to blockchain
2. **Configuration**: Added to application via management interface
3. **Testing**: Verify functionality with small test queries
4. **Production Use**: Begin normal evaluation operations
5. **Monitoring**: Regular checks for issues or needed updates
6. **Retirement**: Remove when no longer needed

#### Troubleshooting
- **Connection Issues**: Verify network and address
- **Funding Problems**: Check LINK token balance
- **Interface Errors**: Confirm contract version compatibility
- **Permission Issues**: Verify user has management privileges

## Integration with Application

### Contract Selection
- **Dropdown**: All configured contracts appear in header dropdown
- **Default**: First contract is selected automatically
- **Persistence**: Selection is remembered across sessions
- **Switching**: Change contracts anytime via dropdown

### Contract Context
- **Evaluation Scope**: Each contract maintains separate evaluation history
- **Cost Structure**: Different contracts may have different fees
- **Feature Availability**: Contract class may affect available features
- **Data Isolation**: Results are specific to each contract

### Error Handling
- **Invalid Selection**: Automatic fallback to working contracts
- **Network Issues**: Graceful handling of connectivity problems
- **Contract Failures**: Clear error messages and recovery options
- **Backup Options**: Ability to switch to alternative contracts

## Advanced Features

### Contract Classes
Different classes may provide:
- **Feature Sets**: Basic vs. advanced evaluation capabilities
- **Cost Structures**: Different pricing for different user tiers
- **Performance**: Optimized contracts for specific use cases
- **Access Levels**: Restricted functionality for certain users

### Bulk Operations
- **Import/Export**: Save and load contract configurations
- **Batch Updates**: Modify multiple contracts simultaneously
- **Configuration Sync**: Keep contracts consistent across environments
- **Backup/Restore**: Maintain contract configuration backups

### Monitoring and Analytics
- **Usage Tracking**: Monitor which contracts are used most
- **Performance Metrics**: Track evaluation speed and success rates
- **Cost Analysis**: Understand spending across different contracts
- **Error Monitoring**: Identify problematic contracts or configurations

## Troubleshooting

### Common Issues

#### "Contract not found"
- **Cause**: Invalid address or network mismatch
- **Solution**: Verify address and ensure Base Sepolia network

#### "Insufficient permissions"
- **Cause**: User lacks contract management privileges
- **Solution**: Contact administrator for proper access

#### "Invalid contract interface"
- **Cause**: Contract doesn't implement required methods
- **Solution**: Verify contract is compatible AI Jury implementation

#### "Network connection failed"
- **Cause**: Blockchain connectivity issues
- **Solution**: Check internet connection and MetaMask status

### Recovery Procedures

#### Lost Contract Configuration
1. Check browser local storage for backup data
2. Reference deployment documentation for addresses
3. Contact development team for contract information
4. Restore from configuration backups if available

#### Corrupted Settings
1. Clear browser data for the application
2. Re-add contracts from scratch
3. Verify each contract individually
4. Test functionality before production use 