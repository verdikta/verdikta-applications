# Verdikta stake attestation

A maker stakes funds behind one version of their code. A hunter who proves a bug
in it with a runnable test discloses the proof to the maker first, encrypted;
after the fix window the Verdikta arbiter network runs the proof in a sandbox
and judges it, and a valid finding is paid from the stake. Every listing, claim
and verdict is on-chain, so the record of a version is public. The MVP covers
Solidity on the Foundry image only.

Design: verdikta-arbiter
[`docs/development/stake-attestation-design.md`](https://github.com/verdikta/verdikta-arbiter/blob/main/docs/development/stake-attestation-design.md).
Build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md), the graph of one-PR nodes
this application is built from; its errata, assumptions and decisions override
the design where they differ.

**Status:** scaffold. The packages below build and test; the contract, the
site's flows and the hunter commands arrive with the nodes named in the plan.

## A separate site

This is its own application, with its own domain, API and contract (design §20,
decision 18). It shares the Verdikta aggregator, the code ClassIDs and the
arbiter network with the bounty program, and may use library code from
`example-bounty-program/` as a dependency, but never adds routes or flows to
bounties.verdikta.org. `BountyEscrow` is untouched. A test in
`shared/test/repo/scope.test.js` fails a change that edits files outside this
folder and its workflow, or touches `BountyEscrow.sol`; a change that genuinely
needs another path adds it to that test's allowlist, where review sees it.

## Wording rule

The record is a statement of what was staked and what the arbiters found, not a
guarantee. Two words are therefore never used for a listing, record, badge or
anything else here: the past participle of *certify* and the noun formed from
it. That holds for source, comments, UI strings, docs, tests and commit
messages. Say *staked*, *judged*, *attestation*, or "no finding at or above
HIGH while staked".

The two words exist in one place only, assembled from parts in
[`shared/src/forbiddenWords.js`](shared/src/forbiddenWords.js). CI runs
`shared/bin/check-forbidden-words.js` over this folder and its workflow and
fails on any match, in any case and inside longer words. Tests that need a
sample build it from the helper's output instead of spelling it. To check
locally:

```bash
node stake-attestation/shared/bin/check-forbidden-words.js stake-attestation .github/workflows/stake-attestation.yml
```

## Layout

| Folder | What | Test |
|---|---|---|
| `onchain/` | Hardhat (solc 0.8.23, gas reporter, solidity-coverage), the `IVerdiktaAggregator` interface and the mock aggregator. `StakeAttestation` arrives in P2a–P2e. | `npx hardhat test` |
| `server/` | Express API; `GET /health` for now. Port 5009. | `npm test` |
| `client/` | Vite + React site. Port 5176. | `npm test`, `npx playwright test` |
| `tool/` | `verdikta-attest`, the hunter's CLI: `check`, `commit`, `reveal`, `status`, `claim` arrive in P5. | `npm test` |
| `shared/` | Code shared by the packages (the banned-words helper so far) and the app's repository checks. | `npm test` |
| `docs/` | `BUILD_PLAN.md`. | |

Ports 5009 and 5176 are the next free ones after the apps in the repository's
`ports.txt`.

## Development

Node 22 (`.nvmrc`; the packages also run on Node 20). Each package installs on
its own:

```bash
cd stake-attestation/onchain && npm ci && npx hardhat test
cd stake-attestation/server && npm ci && npm test
cd stake-attestation/client && npm ci && npm test && npx playwright install chromium && npx playwright test
cd stake-attestation/tool && npm ci && npm test
cd stake-attestation/shared && npm ci && npm test
```

`npm run gas` in `onchain/` prints the gas report and `npm run coverage` runs
solidity-coverage. The Playwright smoke test builds the client and serves it
with `vite preview`. The shared package's scope test compares against
`origin/claude/stake-attestation` (or `SA_BASE_REF`), so fetch it first.

## The mock aggregator

`onchain/contracts/mocks/MockVerdiktaAggregator.sol` stands in for the deployed
`ReputationAggregator` (verdikta-dispatcher) in every contract test, so it must
not do anything the real contract does not. In particular it never calls the
requester: results are read by polling `getEvaluation` and
`getAggregationStatus`, and unspent ETH comes back as `ethOwed` credit at
settlement, pulled with `withdrawEth`. It has the real input limits
(`MAX_CID_COUNT` 10, `MAX_CID_LENGTH` 100, `MAX_ADDENDUM_LENGTH` 1000), draws
the caller's credit before `msg.value`, and settles through scripted results or
`finalizeEvaluationTimeout`. Its test controls stand in for the real contract's
owner settings and its oracles; the contract's header lists them. A fault the
real contract cannot produce is not added to the mock.

## CI

`.github/workflows/stake-attestation.yml` runs on pull requests into `main` and
`claude/stake-attestation` that touch this folder or the workflow. It installs
each package with `npm ci --ignore-scripts`, runs its tests, the Hardhat tests,
the Playwright smoke test and the banned-words check, and uses no secrets. A new
package is added to the workflow and to `shared/test/repo/helpers.js` together;
the workflow test fails until both list it.
