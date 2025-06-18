# Verdikta Applications

A collection of reference applications demonstrating how to integrate with the Verdikta on-chain AI jury protocol. These applications showcase different approaches to building AI-powered evaluation systems using blockchain technology, IPFS, and multiple AI providers.

## 🔍 What is Verdikta?

Verdikta is a decentralized AI jury system that enables transparent, reliable, and consensus-driven evaluations. The protocol combines:

- **Blockchain Technology**: Smart contracts on Base Sepolia for transparent execution
- **AI Integration**: Multiple AI providers (OpenAI, Anthropic, open-source models) 
- **Decentralized Storage**: IPFS for immutable query and result storage
- **Oracle Networks**: Chainlink for secure off-chain AI computations

## 📁 Repository Structure

```
verdikta-applications/
├── docs/                    # Comprehensive documentation (MkDocs)
│   ├── example-frontend/    # AI Jury System documentation
│   └── mkdocs.yml          # Documentation configuration
├── example-frontend/        # React-based AI Jury System
│   ├── client/             # React frontend application
│   └── server/             # Node.js backend API
└── README.md               # This file
```

## 🚀 Applications

### Example Frontend - AI Jury System

A complete React-based web application that provides a user-friendly interface for the Verdikta AI jury protocol.

**Key Features:**
- 📝 **Query Definition**: Create questions with custom outcomes and supporting data
- 🤖 **AI Jury Configuration**: Select and configure multiple AI models
- ⚡ **Blockchain Integration**: MetaMask wallet connection and smart contract interaction
- 📊 **Results Visualization**: Interactive charts and detailed AI justifications
- 🔧 **Contract Management**: Admin interface for managing smart contracts

**Technology Stack:**
- **Frontend**: React 18, Ethers.js v6, Chart.js
- **Backend**: Node.js, Express, IPFS integration
- **Blockchain**: Base Sepolia testnet, Chainlink oracles
- **Storage**: IPFS for decentralized file storage

**[📖 View Complete Documentation →](docs/example-frontend/index.md)**

## 📚 Documentation

Comprehensive documentation is available in the `docs/` folder, organized for easy navigation and integration with the main Verdikta documentation site.

### Quick Links
- **[Getting Started Guide](docs/example-frontend/getting-started.md)** - Setup and first evaluation
- **[User Guide](docs/example-frontend/query-definition.md)** - Complete workflow walkthrough
- **[API Integration](docs/example-frontend/api-integration.md)** - Technical integration details
- **[Deployment Guide](docs/example-frontend/deployment.md)** - Production deployment instructions

### Documentation Structure
The documentation is built with MkDocs and designed to integrate seamlessly with the main Verdikta documentation site at [docs.verdikta.org](https://docs.verdikta.org).

```
docs/
├── index.md                 # Applications overview
├── mkdocs.yml              # Main configuration
└── example-frontend/       # AI Jury System docs
    ├── getting-started.md  # Setup and quick start
    ├── query-definition.md # Creating queries
    ├── jury-selection.md   # Configuring AI models
    ├── run-query.md        # Executing evaluations
    ├── results.md          # Understanding outcomes
    ├── api-integration.md  # Technical details
    ├── architecture.md     # System architecture
    └── deployment.md       # Production deployment
```

## 🛠️ Quick Start

### Prerequisites
- **Node.js** 18+ and npm 9+
- **MetaMask** browser extension
- **Base Sepolia** testnet setup with test ETH and LINK tokens

### 1. Clone and Install
```bash
git clone https://github.com/verdikta/verdikta-applications.git
cd verdikta-applications/example-frontend

# Install dependencies
cd client && npm install
cd ../server && npm install
```

### 2. Configure Environment
```bash
# Client configuration
cp client/.env.example client/.env

# Server configuration  
cp server/.env.example server/.env
```

Edit the `.env` files with your configuration:
- Smart contract addresses
- IPFS/Pinata credentials
- Network settings

### 3. Start Development Servers
```bash
# Terminal 1: Start backend server
cd server && npm run dev

# Terminal 2: Start frontend
cd client && npm start
```

Visit `http://localhost:3000` to access the application.

**[📖 Detailed Setup Instructions →](docs/example-frontend/getting-started.md)**

## 🔧 Development

### Local Documentation
To work with the documentation locally:

```bash
# Install MkDocs and plugins
pip install mkdocs mkdocs-material mkdocs-monorepo-plugin

# Navigate to docs and serve
cd docs
mkdocs serve
```

Documentation will be available at `http://localhost:8000`.

### Testing
```bash
# Frontend tests
cd example-frontend/client
npm test

# Backend tests (coming soon)
cd example-frontend/server
npm test
```

### Code Style
- Follow existing code patterns and conventions
- Use meaningful variable and function names
- Include comments for complex logic
- Write tests for new functionality

## 🌐 Production Deployment

### Frontend Deployment Options
- **Static Hosting**: Vercel, Netlify, GitHub Pages
- **Traditional Servers**: Nginx, Apache
- **Containerized**: Docker with multi-stage builds

### Backend Deployment
- **Cloud Platforms**: Render, Heroku, Fly.io
- **VPS**: Self-hosted with PM2 process management
- **Serverless**: Adapt endpoints for serverless functions

### Documentation Deployment
The documentation is designed to be integrated into the main Verdikta documentation site via git submodules and deployed at `docs.verdikta.org`.

**[📖 Complete Deployment Guide →](docs/example-frontend/deployment.md)**

## 🤝 Contributing

We welcome contributions! Please follow these guidelines:

1. **Fork** the repository and create a feature branch
2. **Follow** existing code style and patterns
3. **Add tests** for new functionality
4. **Update documentation** for any changes
5. **Submit** a clear pull request

### Commit Messages
We follow [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add new AI provider integration
fix: resolve MetaMask connection issue
docs: update deployment instructions
```

## 📞 Support

- **Documentation**: [docs.verdikta.org](https://docs.verdikta.org)
- **Issues**: [GitHub Issues](https://github.com/verdikta/verdikta-applications/issues)
- **Discussions**: [GitHub Discussions](https://github.com/verdikta/verdikta-applications/discussions)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Chainlink](https://chain.link/) for oracle infrastructure
- [Base](https://base.org/) for the Layer 2 network
- [IPFS](https://ipfs.io/) for decentralized storage
- [OpenAI](https://openai.com/) and [Anthropic](https://anthropic.com/) for AI model access
- All open-source contributors and projects that made this possible

---

**Ready to build with Verdikta?** Start with our **[Getting Started Guide](docs/example-frontend/getting-started.md)** and join the future of decentralized AI evaluation! 🚀 