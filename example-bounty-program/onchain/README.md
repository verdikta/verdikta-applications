# BountyEscrow Smart Contracts

Smart contracts for the Verdikta AI-Powered Bounty Program.

## Overview

The `BountyEscrow` contract manages the full lifecycle of AI-evaluated bounties:
- Accepts ETH deposits and locks them in escrow
- Coordinates with Verdikta Aggregator for AI evaluations
- Automatically pays winners based on evaluation results
- Enforces cancellation rules and timeout handling

## Contracts

### BountyEscrow.sol
Main contract that handles bounty creation, submissions, and payments.

**Key Features:**
- ✅ ETH escrow with minimum amount validation
- ✅ 24-hour cancellation lockout period
- ✅ Integration with Verdikta Aggregator for AI evaluation
- ✅ Automatic winner payout on passing evaluation
- ✅ Timeout handling with refunds
- ✅ Reentrancy protection
- ✅ Owner controls for contract upgrades

### interfaces/IVerdiktaAggregator.sol
Interface for interacting with the Verdikta AI evaluation system.

## Development Status

**Current Status:** 🟡 Interface Complete, Implementation Pending

- [x] Contract structure defined
- [x] State variables and data structures
- [x] Function signatures with NatSpec documentation
- [x] Events defined
- [ ] **TODO**: Implementation of all functions
- [ ] **TODO**: Comprehensive test suite
- [ ] **TODO**: Gas optimization
- [ ] **TODO**: Security audit

## Setup

### Prerequisites
- Node.js >= 18
- npm or yarn

### Installation

```bash
cd contracts
npm install
```

### Configuration

Copy `env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required environment variables:
- `PRIVATE_KEY` - Deployer wallet private key
- `VERDIKTA_AGGREGATOR_ADDRESS` - Deployed Verdikta Aggregator contract
- `LINK_TOKEN_ADDRESS` - LINK token address on target network
- `BASESCAN_API_KEY` - For contract verification

## Usage

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
npm test
```

**Note:** Tests are currently scaffolded with TODOs. Implementation needed.

### Deploy

Deploy to Base Sepolia:

```bash
npm run deploy:sepolia
```

Deploy to Base Mainnet:

```bash
npm run deploy:base
```

### Verify Contract

After deployment, verify on Basescan:

```bash
npm run verify
```

## Contract Architecture

```
BountyEscrow
    ├─ State: bounties, submissions, mappings
    ├─ Create Bounty (payable)
    │   └─ Lock ETH, set cancellation lock
    ├─ Submit & Evaluate
    │   ├─ Check LINK approval
    │   ├─ Call Verdikta Aggregator
    │   └─ Create submission record
    ├─ Fulfill Evaluation (Verdikta callback)
    │   ├─ Parse AI result
    │   ├─ If PASS: Pay hunter, close bounty
    │   └─ If FAIL: Keep bounty open
    ├─ Handle Timeout
    │   └─ Refund on evaluation timeout
    └─ Cancel Bounty
        ├─ Check: 24h passed, no active evaluations
        └─ Refund ETH to creator
```

## Key Data Structures

### Bounty
```solidity
struct Bounty {
    address creator;
    uint256 payoutAmount;
    string rubricCid;
    uint64 classId;
    BountyStatus status;
    uint256 createdAt;
    uint256 cancelLockUntil;
    bytes32 winningSubmission;
}
```

### Submission
```solidity
struct Submission {
    uint256 bountyId;
    address hunter;
    string deliverableCid;
    bytes32 verdiktaRequestId;
    uint256 submittedAt;
    SubmissionStatus status;
    uint8 score;
    string reportCid;
}
```

## Security Considerations

### Implemented
- ✅ ReentrancyGuard on payable functions
- ✅ Ownable for admin functions
- ✅ Minimum bounty amount to prevent dust
- ✅ 24-hour cancellation lock
- ✅ Verdikta-only callback restriction

### TODO
- [ ] Comprehensive test coverage
- [ ] Gas optimization review
- [ ] External security audit
- [ ] Formal verification (optional)

## Testing Checklist

- [ ] Bounty creation with valid/invalid parameters
- [ ] ETH escrow and refunds
- [ ] Submission with LINK approval flow
- [ ] Verdikta callback handling (pass/fail)
- [ ] Timeout handling
- [ ] Cancellation rules (timing, permissions, state)
- [ ] Multiple submissions to same bounty
- [ ] Reentrancy attack prevention
- [ ] Gas consumption analysis
- [ ] Edge cases and error conditions

## Network Addresses

### Base Sepolia (Testnet)
- LINK Token: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`
- Verdikta Aggregator: TBD
- BountyEscrow: TBD (after deployment)

### Base Mainnet
- LINK Token: `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196`
- Verdikta Aggregator: TBD
- BountyEscrow: TBD (after deployment)

## Gas Estimates

(To be measured after implementation)

| Function | Estimated Gas |
|----------|---------------|
| createBounty | TBD |
| submitAndEvaluate | TBD |
| fulfillEvaluation | TBD |
| cancelBounty | TBD |
| markEvaluationTimeout | TBD |

## Next Steps

1. **Implement Core Functions**
   - Start with `createBounty()` and `getBounty()`
   - Add submission logic
   - Implement Verdikta integration
   - Add cancellation and timeout handling

2. **Write Tests**
   - Fill in test TODOs in `test/BountyEscrow.test.js`
   - Aim for >90% coverage
   - Test all edge cases

3. **Deploy to Testnet**
   - Deploy to Base Sepolia
   - Test with real Verdikta Aggregator
   - Verify all functions work end-to-end

4. **Security Review**
   - Self-audit checklist
   - External audit (if budget permits)
   - Address any findings

5. **Mainnet Deployment**
   - Final testing
   - Deploy to Base Mainnet
   - Verify contract on Basescan

## Resources

- [Hardhat Documentation](https://hardhat.org/docs)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts)
- [Verdikta Documentation](../../../docs/user-guide.md)
- [Base Network](https://base.org)
- [Chainlink LINK Token](https://chain.link)

## License

MIT

