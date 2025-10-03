# Verdikta AI-Powered Bounty Program

**Status:** 🔴 Planning Phase  
**Version:** 0.1.0 (MVP)

## Overview

The Verdikta AI-Powered Bounty Program is a decentralized platform that enables trustless, automated evaluation and payment of work submissions using AI arbiters. Bounty owners lock ETH in escrow with an IPFS-hosted evaluation rubric, hunters submit deliverables, and Verdikta's AI jury automatically grades submissions. The first passing submission wins the bounty—no appeals, no manual review needed.

## Quick Links

- **[📖 Complete Design Document](DESIGN.md)** — Full architecture, specifications, and roadmap
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

### 🔄 Phase 1: Foundation (Weeks 1-2)
- [ ] Smart contract development (BountyEscrow)
- [ ] Backend API setup (Express + IPFS)
- [ ] Verdikta integration testing

### ⏳ Phase 2: Frontend MVP (Weeks 3-4)
- [ ] React UI components
- [ ] Create Bounty workflow
- [ ] Submit Work workflow
- [ ] Results display

### ⏳ Phase 3: Testing & Refinement (Week 5)
- [ ] Contract testing + security audit
- [ ] E2E testing
- [ ] Documentation

### ⏳ Phase 4: Deployment (Week 6)
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
This project is in the **planning phase**. The design document is complete, and development has not yet started.

**Next Steps:**
1. Review the [design document](DESIGN.md)
2. Provide feedback or ask questions
3. Wait for Phase 1 development to begin

### For Developers
Want to contribute? Check out:
1. [Design Document](DESIGN.md) — Full specifications
2. [Example Frontend](../example-frontend/) — Reusable patterns for Verdikta integration
3. [Development Roadmap](DESIGN.md#development-roadmap) — Upcoming tasks

## FAQ

**Q: How much does it cost to submit work?**  
A: Hunters pay LINK tokens for each evaluation. The amount depends on the bounty's class ID (complexity level). Class 128 (frontier models like GPT-4, Claude) costs approximately 0.0001-0.001 LINK per evaluation.

**Q: What happens if Verdikta times out?**  
A: If the evaluation doesn't complete within 5 minutes, the hunter can claim a refund of their LINK fee and resubmit.

**Q: Can I cancel a bounty after creating it?**  
A: Yes, but only after a 24-hour lockout period and only if there are no active evaluations in progress. Pending evaluations will be marked as void, and unprocessed submissions will be refunded.

**Q: Are submissions private?**  
A: No. In the MVP, all submissions are stored on IPFS and can be viewed by anyone with the CID. Encrypted submissions are planned for a future release.

**Q: Can a hunter submit multiple times?**  
A: Yes, but they must pay the LINK evaluation fee each time, which discourages spam.

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

