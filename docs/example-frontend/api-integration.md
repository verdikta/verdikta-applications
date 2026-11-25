# API Integration

The AI Jury System integrates with multiple APIs and services to provide comprehensive evaluation capabilities. This guide covers the technical integration points and how they work together.

## Architecture Overview

### Core Services Integration

The application integrates with four main service categories:

1. **Blockchain Services** - Smart contract interaction via Ethereum
2. **AI Provider APIs** - Various AI model providers for evaluations
3. **IPFS Network** - Decentralized storage for queries and results
4. **Backend Services** - Application server for file management

## Blockchain Integration

### Ethereum Network Connection

#### MetaMask Integration
- **Provider**: Uses `ethers.BrowserProvider` to connect with MetaMask
- **Network**: Automatically switches the wallet to the network selected in the header, Base or Base Sepolia
- **Accounts**: Manages wallet connection and account switching
- **Transactions**: Handles signing and broadcasting

#### Smart Contract Interface
The application talks to Verdikta's v2 `ReputationAggregator` (the ABI is in `client/src/utils/contractUtils.js`). The v1 aggregators are not compatible.

```javascript
// Contract interaction example
const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
const tx = await contract.requestAIEvaluationWithApproval(
  cidArray,
  textAddendum,
  alpha,
  maxFee,
  minFee,                // fee floor per juror, 0 = none
  estimatedBaseCost,
  maxFeeBasedScalingFactor,
  selectedContractClass,
  withBeacons,           // beacon stage before the draw
  jury,                  // { K, M, N, P, timeout }: the jury this request asks for
  { value: ethValue, gasLimit: 4500000 } // ethValue: the ETH prepayment, see "ETH Payment" below
);
const receipt = await tx.wait();
const aggId = receipt.logs
  .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
  .find((e) => e?.name === 'RequestAIEvaluation').args.aggRequestId;
```

The application calls it with `alpha` = 500, `maxFee` = 0.0001 ETH, `minFee` = 0, `estimatedBaseCost` = 1% of `maxFee`, `maxFeeBasedScalingFactor` = 10 (`client/src/App.js`), and the arbiter class chosen on the Jury Selection page (128 by default). The jury and `withBeacons` come from the **Arbiter jury size** setting on the Jury Selection page (`client/src/utils/juryPresets.js`): Small `{ K: 6, M: 5, N: 4, P: 3, timeout: 300 }` without beacons by default; Medium 8/5/4/3, 300 s; Large 21/16/13/10, 300 s; Jumbo 50/38/27/17, 600 s with beacons.

One aggregator serves every jury size. It refuses a request with `BadJury` unless K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, P ≥ 2 (unless N = 1), K ≤ `maxJury()` and the keeper's shortlist (60), and `tPlus()` < timeout ≤ `maxTimeout()`. With fewer than K eligible arbiters the draw repeats arbiters; only a class with none eligible fails the draw (refunded).

#### Moving the Round On
A v2 request only prepays the round. The requester then moves it from phase to phase; the Run Query page does this with the user's wallet (`client/src/utils/timeoutUtils.js`, `driveRound()`), dry-running each call with `estimateGas` from the user's address and sending only a call that will succeed:

```javascript
// phase 1 (draw): from block B+2 of the request. Within 30 s only the requester earns 2 x fee.
await contract.drawJury(aggId);          // with beacons: once to start the stage, again once the values are in
// phase 3 (commit): only when T+ is over with >= M commits and the window did not close by itself
await contract.closeCommits(aggId);
// phase 4 (closing): from the close block + 2. The caller earns 1 x fee.
await contract.promote(aggId);
// phase 6 (final): the result
const [aggregated, justifications, valid] = await contract.getEvaluation(aggId);
// past the deadline without a result: fail the round and credit the unspent prepay
await contract.settle(aggId);
```

#### Key Contract Methods
- `requestAIEvaluationWithApproval()`: Submit evaluation request (10 arguments, the last the jury `(K, M, N, P, timeout)`; `payable`)
- `maxTotalFee(maxFee, minFee, withBeacons, K, P)`: Worst-case fee in ETH (wei) that must be prepaid with a request for that jury
- `drawJury()`, `closeCommits()`, `promote()`: Move a round on (anyone may call them)
- `settle()`: After a round's deadline: fail it if it has no result (crediting the unspent prepayment, see below) and report every slot's outcome to the keeper. A later request to the same aggregator also settles due rounds
- `getRoundInfo()`: The round's phase (1 draw, 2 beacons, 3 commit, 4 closing, 5 reveal, 6 final, 7 settled, 8 failed, 9 cancelled), blocks, escrow, deadline, commit window end, commits and request time
- `getEvaluation()`: Retrieve evaluation results, valid from phase 6
- `getJury(aggId)`: The jury a round was requested with, `(K, M, N, P, timeout)`; the deadline is its timeout after the draw. The aggregator has no `K()`…`P()` or round timeout of its own
- `maxJury()`, `maxTimeout()`, `tPlus()`, `maxOracleFee()`: The owner's bounds on a request's jury (largest K, longest timeout, the commit window every timeout must exceed) and the fee ceiling (v2 has no `getContractConfig()`)
- `ethOwed()`: ETH credit an address holds in the aggregator (refunds and rewards)
- `withdrawEth()`: Send the caller's credit back to the caller

### ETH Payment

There is no token approval. `requestAIEvaluationWithApproval()` keeps its historical name but is `payable`: the fee travels with the call as ETH.

#### Prepayment and Credit
```javascript
// Worst-case fee for this request, and the credit already held
const required = await contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
// = max(fee, minFee) x (K + B x P [+ beacon quorum]) + fee x (2 + 1); 0.0018 ETH with the defaults (Small jury)
const credit = await contract.ethOwed(walletAddress);
const ethValue = required > credit ? required - credit : 0n;  // sent as the transaction's value; credit covers the rest

// Later: take unused credit back
await contract.withdrawEth();
```

#### Fee Management
- **Gas Fees**: Paid by user in ETH for the request and for each call that moves the round on
- **Evaluation Fees**: Paid by the user in ETH, out of the prepayment. Each of the K drawn arbiters is credited its fee (at least the floor), and each arbiter in the winning cluster B times its fee on top; the rest of the prepayment is credited back to the user in the aggregator, except for a round that had enough commits but was not closed or promoted in time, a missed beacon quorum, or a cancelled round, where it goes to the treasury
- **Rewards**: The draw reward (2 × the fee ceiling) and the promote reward (1 × the fee ceiling) are credited to whoever makes those calls; with the Run Query page that is the user
- **Fee Calculation**: Set by the fees of the drawn arbiters and the jury size (K arbiters paid, P bonuses), not by query complexity

## AI Provider APIs

### Supported Providers

The system supports multiple AI providers through a unified interface:

#### OpenAI
- **Models**: GPT-3.5-turbo, GPT-4, GPT-4o
- **API**: OpenAI REST API
- **Authentication**: API key management
- **Rate Limits**: Handled by backend service

#### Anthropic
- **Models**: Claude-2.1, Claude-3-Sonnet, Claude-3.5-Sonnet
- **API**: Anthropic REST API
- **Authentication**: API key management
- **Rate Limits**: Managed by service layer

#### Open-Source Models
- **Models**: LLaVA, Llama-3.1, Llama-3.2, Phi3
- **Infrastructure**: Self-hosted or third-party providers
- **API**: Custom API endpoints
- **Scaling**: Load balancing for high availability

### Request Flow

1. **Query Package**: Frontend packages query with supporting data
2. **Blockchain Submission**: Transaction submitted to smart contract
3. **Jury Draw**: `drawJury` draws the request's K arbiters, and each arbiter's Chainlink operator picks up the request
4. **AI Evaluation**: On each arbiter, its AI models process the query (combined by their weights) and the arbiter commits a hash of its answer
5. **Result Aggregation**: M commits are promoted and reveal; once N reveals are in, the aggregator takes the tightest cluster of P of them and averages it
6. **Blockchain Storage**: Results stored on-chain with IPFS references

## IPFS Integration

### Content Storage

#### Query Packages
- **Format**: ZIP archives containing query data and configuration
- **Structure**: Manifest-based organization with metadata
- **Persistence**: Immutable storage with content addressing

#### Supporting Files
- **Upload**: Files uploaded to IPFS via backend service
- **References**: CIDs included in query packages
- **Access**: Direct IPFS gateway access for retrieval

#### Result Storage
- **Justifications**: AI jury reasoning stored as IPFS content
- **Metadata**: Evaluation timestamps and configuration data
- **Linking**: Results linked to original query packages

### IPFS Gateway Access

#### Primary Gateways
- **Application Server**: Custom IPFS node for reliable access
- **Public Gateways**: Fallback to ipfs.io and other public gateways
- **CDN Integration**: Cached content delivery for better performance

#### Content Retrieval
```javascript
// Fetch content from IPFS
const response = await fetchWithRetry(cid);
const content = await response.text();
```

## Backend Services

### Server API Endpoints

#### File Upload
- **Endpoint**: `POST /api/upload`
- **Purpose**: Upload files and query packages to IPFS
- **Response**: Returns IPFS CID for uploaded content
- **Progress**: Supports upload progress tracking

#### Content Retrieval
- **Endpoint**: `GET /api/fetch/:cid`
- **Purpose**: Retrieve content from IPFS with reliability
- **Caching**: Server-side caching for improved performance
- **Fallback**: Multiple gateway attempts for high availability

#### Contract Management
- **Endpoint**: `GET /api/contracts`
- **Purpose**: Retrieve available smart contract configurations
- **Caching**: Contract data cached for performance
- **Validation**: Real-time contract status checking

### Request Handling

#### Retry Logic
```javascript
const fetchWithRetry = async (cid, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${SERVER_URL}/api/fetch/${cid}`);
      if (response.ok) return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};
```

#### Error Handling
- **Network Failures**: Automatic retry with exponential backoff
- **Timeout Management**: Configurable timeout periods
- **Fallback Strategies**: Alternative gateways and endpoints
- **User Feedback**: Clear error messages and recovery suggestions

## Data Flow

### Query Submission Process

1. **Frontend Validation**: Input validation and sanitization
2. **Package Creation**: ZIP archive generation with manifest
3. **Upload**: Package uploaded to IPFS via backend
4. **Transaction**: Blockchain transaction with CID reference
5. **Oracle Trigger**: Smart contract event triggers oracle processing
6. **AI Processing**: Multiple AI models evaluate the query
7. **Result Storage**: Outcomes and justifications stored on IPFS
8. **Notification**: Blockchain event notifies frontend of completion

### Result Retrieval Process

1. **Event Monitoring**: Frontend polls for evaluation completion
2. **CID Extraction**: Result CID extracted from blockchain event
3. **Content Fetch**: Justification content retrieved from IPFS
4. **Parsing**: JSON and text content parsed and formatted
5. **Display**: Results displayed with interactive visualizations

## Security Considerations

### Authentication and Authorization

#### Wallet-Based Authentication
- **MetaMask**: Primary authentication via wallet signatures
- **Address Verification**: User identity verified through wallet address
- **Session Management**: Wallet connection state maintained

#### Contract Permissions
- **Access Control**: Smart contracts may implement role-based access
- **Class-Based Features**: Contract classes determine available functionality
- **Admin Functions**: Restricted operations require elevated permissions

### Data Security

#### Input Sanitization
- **XSS Prevention**: All user inputs sanitized before display
- **File Validation**: Uploaded files validated for type and size
- **URL Validation**: Reference URLs validated for format and safety

#### Privacy Considerations
- **Public Storage**: IPFS content is publicly accessible
- **Metadata**: Query metadata stored on public blockchain
- **Sensitive Data**: Avoid including confidential information

## Performance Optimization

### Caching Strategies

#### Browser Caching
- **Contract Data**: Smart contract information cached locally
- **IPFS Content**: Frequently accessed content cached
- **User Settings**: Preferences stored in local storage

#### Server-Side Caching
- **IPFS Gateway**: Content cached at gateway level
- **API Responses**: Cacheable responses stored for reuse
- **Contract Status**: Smart contract state cached with TTL

### Load Balancing

#### Multiple Gateways
- **Redundancy**: Multiple IPFS gateways for reliability
- **Geographic Distribution**: Region-based gateway selection
- **Health Monitoring**: Automatic failover for unavailable gateways

#### Rate Limiting
- **API Throttling**: Respect provider rate limits
- **Queue Management**: Request queuing for high-volume scenarios
- **Backoff Strategies**: Intelligent retry timing

## Error Handling

### Common Error Scenarios

#### Network Issues
- **Connectivity**: Internet connection problems
- **Gateway Failures**: IPFS gateway unavailability
- **Blockchain RPC**: Ethereum node connectivity issues

#### Service Errors
- **AI Provider Limits**: Rate limiting or quota exhaustion
- **Contract Failures**: Smart contract execution errors
- **Storage Issues**: IPFS upload or retrieval failures

#### User Errors
- **Invalid Input**: Malformed queries or data
- **Insufficient Funds**: Inadequate ETH balance for the prepayment and gas
- **Permission Denied**: Unauthorized access attempts

### Recovery Strategies

#### Automatic Recovery
- **Retry Logic**: Automatic retries with exponential backoff
- **Fallback Services**: Alternative endpoints and providers
- **Graceful Degradation**: Reduced functionality when services unavailable

#### User-Initiated Recovery
- **Manual Retry**: User can retry failed operations
- **Alternative Methods**: Multiple ways to achieve same result
- **Clear Instructions**: Helpful error messages with next steps

## Monitoring and Debugging

### Logging and Analytics

#### Client-Side Logging
- **Console Logs**: Detailed logging for development
- **Error Tracking**: Comprehensive error reporting
- **Performance Metrics**: Timing and performance data

#### Server-Side Monitoring
- **Request Logs**: All API requests logged with details
- **Error Rates**: Monitoring of failure rates and patterns
- **Performance Tracking**: Response times and throughput metrics

### Debugging Tools

#### Development Tools
- **Browser DevTools**: Network and console debugging
- **MetaMask Integration**: Transaction and account debugging
- **IPFS Tools**: Content inspection and validation

#### Production Monitoring
- **Health Checks**: Automated service health monitoring
- **Alert Systems**: Notifications for critical failures
- **Dashboard Metrics**: Real-time system status visualization 