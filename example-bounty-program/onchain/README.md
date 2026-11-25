# Verdikta Bounty Program — Smart Contracts

Solidity contracts for the Verdikta AI-Powered Bounty Program, built with Hardhat.

## Contracts

- **`BountyEscrow.sol`** — main contract. Holds ETH escrow, manages bounty lifecycle, coordinates with the v2 Verdikta aggregator, supports an optional creator approval window. Built on the v2 aggregator (verdikta-dispatcher `beacon` branch): the constructor fixes one aggregator (`aggregator()`), which serves every jury size; each bounty carries its own jury (`CreateParams.jury`: K, M, N, P and the round timeout, checked at create against the aggregator's structural rules and sent with every request and fee quote) and sets its fee floor, beacon flag, pass quota Q, forfeit line R and hunter bond. A round is drawn through the submission's wallet (`drawJury`, anyone, from two blocks after the start) and judged by TODO item 12's Q-of-N rule (`BountyRules.sol`): pass at Q scores at the threshold, hard fail below R (the bond goes to the creator), and a soft fail or a round with no result may re-run (`rerunSubmission`, up to 6 rounds, each within 2 hours) while keeping its place; `closeFailedRound` closes a dead round, `expireRerun` ends a re-run that wasn't taken.
- **`BountyEscrowLens.sol`** — the escrow's read-only views (`getSubmissions`, `getBounties`, `getOracleResult`, `nextAction`, `prepareCutoff`, `canBeClosed`, `isAcceptingSubmissions`, `getEffectiveBountyStatus`), split out so `BountyEscrow`'s runtime bytecode stays under the 24,576-byte EIP-170 limit. Created by the escrow's constructor (`lens()`), and served **at the escrow address**: the escrow's fallback forwards any selector it does not implement to the lens through a `STATICCALL`-guarded `delegatecall` (no state change is possible, the lens address is an immutable, there is no owner — this is not a proxy). Reads go through the escrow's public getters, so the two contracts share no storage layout. Use the **merged ABI** (`deploy/helpers.js → mergedAbi()`, exported to `frontend/src/abi/BountyEscrow.json` on deploy) wherever an ABI is attached to the escrow; the compiled `BountyEscrow` artifact alone lacks these views.
- **`BountyRules.sol`** — the one interpreter of a round's result (Q-of-N on the FUND score of a two-outcome result; any other shape is no result), compiled into both the escrow and the lens.
- **`EvaluationWallet.sol`** — per-submission wallet (an EIP-1167 minimal-proxy clone of the one implementation the escrow creates in its constructor — `walletImplementation()`; verified separately so explorers label the clones), bound to the escrow's aggregator (an immutable of the shared code). It is the requester of every round of the submission, draws the jury (so the draw reward comes back), and recovers the unspent ETH (refunds and rewards) for the round's funder.
- **`interfaces/IVerdiktaAggregator.sol`** — the v2 aggregator interface (the 10-argument payable request with the `Jury`, `maxTotalFee(maxFee, minFee, withBeacons, K, P)`, `getJury`, `maxJury`/`maxTimeout`, `drawJury`/`closeCommits`/`promote`/`settle`/`cancelUnsealed`, `getRoundInfo` and its phases, `getOutcomeScores`, `ethOwed`/`withdrawEth`). Kept byte-identical with stake-attestation's copy.
- **`mocks/`** — test stubs: `MockVerdiktaAggregator` (the v2 round: phases, draw, beacons, commits, promotion, reveals, settlement, committer shares and arbiter-pool routing (an eighth of the pool paid to a stand-in arbiter at each draw), the real escrow formula; records forwarded request params; switchable broken withdraw; byte-identical with stake-attestation's), `MockRejectingHunter` (rejects ETH), `MockGasHungryRecipient` (burns gas on receive).

The contract's behavioral rules (deadline, creator window, priority, submission cap, creator-owned oracle settings, CID validation, payout gas cap, the `closeFailedRound` gate, the Q-of-N rule, bond and re-runs, refund recovery) and its agent-facing views (`nextAction`, `getOracleResult`, `getSubmissions`, `getBounties`, `prepareCutoff` — served from `BountyEscrowLens` at the escrow address — and `requiredPrepay`) are documented in [../DEVELOPER-GUIDE.md → Submission timing and priority rules](../DEVELOPER-GUIDE.md#submission-timing-and-priority-rules). The contract has no owner and no upgrade path; every rule is a constant.

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
- `VERDIKTA_AGGREGATOR_BASE` / `VERDIKTA_AGGREGATOR_BASE_SEPOLIA` — the v2 aggregator (one serves every jury size); fixed in the escrow for life

## Deployment

```bash
npm run deploy:sepolia     # or deploy:base
```

After deployment, the new BountyEscrow address (and the `BountyEscrowLens` it created) is printed to console and saved to `deployments/`; both are verified on Basescan when `BASESCAN_API_KEY` is set (`ESCROW=<escrow> npx hardhat run deploy/verify.js --network <net>` verifies all three after the fact). The lens is verified separately only so the explorer's read tab can show the views — callers never need its address. Update `BOUNTY_ESCROW_ADDRESS_*` in both `server/.env` and `client/.env`, then restart the server and rebuild the client. If the ABI changed, that is not enough — follow the release's cutover runbook in `../deploy/` (currently `../deploy/CUTOVER-2026-09-12.md`), which also applies the off-chain migration patch, bumps `deploymentBlocks`, and resets the job data.

**Merged ABI for agents.** After any contract change, regenerate and republish the merged escrow+lens ABI that agents load (see `abi/README.md`): `node scripts/build-merged-abi.js`, commit `abi/BountyEscrow.json`, pin it to IPFS, then update the CID in `abi/README.md`, `server/routes/agentRoutes.js` (`ABI_IPFS_CID`) and `client/src/pages/Blockchain.jsx`. Also verify all three contracts on Sourcify (keyless; `deploy/verify.js` covers Basescan only) — Sourcify's `POST /v2/verify/{chainId}/{address}` accepts the Hardhat build-info `input` as `stdJsonInput`.

## Project context

For deployed contract addresses, see [../README.md#contract-addresses](../README.md#contract-addresses).
For full contract reference (ABI, state diagrams, code samples), the in-app `/blockchain` page on the frontend is the canonical source.
