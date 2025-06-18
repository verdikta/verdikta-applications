# Architecture

The AI Jury System is a decentralized application that combines blockchain technology, AI services, and distributed storage to provide transparent and reliable AI-powered evaluations.

## System Overview

### High-Level Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Web Frontend  │    │   Backend API    │    │   IPFS Network  │
│   (React App)   │◄──►│   (Node.js)      │◄──►│   (Storage)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        
         ▼                        ▼                        
┌─────────────────┐    ┌──────────────────┐               
│   MetaMask      │    │   Smart Contract │               
│   (Wallet)      │◄──►│   (Blockchain)   │               
└─────────────────┘    └──────────────────┘               
                                │                          
                                ▼                          
                    ┌──────────────────┐                  
                    │   AI Providers   │                  
                    │   (OpenAI, etc.) │                  
                    └──────────────────┘                  
```

## Core Components

### Frontend Application

#### Technology Stack
- **React**: User interface framework
- **Ethers.js**: Blockchain interaction library
- **Chart.js**: Data visualization
- **React Router**: Client-side routing

#### Key Features
- **Responsive UI**: Works on desktop and mobile devices
- **Real-time Updates**: Live transaction status and progress tracking
- **Wallet Integration**: Seamless MetaMask connection
- **File Management**: Upload and manage supporting documents

#### Component Architecture
```
App.js (Root Component)
├── Header (Navigation & Wallet)
├── QueryDefinition (Query Input)
├── JurySelection (AI Model Config)
├── RunQuery (Execution)
├── Results (Display Outcomes)
└── ContractManagement (Admin)
```

### Backend Services

#### API Server (Node.js)
- **Express.js**: Web framework for API endpoints
- **IPFS Client**: Interface to IPFS network
- **File Processing**: Handle uploads and downloads
- **CORS Support**: Cross-origin request handling

#### Key Endpoints
- `POST /api/upload`: Upload files to IPFS
- `GET /api/fetch/:cid`: Retrieve content from IPFS
- `GET /api/contracts`: List available contracts

### Blockchain Layer

#### Smart Contracts
- **Aggregator Contract**: Main evaluation logic
- **Oracle Integration**: Chainlink oracle connectivity
- **Event System**: Transaction and result notifications
- **Access Control**: Permission management

#### Key Functions
- `requestAIEvaluationWithApproval()`: Submit evaluation requests
- `getEvaluation()`: Retrieve evaluation results
- `getContractConfig()`: Get configuration parameters

### Storage Layer

#### IPFS (InterPlanetary File System)
- **Content Addressing**: Immutable content identification
- **Distributed Storage**: Decentralized file storage
- **Gateway Access**: Multiple access points for reliability

#### Content Types
- **Query Packages**: ZIP archives with query data
- **Supporting Files**: Documents, images, data files
- **Results**: AI justifications and metadata

## Data Flow

### Query Submission Workflow

1. **User Input**: User creates query with supporting materials
2. **Package Creation**: Frontend packages data into standardized format
3. **IPFS Upload**: Package uploaded to distributed storage
4. **Blockchain Transaction**: Smart contract called with package reference
5. **Oracle Processing**: Chainlink oracle picks up evaluation request
6. **AI Evaluation**: Multiple AI models process the query
7. **Result Storage**: Outcomes stored on blockchain and IPFS
8. **User Notification**: Frontend displays results

### Data Structure

#### Query Package Format
```json
{
  "manifest": {
    "version": "1.0",
    "primary": {"filename": "primary_query.json"},
    "juryParameters": {
      "NUMBER_OF_OUTCOMES": 2,
      "AI_NODES": [...],
      "ITERATIONS": 1
    }
  },
  "primaryQuery": {
    "query": "Question text",
    "outcomes": ["Option A", "Option B"],
    "references": [...]
  }
}
```

#### Result Format
```json
{
  "outcomes": [600000, 400000],
  "justification": "Detailed reasoning...",
  "timestamp": "2024-01-01T12:00:00Z",
  "metadata": {
    "queryPackageCid": "Qm...",
    "evaluationId": "0x..."
  }
}
```

## Integration Points

### Blockchain Integration

#### Network: Base Sepolia Testnet
- **Chain ID**: 84532
- **RPC URL**: Provided by Ethereum node providers
- **Block Time**: ~2 seconds
- **Gas Token**: ETH

#### Token Integration
- **LINK Token**: Payment for AI services
- **Contract Address**: 0x779877A7B0D9E8603169DdbD7836e478b4624789
- **Approval Pattern**: ERC-20 allowance mechanism

### AI Provider Integration

#### Multi-Provider Support
- **OpenAI**: GPT models via REST API
- **Anthropic**: Claude models via REST API
- **Open Source**: Various models via custom endpoints

#### Request Aggregation
- **Weighted Voting**: Results combined based on model weights
- **Consensus Building**: Multiple iterations for reliability
- **Quality Control**: Error handling and validation

### IPFS Integration

#### Gateway Configuration
- **Primary**: Application-hosted IPFS node
- **Fallback**: Public gateways (ipfs.io, cloudflare-ipfs.com)
- **Performance**: CDN integration for faster access

#### Content Management
- **Pinning**: Important content pinned for persistence
- **Garbage Collection**: Automatic cleanup of temporary files
- **Replication**: Content replicated across multiple nodes

## Security Model

### Authentication & Authorization

#### Wallet-Based Authentication
- **MetaMask Integration**: Users authenticate via wallet signatures
- **Address Verification**: User identity tied to Ethereum address
- **Session Management**: Connection state maintained in browser

#### Smart Contract Security
- **Access Control**: Role-based permissions for sensitive functions
- **Input Validation**: All inputs validated on-chain
- **Reentrancy Protection**: Standard security patterns implemented

### Data Security

#### Privacy Considerations
- **Public Storage**: IPFS content is publicly accessible
- **Metadata Privacy**: Query details stored on public blockchain
- **Sensitive Data**: Guidelines for handling confidential information

#### Input Sanitization
- **XSS Prevention**: All user inputs sanitized before display
- **File Validation**: Uploaded files checked for type and size
- **URL Validation**: External links validated for safety

## Performance Characteristics

### Scalability

#### Frontend Performance
- **Bundle Size**: Optimized for fast loading
- **Code Splitting**: Lazy loading of page components
- **Caching**: Browser caching for static assets

#### Backend Performance
- **IPFS Caching**: Content cached for faster retrieval
- **Connection Pooling**: Efficient database connections
- **Rate Limiting**: Protection against abuse

#### Blockchain Performance
- **Gas Optimization**: Efficient smart contract design
- **Batch Operations**: Multiple operations combined when possible
- **Event Filtering**: Optimized event listening

### Reliability

#### Fault Tolerance
- **Multiple Gateways**: IPFS failover mechanisms
- **Retry Logic**: Automatic retry for failed operations
- **Graceful Degradation**: Reduced functionality when services unavailable

#### Error Handling
- **User-Friendly Messages**: Clear error communication
- **Recovery Guidance**: Instructions for resolving issues
- **Logging**: Comprehensive error tracking for debugging

## Development Architecture

### Code Organization

#### Frontend Structure
```
src/
├── components/     # Reusable UI components
├── pages/         # Page-level components
├── utils/         # Utility functions and services
├── App.js         # Main application component
└── index.js       # Application entry point
```

#### Backend Structure
```
server/
├── routes/        # API route definitions
├── services/      # Business logic services
├── utils/         # Utility functions
└── server.js      # Application entry point
```

### Configuration Management

#### Environment Variables
- **Frontend**: React environment variables (REACT_APP_*)
- **Backend**: Node.js environment configuration
- **Deployment**: Environment-specific settings

#### Contract Configuration
- **Dynamic Loading**: Contracts loaded from API
- **Multi-Environment**: Support for dev/staging/production
- **Hot Swapping**: Contract switching without restart

## Future Architecture Considerations

### Scaling Enhancements
- **Microservices**: Split backend into specialized services
- **CDN Integration**: Global content delivery network
- **Load Balancing**: Distribute traffic across multiple instances

### Technology Evolution
- **Layer 2 Solutions**: Potential migration to L2 for lower costs
- **Alternative Storage**: Explore alternatives to IPFS
- **Enhanced AI**: Integration with newer AI models and providers

### Feature Expansions
- **Real-time Collaboration**: Multi-user query development
- **Advanced Analytics**: Detailed evaluation metrics
- **API Ecosystem**: Third-party integrations and webhooks 