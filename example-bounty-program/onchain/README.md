# Verdikta Bounty Program — Smart Contracts

Solidity contracts for the Verdikta AI-Powered Bounty Program, built with Hardhat.

## Contracts

- **`BountyEscrow.sol`** — main contract. Holds ETH escrow, manages bounty lifecycle, coordinates with VerdiktaAggregator, supports an optional creator approval window.
- **`EvaluationWallet.sol`** — per-submission wallet that holds LINK and pays oracle fees.
- **`interfaces/IVerdiktaAggregator.sol`** — interface to the AI oracle aggregator.
- **`interfaces/ILinkToken.sol`** — minimal LINK ERC-677 interface.

## Quick start

```bash
npm install
cp .env.example .env       # PRIVATE_KEY, RPC URLs, BASESCAN_API_KEY
npm run compile
npm test
```

## Scripts

| Command | Description |
|---|---|
| `npm run compile` | `hardhat compile` |
| `npm test` | `hardhat test` |
| `npm run coverage` | solidity-coverage report |
| `npm run deploy:sepolia` | Deploy to Base Sepolia |
| `npm run deploy:base` | Deploy to Base mainnet |
| `npm run verify` | Verify source on Basescan |
| `npm run clean` | `hardhat clean` |
| `npm run node` | Local Hardhat node |

Convenience deployment wrappers: `deploy_testnet.sh`, `deploy_mainnet.sh`.

## Environment

See `.env.example`. Required:

- `PRIVATE_KEY` — deployer key (NEVER commit)
- `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` — RPC endpoints
- `BASESCAN_API_KEY` — for source verification

## Deployment

```bash
npm run deploy:sepolia     # or deploy:base
```

After deployment, the new BountyEscrow address is printed to console and saved to `deployments/`. Update `BOUNTY_ESCROW_ADDRESS_*` in both `server/.env` and `client/.env`, then restart the server and rebuild the client.

## Project context

For deployed contract addresses, see [../README.md#contract-addresses](../README.md#contract-addresses).
For full contract reference (ABI, state diagrams, code samples), the in-app `/blockchain` page on the frontend is the canonical source.
