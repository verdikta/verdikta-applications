# Spike: can the arbiter path settle a 3-outcome wager?

Date: 2026-10-20. Question: does a request whose package has three outcomes
(`NO_WINNER`, `SIDE_A`, `SIDE_B`) work end to end, from the AI node to the aggregator's
`getEvaluation`, with no arbiter-network change? Design that builds on it: [DESIGN.md](DESIGN.md).

**Answer: yes, with one template rule.** Every layer is length-agnostic. The one catch is that
jurors get web tools only when the query contains a link, so the package must carry result-source
URLs. No transaction was sent; the live testnet request below is prepared but not run.

## What works

| Layer | Code read (origin/main or master, 2026-10-20) | Checked how | Result |
|---|---|---|---|
| AI node | `ai-node/src/app/api/rank-and-justify/route.ts`, `config/prePromptConfig.ts` | live calls to a local AI node | Any `outcomes[]` length. The pre-prompt lists each outcome and asks for exactly N scores summing to 1,000,000. A failed or unparsable model gets an equal split, remainder to index 0. |
| Package validation | `@verdikta/common` 1.8.0 `validator.js`, `manifestParser.js`, `classmap.v1.json` | every spike package through `manifestParser.parse` | `NUMBER_OF_OUTCOMES` allowed 2..10 and cross-checked against `outcomes.length`. Class 128 `max_outcomes` 20. All five packages parse; outcomes preserved in order. |
| External adapter | `external-adapter/src/handlers/evaluateHandler.js`, `services/aiClient.js` | code read | Single-CID flow takes outcomes from `primary_query.json` and returns one score per outcome (`aggregatedScore = scores.map(...)`). Commit hash covers the whole vector. |
| Chainlink job, operator | `chainlink-node/basicJobSpec`, `ArbiterOperator.sol` | code read | The job ABI-encodes `uint256[] value` (dynamic); the operator forwards bytes. |
| Aggregator | `ReputationAggregator.sol`, `AggregatorLib.sol` | Hardhat test on the real source at production K/M/N/P 6/4/3/2 ([spike/threeOutcome.test.js](spike/threeOutcome.test.js)): **4/4 pass** | Reveals of length 2..`maxLikelihoodLength` accepted; vectors normalized to the modal length; Euclidean clustering and averaging at any length; `getEvaluation` returns the 3-vector. A 2-vs-1 split clusters the agreeing pair; a deviant 2-length reveal loses on distance. |
| Live config | Base `0xd8F3…142a`, Base Sepolia `0xe8a3…80e4` | `cast call` | `maxLikelihoodLength` = 20 on both; K/M/N/P = 6/4/3/2; timeout 300 s; `maxTotalFee(0.00002 ETH)` = 0.00024 ETH. |
| Arbiter selection | same aggregators | `eth_call` of `requestAIEvaluationWithApproval([cid], "", 500, 0.00002, 0.00001, 3, class 128)` | Returns an aggId on both networks (no revert): class 128 has enough eligible arbiters at these settings today. The aggregator never reads the package at request time. |
| Fees | `maxTotalFee` | code read | `fee × (K + bonus × P)`: independent of the number of outcomes. |

### Jury smoke (live models, real finished events)

Local AI node (verdikta-arbiter `feat/ai-node-web-tools` at 5c2e3d8, the web-tools release
branch, `AI_WEB_ACCESS` default), jury OpenAI gpt-5.6-terra 0.5 + Anthropic claude-sonnet-5
0.5, packages built by [spike/buildWagerPackage.mjs](spike/buildWagerPackage.mjs) and parsed by
`@verdikta/common` exactly as the adapter does ([spike/runJury.mjs](spike/runJury.mjs)).
Decisive = a side at >= 80%. **10/10 samples correct.**

| Case | Event (real) | Expected | Scores `[NO_WINNER, A, B]`, 2 samples |
|---|---|---|---|
| W1 | Commanders @ 49ers, 2026-10-19 MNF, 49ers 23-17; A = Commanders | SIDE_B | 0.8/0.5/98.7%; 0.3/0.2/99.5% |
| W2 | Jets @ Patriots, 2026-10-18, Patriots 26-19; A = Patriots | SIDE_A | 0.1/99.7/0.2%; 0.5/99.0/0.5% |
| W3 | Giants @ Commanders, 2026-10-11, 27-27 tie | NO_WINNER | 99.0/0.5/0.5% (both) |
| W4 | Celtics @ Pistons, not finished at run time | NO_WINNER | 96.5/1.8/1.8%; 97.5/1.3/1.3% |
| W5 | W1's game, spread market Commanders +6.5 (lost by 6, covered) | SIDE_A | 1.0/98.0/1.0%; 0.5/99.0/0.5% |

W3's jurors named the 27-27 tie from several sources; W4's found the game not yet played.
Results and full justifications: [spike/results/jury-2026-10-20/](spike/results/jury-2026-10-20/).

## What blocks, or must be designed around

1. **Web tools need a link in the query.** The AI node enables the providers' web tools only
   when the prompt (or a text attachment) contains an http(s) URL (`AI_WEB_ACCESS=auto`,
   `ai-node/src/lib/llm/web-access.ts`). In bounties the claimant's links switched them on; a
   claimant-neutral wager query has none. W1 without links scored NO_WINNER 97.5%, with both
   jurors saying they had no web access ([spike/results/no-link-2026-10-20/](spike/results/no-link-2026-10-20/)).
   Fix, no arbiter change: the template's required "Result sources" line (DESIGN.md 6.3).
2. **Arbiter fleet.** Arbiters with `AI_WEB_ACCESS=off`, or an AI node older than the
   web-tools release, will answer NO_WINNER under the template's fail-closed rule. That is safe
   (a non-decisive round is retried, the worst case is a refund) but a fleet check of class 128
   (versions and web access, including third-party operators, as in verdikta-applications#41)
   should precede mainnet.
3. **BountyEscrow cannot carry it.** `_scoreVector` accepts exactly two scores, so a 3-outcome
   result there is "invalid" and fails. A new contract is needed (expected; DESIGN.md).
4. **Owner-settable aggregator limit.** `maxLikelihoodLength` (minimum 2) is an owner setter.
   It is 20 today; at 2, every 3-outcome round would fail (refund, no loss).

## Not yet run

- **A live 3-outcome aggregator round on Base Sepolia.** It needs (a) the package pinned on
  IPFS, which needs the owner's pinning credentials, and (b) one transaction from a throwaway
  testnet wallet (0.00024 testnet ETH, mostly credited back). Steps:
  ```
  cd spike/example-package && zip -X ../wager-w2.zip manifest.json primary_query.json   # pin wager-w2.zip, note the CID
  PRIVATE_KEY=<throwaway> node spike/testnetRequest.cjs start <cid>                      # prints aggId
  node spike/testnetRequest.cjs check <aggId>                                            # 5-10 min later; expect length 3, SIDE_A
  ```
  Everything this would exercise beyond the local runs is transport (Chainlink job, operator)
  and the deployed arbiters' versions.
- **History scan** for past rounds with 3+ scores: the public Base RPCs limit `eth_getLogs` to
  200 blocks, so it needs an indexer or an archive RPC key.

## Reproduce

- Aggregator: copy `spike/threeOutcome.test.js` into `verdikta-dispatcher/reputationBasedAggregator/test/`,
  `npm ci`, `npx hardhat test test/threeOutcome.test.js`.
- Jury: run an AI node (web-tools release) on :3078, then
  `node spike/runJury.mjs spike/cases.json /tmp/out 2` with `VERDIKTA_COMMON` pointing at a
  verdikta-common checkout. Costs a few cents of model calls; no chain access.
