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

**Status:** scaffold, plus the contract's listing half and its claim lifecycle up
to the evaluation request. The packages below build and test; settlement,
disputes, late claims, the site's flows and the hunter commands arrive with the
nodes named in the plan.

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
| `onchain/` | Hardhat (solc 0.8.23, gas reporter, solidity-coverage), `StakeAttestation` (listings, P2a; claims up to the request, P2b; settlement, disputes and late claims arrive in P2c–P2e) with its `ClaimLogic` library, `StakeAttestationLens` and `EvaluationWallet`, the `IVerdiktaAggregator` interface and the mock aggregator. | `npx hardhat test` |
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

## The contract: listings

`onchain/contracts/StakeAttestation.sol` (design §13; the build plan's
decisions override it). A maker calls `list(params, listingCid, disputeCid,
knownIssueIds)`, then `fund(listingId, feeDue(listingId))` with the listing fee
plus at least the `CRITICAL` award: the listing opens for 30 days and accepts
commits until `fundedUntil`. `fund(listingId, 0)` tops the escrow up, `renew`
buys another 30 days for exactly the current fee, and `close` returns the
escrow once no claim is pending and nothing is owed.

- **Record key.** `artifactHash` is `keccak256(abi.encode(uint8 kind, repo,
  baseCommit))` for a repository (kind 0) and `keccak256(abi.encode(uint8 kind,
  repo, baseCommit, uint64 chainId, address))` for a deployed contract (kind 1);
  `artifactHashOf` computes it. `baseCommit` is 40 or 64 lowercase hex and
  `repo` an `https://` URL, so one commit has one key. `listingsByHash` lists
  every listing of a hash; a maker has at most one listing per hash that is not
  closed.
- **Bounds** (decision D8): `revealWindow` 72 h to 90 d, `disputeWindow` 24 h
  to 90 d, `fixWindow` 0 to 90 d, `disclosureGrace` at most `fixWindow`. Awards
  never decrease with severity and every class from `lowestClassCounted` up
  pays more than 0. The oracle settings are checked as `BountyEscrow`'s
  `createBounty` checks them, for the claim fee and the dispute fee.
- **Fees and the owner.** The listing fee accrues to the fee recipient's pull
  balance (`withdraw`), never to the escrow. The owner can set the fee and the
  recipient, both applying from the next fund or renew, and nothing else; the
  opening `fund` takes the fee the maker expects, so a fee change cannot take
  part of the escrow.
- **Payments** go through a gas-capped send that falls back to the pull
  ledger, as in `BountyEscrow`.

## The contract: claims

A hunter calls `commit(listingId, archiveHash, ciphertextSha256)` with the
listing's bond plus at least the aggregator's live `maxTotalFee` (the prepay):
two hashes, nothing readable (erratum E5). **Only once the commit is mined** does
the hunter pin the ciphertext, then call `disclose(claimId, ciphertextCid)`
within `DISCLOSE_WINDOW` (1 hour); the fix window and the disclosure grace run
from then. The order matters: a small raw IPFS file's CID follows from its
sha256, so a ciphertext pinned before the commit could be fetched by a maker who
front-runs the commit with `close` or `rollForward`, and the commit would then
revert. The maker may `flagBadDisclosure` within the
grace, `release` the claim (revealable now), or `rollForward(listingId,
successorListingId)` to a fixed version they have listed and funded, which ends
the window of every claim disclosed so far. Once the window is over the hunter
calls `reveal(claimId, bcid, contentKey, ephemeralKey)`, paying any rise in the
fee (erratum E3), and the contract sends the evaluation request it composes
itself: the listing archive, the claim and up to 8 prior valid findings, and
the one-line disclosure addendum of erratum E1.

- **Commit order** (decision D5). The unresolved claims of a listing form a
  queue in commit order; a claim reveals only at its head, and its reveal
  window (`revealWindow`) runs from the later of its fix window's end and the
  moment the claim before it resolved. `expire` takes a claim that missed its
  window (bond to the maker, prepay back), and an undisclosed claim after the
  disclose window whatever its place in the queue.
- **Requests** go out through a fresh `EvaluationWallet` clone each, as in
  `BountyEscrow`, so the aggregator's refund of unspent prepay belongs to one
  request. Each is sent with exactly `SUBMISSION_GAS` (10M): a reveal that
  cannot forward all of it reverts, so a reveal's gas limit is about 10.3M
  (only the gas used is paid). A request the aggregator refuses leaves the
  claim `RoundFailed` with its prepay held; with a fixed budget that is the
  aggregator's answer, never the caller's choice of gas.
- **Size.** The claim functions' bodies are the linked library `ClaimLogic`
  (deploy it and link it before `StakeAttestation`), and the derived views
  (`claimState`, `claimTimes`, `commitPrice`, `revealTopUp`) are in
  `StakeAttestationLens`, answered at the contract's address through its
  fallback. Their time and fee rules are one library, `ClaimRules`.

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
