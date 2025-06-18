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
- **Network**: Automatically switches to Base Sepolia testnet
- **Accounts**: Manages wallet connection and account switching
- **Transactions**: Handles signing and broadcasting

#### Smart Contract Interface
```javascript
// Contract interaction example
const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
const tx = await contract.requestAIEvaluationWithApproval(
  cidArray,
  textAddendum,
  alpha,
  maxFee,
  estimatedBaseCost,
  maxFeeBasedScalingFactor,
  selectedContractClass
);
```

#### Key Contract Methods
- `requestAIEvaluationWithApproval()`: Submit evaluation request
- `getEvaluation()`: Retrieve evaluation results
- `getContractConfig()`: Get contract configuration
- `maxTotalFee()`: Calculate required LINK approval amount

### LINK Token Integration

#### Token Approval Process
```javascript
// LINK token approval
const linkContract = new ethers.Contract(linkTokenAddress, LINK_TOKEN_ABI, signer);
const tx = await linkContract.approve(aggregatorAddress, requiredAmount);
```

#### Fee Management
- **Gas Fees**: Paid by user in ETH for blockchain transactions
- **LINK Fees**: Paid by contract for AI evaluation services
- **Fee Calculation**: Dynamic based on query complexity and jury size

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
3. **Oracle Processing**: Chainlink oracle picks up the request
4. **AI Evaluation**: Multiple AI models process the query
5. **Result Aggregation**: Responses combined using weighted voting
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
- **Insufficient Funds**: Inadequate ETH or LINK balances
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