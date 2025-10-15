# Verdikta AI-Powered Bounty Program

**Status:** 🟡 Implementation Phase (Pre-Contract Testing)  
**Version:** 0.2.0 (MVP)

## Overview

The Verdikta AI-Powered Bounty Program is a decentralized platform that enables trustless, automated evaluation and payment of work submissions using AI arbiters. Bounty owners create jobs with ETH payouts and IPFS-hosted evaluation rubrics, hunters submit deliverables, and Verdikta's AI jury automatically grades submissions. The first passing submission wins the bounty—no appeals, no manual review needed.

**Current Status:** The application is fully functional for creating jobs, browsing opportunities, and submitting work. While smart contracts are being developed, the system generates the necessary IPFS archives (Primary CID and Hunter CID) that can be tested with the example-frontend application.

## Quick Links

### 🎯 Essential Documents (Start Here)
- **[📋 PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)** — Architecture, concepts, and data models
- **[⚙️ CURRENT-STATE.md](CURRENT-STATE.md)** — What's complete, how to get started, contribution guide
- **[👨‍💻 DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Quick reference for commands, APIs, and patterns

### 📚 Additional Resources
- **[📖 DESIGN.md](DESIGN.md)** — Complete technical specification (1400+ lines)
- **[🏗️ Example Frontend](../example-frontend/)** — Reference implementation showing Verdikta integration patterns
- **[📚 Verdikta User Guide](../docs/user-guide.md)** — Understanding Verdikta's AI evaluation system

## Key Concepts

### For Bounty Owners
1. **Create Bounty**: Define work requirements via a rubric JSON (criteria, weights, threshold)
2. **Lock ETH**: Deposit payout amount on-chain in escrow
3. **Wait**: Hunters submit work, AI evaluates automatically
4. **Winner Paid**: First passing submission gets ETH instantly

### For Hunters
1. **Browse Bounties**: Find open bounties that match your skills
2. **Submit Work**: Upload deliverable (text, image, PDF, etc.) to IPFS
3. **Pay LINK Fee**: Each evaluation requires LINK tokens (prevents spam)
4. **AI Evaluation**: Verdikta's arbiters grade your work against the rubric (1-5 minutes)
5. **Get Paid**: If you pass the threshold, ETH is sent to your wallet automatically

## Architecture

```
┌─────────────┐
│   Bounty    │  Locks ETH + rubric CID
│    Owner    │────────────────┐
└─────────────┘                │
                               ↓
                    ┌──────────────────────┐
                    │  BountyEscrow        │
                    │  Smart Contract      │
                    │                      │
                    │  • Holds ETH         │
┌─────────────┐    │  • Tracks bounties   │    ┌──────────────────┐
│   Hunter    │───→│  • Coordinates with  │───→│    Verdikta      │
│             │    │    Verdikta          │    │   Aggregator     │
└─────────────┘    │  • Pays winners      │    │                  │
  Submits work     └──────────────────────┘    │  AI Arbiters     │
  + LINK fee                 ↑                 │  evaluate work   │
                             │                 │                  │
                             └─────────────────┤  Pass/Fail       │
                                   Result      └──────────────────┘
```

## Technology Stack

- **Smart Contracts**: Solidity 0.8+, OpenZeppelin, deployed on Base Sepolia/Base
- **Frontend**: React 18, Ethers.js v6, React Router
- **Backend**: Node.js, Express, @verdikta/common
- **Storage**: IPFS (Pinata) for rubrics, deliverables, AI reports
- **Blockchain**: Base Sepolia (testnet), Base (mainnet)
- **Oracles**: Verdikta Aggregator + Chainlink Functions

## Development Roadmap

### ✅ Phase 0: Planning (Complete)
- [x] Requirements gathering
- [x] Design document creation
- [x] Architecture planning

### ✅ Phase 1: Foundation (Complete)
- [x] Backend API setup (Express + IPFS)
- [x] Archive generation utilities
- [x] Verdikta multi-CID integration
- [x] Local job storage for testing

### ✅ Phase 2: Frontend MVP (Complete)
- [x] React UI components
- [x] Create Job workflow with ETH/USD conversion
- [x] Browse Jobs with search/filter
- [x] Submit Work workflow
- [x] CID display for testing

### 🔄 Phase 3: Smart Contracts (In Progress)
- [ ] BountyEscrow contract development
- [ ] Contract deployment to Base Sepolia
- [ ] Frontend-contract integration

### ⏳ Phase 4: Testing & Refinement (Next)
- [ ] Contract testing + security audit
- [ ] E2E testing with deployed contracts
- [ ] Documentation updates

### ⏳ Phase 5: Deployment (Future)
- [ ] Deploy to Base Sepolia
- [ ] Public launch
- [ ] User onboarding

## Example Use Cases

### Technical Writing
- **Bounty**: "Write a 2000-word tutorial on Solidity testing"
- **Criteria**: Originality (must), Technical accuracy (30%), Clarity (30%), Completeness (40%)
- **Threshold**: 80/100
- **Payout**: 0.1 ETH

### Graphic Design
- **Bounty**: "Design a logo for DeFi protocol"
- **Criteria**: Originality (must), Brand alignment (30%), Technical quality (30%), Creativity (40%)
- **Threshold**: 85/100
- **Payout**: 0.5 ETH

### Data Analysis
- **Bounty**: "Analyze on-chain DEX volume trends Q3 2025"
- **Criteria**: Data accuracy (must), Depth of analysis (40%), Visualization quality (30%), Insights (30%)
- **Threshold**: 82/100
- **Payout**: 0.2 ETH

## MVP Scope

### ✅ In Scope
- Binary outcomes (Pass/Fail)
- ETH payouts only
- First-past-post (single winner)
- Public submissions
- Text, images, PDFs, DOCX (≤20 MB)
- LINK fees per submission
- 24-hour cancellation lockout

### ❌ Out of Scope (Future Enhancements)
- Multiple winners per bounty
- Appeals or dispute resolution
- Platform fees
- Encrypted submissions
- Stablecoin payments
- Hunter reputation system
- Licensing automation

## Getting Started

### Prerequisites
- Node.js ≥18
- MetaMask wallet
- Base Sepolia testnet access
- Test ETH and LINK tokens

### Current Status
This project is **95% complete** with full job creation, browsing, and submission workflows implemented. The system generates Verdikta-compatible IPFS archives that can be tested with example-frontend while smart contracts are being developed.

**What's Working:**
- ✅ Create jobs with bounty amounts (ETH/USD), thresholds, and custom rubrics
- ✅ Browse and search available jobs with filters
- ✅ Submit work and get Primary/Hunter CIDs for testing
- ✅ Full IPFS integration for rubrics and deliverables
- ✅ Archive generation matching Verdikta multi-CID format
- ⏳ Smart contract integration (in progress)

**For Developers & Contributors:**
1. Read [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) for architecture understanding
2. Read [CURRENT-STATE.md](CURRENT-STATE.md) for setup and testing instructions
3. Use [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) as a quick reference
4. Test job creation and submission workflow (no contracts needed!)
5. Use generated CIDs with example-frontend to test AI evaluation

### For Developers
Want to contribute? Check out:
1. **[CURRENT-STATE.md](CURRENT-STATE.md)** — Setup guide and what to work on
2. **[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — Commands, APIs, patterns, and debugging
3. **[PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)** — Architecture and data models
4. [Example Frontend](../example-frontend/) — Reusable patterns for Verdikta integration

## FAQ

**Q: Can I test the system without deploying smart contracts?**  
A: Yes! The current implementation creates jobs, generates IPFS archives, and provides CIDs that you can test with the example-frontend application to see how AI evaluation works.

**Q: How do I use the generated CIDs for testing?**  
A: After submitting work, the app displays a Primary CID and Hunter CID. Copy the evaluation format (PRIMARY_CID,HUNTER_CID) and paste it into the example-frontend's "Run Query" page to test AI evaluation.

**Q: How much does it cost to submit work?**  
A: Hunters pay LINK tokens for each evaluation (when smart contracts are deployed). The amount depends on the job's class ID. Class 128 (frontier models like GPT-4, Claude) costs approximately 0.0001-0.001 LINK per evaluation.

**Q: What happens if Verdikta times out?**  
A: If the evaluation doesn't complete within 5 minutes, the hunter can claim a refund of their LINK fee and resubmit (once contracts are deployed).

**Q: Can I cancel a job after creating it?**  
A: Currently, jobs are stored locally. Once smart contracts are deployed, cancellation will be possible after a 24-hour lockout period if no active evaluations are in progress.

**Q: Are submissions private?**  
A: No. All submissions are stored on IPFS and can be viewed by anyone with the CID. Encrypted submissions are planned for a future release.

**Q: Can a hunter submit multiple times?**  
A: Yes, hunters can submit multiple attempts for the same job (each pays a LINK fee once contracts are deployed).

**Q: What file types are supported?**  
A: Text (.txt, .md), images (.jpg, .png), documents (.pdf, .docx) up to 20 MB.

## Support & Contact

- **Issues**: [GitHub Issues](https://github.com/verdikta/verdikta-applications/issues)
- **Documentation**: [docs.verdikta.org](https://docs.verdikta.org)
- **Design Questions**: See [DESIGN.md](DESIGN.md) or open a discussion

## License

MIT License — see [LICENSE](../LICENSE) for details.

---

**Note**: This project is under active development. The design document represents the current plan and may evolve based on feedback and implementation discoveries.

