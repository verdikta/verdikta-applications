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

**Status:** a local end-to-end round runs every piece below together (see "The local round"). Scaffold, plus the contract's listing half, its claim lifecycle and
settlement: finalize by polling the aggregator, the six-outcome rule, payouts,
depletion and owed awards; the environment builder; the server's listing
flow, indexer, keeper, feed, record mirror and badge; and the client: the maker
flows (listing, the disclosure key, decrypt-and-check, the baseline scan, release,
roll forward, dispute), the record page with its badge, and the feed.

**The project decides who may stake on it.** Every listing needs the project's
proof, with no allowlist and no exception, Verdikta included: a file in the
repository at the listed commit names the staker's wallet, which may be a
sponsor's, and a deployed contract also needs a signature from its deployer or
owner. The builder refuses without it, nothing is signed, and the site counts a
listing only with a builder's signature and that proof
([`docs/control-proof.md`](docs/control-proof.md)). This protects a project's name
and record, not its code: anyone can still stake on a fork or a copy and read
findings that also apply upstream. The packages below build
and test; the rest of the site's flows and the hunter commands arrive with the
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
| `onchain/` | Hardhat (solc 0.8.23, gas reporter, solidity-coverage, contract sizer), `StakeAttestation` (listings, P2a; claims up to the request, P2b; finalize and settlement, P2c; disputes and failed rounds, P2d; late claims and the record, P2e) with its linked libraries `ClaimLogic` and `RecordLogic`, `StakeAttestationLens` and `EvaluationWallet`, the `IVerdiktaAggregator` interface, the mock aggregator and the deploy scripts. | `npx hardhat test`, `npm run coverage:check`, `npx hardhat size-contracts` |
| `server/` | Express API, port 5009: the listing flow (P4a) runs the builder, builds the listing and dispute archives, pins them and returns the arguments of `list()`; the baseline scan between listing and open, its findings served to the maker's wallet only (P4b2); the indexer, keeper, listing feed, record mirror, labels and badge (P4b1) over one deployment; the project's proof, refused listing attempts counted by reason, what counts on the record, the fork label (P8, P9). | `npm test`, `npm run test:builder`, `npm run abi` |
| `client/` | Vite + React site, port 5176: the maker's listing flow, the disclosure key made in the browser, and decrypt-and-check (P6a); the record page, the badge embed, the feed, the maker's release, roll forward and dispute, pending evaluations watched, the baseline scan read (P6b). | `npm test`, `npx playwright test` |
| `tool/` | `verdikta-attest`, the hunter's CLI and the library it wraps (P5): `check`, `commit`, `reveal`, `status`, `claim`. See "The hunter tool". | `npm test` |
| `shared/` | Code shared by the packages (the banned-words helper, the rules of the project's proof, the warning every listing page carries, "did the builder sign this listing") and the app's repository checks. | `npm test` |
| `builder/` | `verdikta-build-env`, the environment builder (P3a): builds and pushes a listing's env image, checks a contract's verified source, validates the listing on the arbiters' code-runner and signs `attestation.json`; the baseline scan, for the maker only (P3b); `verdikta-control-check`, what git says about a listing's repository (P8); the listing's proof, refused before anything is built (P9). The reusable workflow that runs it is `.github/workflows/stake-attestation-builder.yml`. | `npm test`, `npm run test:docker` |
| `e2e/` | The scripted local end-to-end round (P7): every piece together, with nothing live. See "The local round". | `npm test`, `npm run round` |
| `docs/` | `BUILD_PLAN.md`, `control-proof.md` (the project's proof: what a listing needs, every refusal, what counts). | |

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
cd stake-attestation/builder && npm ci && npm test && npm run test:docker
cd stake-attestation/e2e && npm ci && npm test
```

`npm run gas` in `onchain/` prints the gas report, `npm run coverage` runs
solidity-coverage, `npm run coverage:check` runs it and fails below 95% line
coverage on any production contract, and `npx hardhat size-contracts` prints
the bytecode sizes and fails above EIP-170's 24 KiB. The client's Playwright tests build the client and serve it
with `vite preview` in front of a local stack (see "The client"); they install the server's
dependencies if `server/node_modules` is missing. The shared package's scope test compares against
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
  and the record's reader the linked library `RecordLogic` (deploy and link
  both, `ClaimLogic` first, before `StakeAttestation`), and the derived views
  (`claimState`, `claimTimes`, `commitPrice`, `revealTopUp`, `recordByHash`,
  ...) are in `StakeAttestationLens`, answered at the contract's address
  through its fallback. Their time and fee rules are one library, `ClaimRules`.

## The contract: late claims and the record

A finding on a version whose stake has rolled forward or closed is a **late
claim** (decision D6): `lateClaim(listingId, archiveHash, ciphertextSha256)`
on a `Rolled` or `Closed` listing, open to every hunter, with the bond plus the
live fee (`commitPrice`). It is commit-shaped: `disclose` within the hour
(erratum E5), the listing's fix window from the disclosure (the maker may flag
or release it), a reveal with the E1 line once every earlier claim on the
listing has resolved, `finalize`, a dispute if the maker wants one, `settle`.
It pays **no award**: the bond comes back unless the outcome is INVALID. It is
recorded under `later` only (`lateClaims`, `lateOutcomeCounts`, `lateExpired`,
and a valid one among the findings with `late` set), never in the counts the
stake earned while it took commits, and it does not hold `close()`.

`recordByHash(artifactHash)` returns the record of design §4.1 for a hash:
every listing of it (state, times, lapsed, invited, award table, bond, escrow,
owed, value at risk, lineage with the neighbours' hashes, its own counts),
`active` (those not closed), the history summed over them (claims, pending,
settled by outcome, released, undisclosed, unrevealed, no verdict, disputes and
their results, and `later`), every valid finding (class, paid, owed,
revealed-at, settled-at, bCID, dispute result) and every bad-disclosure flag
with what became of the claim. It states facts; the labels (scanned, staked,
under-staked, invited, a false flag) are computed off-chain. A record of 300
claims costs about 4.2M gas to read; a longer one is paged with
`recordPage(artifactHash, listingOffset, listingLimit, itemOffset, itemLimit)`:
a page of the hash's listings and, of the findings and the flags, a window of
each list over those listings, with the totals to page by.

## Deploying

`onchain/deploy_testnet.sh` (Base Sepolia) and `onchain/deploy_mainnet.sh`
(Base, which asks for confirmation) run
`deploy/01_deploy_stake_attestation.js`: `ClaimLogic`, then `RecordLogic`, then
`StakeAttestation` linked to both, whose constructor creates the lens and the
wallet implementation. Every value comes from the environment, which the
scripts may load from an untracked `.env` (`.env.example` names them): the
deployer's `PRIVATE_KEY`, the aggregator (`VERDIKTA_AGGREGATOR_BASE_SEPOLIA`
or `VERDIKTA_AGGREGATOR_BASE`) and the constructor arguments
(`SA_INITIAL_OWNER`, `SA_FEE_RECIPIENT`, `SA_LISTING_FEE_WEI`). The script
writes `deployments/<chainId>-<network>.json` and the merged ABI, and verifies
on BaseScan when `ETHERSCAN_API_KEY` is set (`deploy/verify.js` retries).
`npx hardhat run deploy/01_deploy_stake_attestation.js` with no network
deploys on the in-process network against the mock aggregator, as a test.

## The listing API

`server/` (node P4a) turns a maker's draft into the two archives arbiters read and the
arguments of `list()`. `POST /api/listings` takes `{ spec, knownIssues?, allowlist?, maker,
deploymentProof?, auth }`: the draft `code_review.json` with its stake block and the maker's age
disclosure key, the known issues when `stake.knownIssues` names them, up to 64 invited hunters,
the address of the maker's wallet (required: the project names it in its repository, and the
baseline scan's findings are served to it, below), a contract listing's signature from its
deployer or owner, and the maker's wallet's signature of the challenge
`POST /api/listings/challenge` answers for this request: without it anyone could get an archive
signed, with a disclosure key of their own, by naming a project's address as the maker. Before
any build it decodes the disclosure key with common's `parseDisclosureKey`, checks the draft with common's
validator (over the builder's stand-ins for the fields the builder measures) and refuses what
`list()` would refuse or could not encode (decision D8's windows, a repository URL that is not
printable ASCII within 512 bytes, an amount beyond uint256, a value at risk that is not whole
dollars, more than 256 known issues) and file names that collide with each other, with an
archive member or with the builder's own files: 400 with the issues.
Otherwise it answers 202 with an id, and `GET /api/listings/:id` follows the listing:

| Status | |
|---|---|
| `queued`, `checking` | waiting for a build slot; the project's proof read at the listed commit ([`docs/control-proof.md`](docs/control-proof.md)) |
| `building` | in the builder: `verdikta-build-env build`, then `sign` in a process of its own, each given `--maker` |
| `refused` | `refusal` (`code`, `detail`) when the proof refused it or the server measured it too large for the code-runner's request, otherwise `validationReport` says why. Nothing is built, signed or pinned: a failed verified-source check ends here too |
| `scanning` | accepted and checked, both archives built; the baseline scan runs |
| `pinning` | both archives are being pinned |
| `ready` | `archives` (both CIDs, their SHA-256 and their members') and `list`: `params`, `listingCid`, `disputeCid` and `knownIssueIds`, in JSON ethers takes as it is (uint256 and uint64 as decimal strings, bytes32 as hex); `params.disclosureKey` is the 32 bytes the archive's age recipient encodes |
| `error` | anything else (the builder or pinning failed, or the result did not check out); nothing is issued |

An accepted build is checked before anything is issued: every step of its report passed (for
a contract, the verified source matched), the built `code_review.json` keeps every term the
maker submitted, the known issues are the bytes the server sent, and both archives pass what
the External Adapter checks in `cids[0]` (common's manifest validator, the six outcomes, the
spec, the `code-standard` envelope, the attestation under the configured trust, the known
issues and the baseline) and this site's own rules: exactly these members, common's panel for
the archive's role and common's `buildClaimQuery` output as the query. The listing must also fit its
share of the code-runner's request ([A listing's size](#the-environment-builder)):
`LISTING_REQUEST_TOO_LARGE`, with the size and the bound, whichever of the builder and the server finds
it, and counted by reason on `/api/status`.

**The archives.** Both hold `manifest.json` (`codeReview`, the primary file and the panel),
`primary_query.json` (`buildClaimQuery(spec)` and the six outcomes) and the builder's
`code_review.json`, `attestation.json`, `baseline.json` and `known_issues.json`, byte for byte.
The listing archive's panel is common's `CODE_STANDARD_PANEL` and the dispute archive's
`CODE_STANDARD_DISPUTE_PANEL`; nothing else differs. The ZIP is stored, with a fixed timestamp
and member order, so the same files always give the same CID.

**Pinning** (`SA_PINNING`): `mock` (in memory, for development and tests; refused in
production), `kubo` (a daemon's RPC API at `SA_KUBO_API_URL`), `filebase` (its IPFS RPC API,
token in `SA_FILEBASE_TOKEN`) or `pinata` (JWT in `SA_PINATA_JWT`). Uploads ask for CIDv1 with
raw leaves, and an answer in the raw-block form must be the CID of the bytes sent.

**Config** comes from the environment only; `server/src/config.js` lists every variable: the
trust the attestation is checked under (`SA_ATTESTATION_TRUST`, `production` by default; `dev`
is refused in production and on Base), the builder's command line and config
(`SA_BUILDER_BIN`, `SA_BUILDER_CONFIG`), the variables each builder step gets besides `PATH`
and `HOME` (`SA_BUILDER_BUILD_ENV`, `SA_BUILDER_SIGN_ENV`, never one of the server's own `SA_`
variables), the build queue, and the oracle parameters (`SA_ORACLE_*`; the class is common's
`code-standard`). A credential is named by its variable and read when it is used, so the
parsed config holds none.

**Stopping a build.** Each builder step runs in a process group of its own, with `TMPDIR` inside
a build folder the server removes, so the builder config leaves `workDir` unset. The builder
bounds each of its own steps and cleans up after them; the server's `SA_BUILDER_TIMEOUT_MS`
(4 h) is a backstop above those limits. When it fires, or when the builder exits leaving
processes behind, the group gets SIGTERM (the docker CLI passes it to the container it is
attached to), `SA_BUILDER_GRACE_MS` to stop and then SIGKILL, and the step ends only once the
group is empty. A step the server had to stop keeps its build slot until the server restarts:
a container it started runs under the Docker daemon, and nothing confirms it has gone. The log
says to check the host for containers labelled `io.verdikta.builder=1`.

### The baseline scan and the maker's sign-in

Between listing and open the server scans the staked version (design §8.3, node P4b2): once a
build is accepted and both archives are built and checked, and before they are pinned, it runs
`verdikta-build-env scan` on the built `code_review.json`, in a process of its own like `build`
and `sign` (the variables in `SA_BUILDER_SCAN_ENV` besides `PATH` and `HOME`; `--agent` only with
`SA_SCAN_AGENT=on`). The builder writes `scan-findings.json` into a new folder inside the step's
owner-only folder; the server reads it once, keeps it in memory with the listing (as it keeps the
listing itself; nothing survives a restart) and removes the folder. The archives are fixed
before the scan runs, from the builder's files only. A scan that fails does not hold the
listing back: the scan is not a judgement, and the maker reads why it failed. A request that
names no `maker` is not scanned (`scan.status` is `skipped`, `reason` `NO_MAKER`): nobody could
read the findings. A listing that is refused or not issued is not scanned (`not_run`).

**What is public and what is the maker's:**

| | Who sees it |
|---|---|
| The listing view (`GET /api/listings/:id`): status, validation report, both archives' CIDs and members, the arguments of `list()`, the disclosure key's public half, `maker`, and `scan`: `{ status }` (`pending`, `running`, `skipped` with its `reason`, `not_run`) or `{ status, finishedAt }` (`done`, `error`) | anyone with the listing's id |
| The listing and dispute archives, `known_issues.json` (the maker's own list, byte for byte) and what `list()` stores | everyone: pinned and on-chain. Never anything of the scan |
| The record mirror and the feed (node P4b1) | everyone. Never anything of the scan |
| The scan's document: every finding, the files in scope and skipped, each tool's status and what it did not read, the agent pass's summary, a failure's code and detail | the maker's wallet only, through `POST /api/listings/:id/scan` |
| The server's log | the operator: that the scan ran and its outcome's error code, never a finding, a count, a file name or a tool's output |

No refusal or error the server answers carries anything of the scan beyond its status.

**Signing in.** The findings go to the address in the listing request, proven with a wallet
signature over a one-time challenge (`server/src/auth/walletAuth.js`, written to be reused by
any route that one address may use):

1. `POST /api/listings/:id/scan/challenge` (no body) answers `{ action, resource, address, nonce,
   issuedAt, expiresAt, message }`; 409 `LISTING_HAS_NO_MAKER` when the request named none.
2. The maker's wallet signs `message` exactly as given, with EIP-191 `personal_sign`
   (`signer.signMessage(message)` in ethers).
3. `POST /api/listings/:id/scan` with `{ nonce, signature }` answers `{ id, maker, status, scan,
   error }`: `scan` is the builder's `scan-findings.json`, or null with the server's `error` when
   the scan step left no document. 403 `NOT_THE_MAKER` when another wallet signed; 401
   `CHALLENGE_UNKNOWN` (answered already, never issued, or forgotten after expiry),
   `CHALLENGE_EXPIRED`, `CHALLENGE_MISMATCH` (issued for another listing or action) or
   `SIGNATURE_INVALID`; 400 `AUTH_REQUEST_INVALID`; 409 `SCAN_NOT_READY` with the public status
   while the scan has not finished, checked before the signature so asking early costs nothing;
   a body that is not JSON is 400 `BODY_NOT_JSON`, one over 4 KB 413. Every answer of both
   routes is `Cache-Control: no-store`.

The message is ASCII, one field per line, joined with `\n`, no final newline:

```text
Verdikta stake attestation: sign in
Sign to read the baseline scan of a listing you made. This is not a transaction: it costs nothing and moves no funds.

Version: 1
Action: read-scan
Resource: listing:<the listing's 32-hex id>
Address: <the maker's address, EIP-55>
Nonce: <32 lowercase hex: 16 random bytes>
Issued At: <UTC, ISO 8601 in whole seconds, e.g. 2026-11-02T10:00:00Z>
Expiration Time: <Issued At + SA_AUTH_CHALLENGE_TTL_MS, the same form>
```

The server never reads the message back from the client: it rebuilds it from its own copy of the
challenge and recovers the signer with ethers' `verifyMessage`. A nonce answers one attempt,
whatever its outcome (a malformed signature or another wallet's uses it up too), and nothing
after its expiry (5 minutes by default; at most 32 open
challenges per listing and 10,000 in all, else 429). Only ECDSA signatures of externally owned
accounts are checked: a contract wallet (EIP-1271) cannot sign in, so a project whose treasury is a
multisig names an externally owned wallet in its file. The listing request's own challenge waits in
a pool apart (`list-version`, resource `list-request:<the request's SHA-256>`): anyone can ask for
one, and a flood of them takes nobody's sign-in for a scan or a dispute with it.

**Tests.** `npm test` stubs the builder behind its interface, and pins to the mock store or to
local doubles of kubo, Filebase and Pinata through a fetch that refuses every host but
loopback. The chain tests copy `onchain/contracts` into `server/.hardhat/` (untracked), compile
them with onchain's settings, and send `list()` and `fund()` with the server's JSON on the
in-process Hardhat network against the mock aggregator. `npm run test:builder` (after `npm ci`
in `builder/`) runs the real builder's command line through the API on a draft the builder
refuses at its first step, and the real `scan` on a repository it cannot fetch, which need no
Docker. The scan's tests stub the scanner the same way, and mark every finding with a string
made per run that they look for in the view, both archives, `known_issues.json`, the arguments
of `list()`, every log line and every refusal, and, once the listing is listed and funded on the
in-process chain, in the feed, its events, the record, the badge and the status.

## The feed, the record and the badge

With a deployment configured (`SA_CONTRACT_ADDRESS`, `SA_CHAIN_ID`, `SA_FROM_BLOCK`,
`SA_RPC_URL`), `server/src/site/` (node P4b1) indexes the contract and serves, all of one block,
the indexer's cursor, read by its hash (EIP-1898), so a reorg never mixes two branches in one
answer. Each answer says whether it is `fresh`: the last sync that reached the confirmed head and
the indexed block are both within `SA_MAX_STALENESS_SECONDS` (600).

| Route | |
|---|---|
| `GET /api/feed` | every listing that counts and takes commits (a builder's signature and the project's proof, [`docs/control-proof.md`](docs/control-proof.md); Open, its paid period not over), and `notCounted`, the others apart: hash, artifact, image and scope (from its listing archive, used only when the archive is the listing the chain stores), award table, lowest class counted, bond, windows (seconds, the 1-hour disclose window included), opened-at, funded-until, days open, claims so far, escrow remaining, owed, value at risk, invited, labels, both CIDs and the disclosure key. Unfunded, depleted, rolled, closed and lapsed listings are not in it (design §15) |
| `GET /api/feed/events?after=&limit=` | the contract's events of listings and claims, in chain order (design §13.4: the feed is those events), paged by `next` (`<block>:<logIndex>`) |
| `GET /api/records/:hash` | `record`: the lens's `recordByHash` for the hash at the indexed block, field for field (uint as decimal strings, enums by name), over the listings that count (`notCounted` holds the others, apart; `artifact` and `fork` say what the record is of), read in `recordPage` pages when it is long; `labels`; `badge`; `history`: the indexed events of the record's listings, the published claims and the days since the last valid finding; `integrity`: per listing, the claims that failed integrity, by check, apart from the other duplicates (below). 404 for a hash with no opened listing |
| `GET /api/records/:hash/badge.svg` | the badge; "record unavailable" when the record is not fresh or cannot be read |
| `GET /api/status` | the indexer's cursor, the keeper's address, transaction in flight and last result, and refused listing attempts by reason (`listings.refused`: no address or repository name, kept beside the state) |

**Only valid findings are published** (design §14). A claim's events appear in full once it
settled LOW..CRITICAL (the record's findings); every other claim's events (INVALID, DUPLICATE,
pending, expired) keep only their claim and listing ids, so the site never republishes their
archives, keys, ciphertext, hunter or verdict. The record's counts and flags are the contract's.

**The indexer** reads every event of the deployment from `SA_FROM_BLOCK`, in chunks of
`SA_LOG_CHUNK_BLOCKS`, only up to `SA_CONFIRMATIONS` (10) blocks below the head, and commits each
chunk with its cursor in one atomic write to `SA_DATA_DIR/state.json` (one writer per folder, by
numbered lock files: a process takes the next number only when the highest one is released or
its process is gone, keeps it only if it is still the highest, and lock files are never removed,
so the folder keeps one small file and a release marker per start; a folder of another
deployment is refused). A restart resumes after the last
committed chunk. Each sync asks the endpoint for its chain id (`eth_chainId`; the provider's
request cache is off) and compares the cursor's stored block hash with the chain's; after a
reorg it rolls back to the newest block it read (within `SA_REORG_WINDOW_BLOCKS`) that is still
on the chain, drops the events after it and reads again from there, or from `SA_FROM_BLOCK` if
none is. A chunk whose blocks changed while it was read is not committed.

**The keeper** (erratum E4: the aggregator never calls back) calls `finalize` when a claim's
round is over and `settle` when a judged claim may settle, and `expire` only with
`SA_KEEPER_EXPIRE=on`. Its key is `SA_KEEPER_PRIVATE_KEY`, read when it starts (`SA_KEEPER=off`
turns it off). It reads each claim on-chain and simulates the call before sending it, keeps one
transaction in flight at its next confirmed nonce, recorded before it is broadcast, and
resolves that record first in the next cycle or process: waited for, re-sent at the same nonce
with higher fees after `SA_KEEPER_REPLACE_AFTER_MS`, or, when the call is no longer due,
replaced by a 0-value transfer to itself. When a reorg drops a transaction it had mined, it
fills the missing nonces with transfers to itself, after cancelling a queued call that is no
longer due; a record signed by a previous key is kept until that account's nonce passes it or
its claim is over, and the same call is not sent for that claim meanwhile; an expiry is re-sent
only while `SA_KEEPER_EXPIRE` is on. A retry, a restart
or a second keeper with the same key therefore never makes a call twice; keepers with different
keys can still race, so run one per deployment or share the key.

**Labels** are the site's (the contract states facts only): `scanned` when the top award is
below `SA_BADGE_FLOOR_WEI`, `staked`, `under-staked` when the maker declared a value at risk and
the top award, priced by Chainlink's ETH/USD aggregator at `SA_ETH_USD_FEED` (no older than
`SA_ETH_USD_MAX_AGE_SECONDS`), is below `SA_UNDER_STAKED_RATIO_BPS` of it (no usable price: no
label, never a guess), and `invited` for an allowlist. The floor and the share default to
**placeholders** (0.04 ETH and 10%, `server/src/record/labels.js`) until the owner sets the
launch values at G1; `/api/status` and every record name the placeholders still in use.

**The badge** reads "no finding at or above *class* while staked" (*class*: the listing's
lowest class counted, with "under-staked" or "invited" after it when they apply) while a
listing of the hash takes commits, only "scanned" below the floor, and "*n* valid finding(s) at
or above *class*" once the record holds one; when no listing of the hash takes commits it says
how the stake ended (closed, rolled forward, depleted, lapsed). Every string the server writes
goes through the shared banned-words helper. The feed reads a listing archive's
`code_review.json` from the ZIP's central directory, never extracting it, with byte caps on the
download (`SA_ARCHIVE_MAX_BYTES`) and on each member read, inflated or not. Archive reads run
beside the indexer, one run at a time, so a slow gateway never delays a chain read; a failed
fetch is retried after `SA_ARCHIVE_RETRY_MS`, doubling, counted from the failure.

**Claims that failed integrity** (node P10, owner decision Q35; `server/src/site/evidence.js`,
`server/src/record/integrity.js`). A failed integrity check with no tamper flag settles with all weight
on DUPLICATE: bond back, no award. So on-chain it is a DUPLICATE, and the record keeps it apart. A record's
`integrity.listings[<id>]` has `failed`, `checks` (each check's name in common's order, with how many of
those claims name it), `otherDuplicates`, `unread`, `disagree` and the same again under `late`, and
`integrity.note` says what the count means; the record page shows them. `record.history` stays the chain's,
so for each listing `failed + otherDuplicates` is `outcomes[DUPLICATE]`.

The reason comes from the justification, which is untrusted text from IPFS, so a claim counts as failed only
when all of these hold:

- its `Settled` event says DUPLICATE, whatever any text says. Nothing else is ever fetched;
- its last verdict's `justificationCid` (a dispute round's replaces the first) is a list of at most 16 CIDs;
- **every** CID on it has been read: the aggregator joins the clustered oracles', and reading only the first
  would let that one arbiter move the count;
- each one starts with the block, in the writer's form: `Execution evidence v1` is the very first line, every
  line of the block is `Name: value` with each name once, the settlement is `DUPLICATE (integrity)`, it says
  `Tamper-Flags: none`, and at least one check is named, each one of common's `INTEGRITY_CHECKS`, once, in
  common's order. One unknown name makes the whole block plain. Jury text after the block is never read, and
  neither is the upload's `metadata`;
- they all name the same checks. Report hashes are not compared, since a hash can differ between hosts.

Anything else is a plain DUPLICATE, never an integrity failure: `disagree` counts the claims whose arbiters
state different settlements or checks, and `unread` the ones with a malformed list or a read not done. A failed
read (a gateway down, a file over the cap, an answer with no justification in it) is tried again after
`SA_ARCHIVE_RETRY_MS`, doubling up to 6 hours; an answer with a justification is final, because a CID names its
content. The reads run beside the indexer, one run at a time and at most 8 fetches a run, each download stopped
at 4 MiB; no request and no sync waits for one. The store keeps only the outcome of each read, by CID: known
check names and a settlement in its writer's form, never other text from the upload.

**What the count does not say.** It counts claims that failed a check. It does not say who or what caused a
failure, and a hunter's own failed run raises it too, so it proves nothing about a listing. If every clustered
arbiter wrote the same block falsely, or a gateway answered other bytes for a CID that isn't a raw hash (the
fetcher checks those), an on-chain DUPLICATE would move between the two counts. Nothing else moves: the outcome,
the money, the badge, the labels, the feed and what counts on a record read none of this. A listing that doesn't
count (P9) keeps its count off the record, like the rest of its history.

**The dispute statement** (node P6b; `server/src/dispute/statement.js`). `dispute()` takes the
statement's CID only (erratum E2: the contract writes `verdikta-dispute: <cid>` as the request's
second addendum line), and the browser has no pinning credentials, so the server pins it, for
the listing's maker only, with the same wallet sign-in as the baseline scan (action
`pin-dispute`, resource `claim:<claimId>`):

| Route | |
|---|---|
| `POST /api/claims/:claimId/dispute-statement/challenge` | `{}` → the challenge for the claim's listing's maker; 404 `CLAIM_NOT_FOUND`, 409 `CLAIM_NOT_DISPUTABLE` |
| `POST /api/claims/:claimId/dispute-statement` | `{ nonce, signature, statement }` → `{ claimId, cid, bytes, sha256 }`; 400 `STATEMENT_INVALID` (not a non-blank, well-formed string), 413 `STATEMENT_TOO_LONG` (over common's 4,096 bytes of UTF-8) or a body over 32 KB, 401 / 403 `NOT_THE_MAKER` as for the scan, 409, 502 `PIN_FAILED`, or 502 `PIN_CID_UNVERIFIED` when the backend answers a CID other than the statement's raw CID (CIDv1, raw, sha2-256: one block, the only form the maker's page can check) |

Both read the claim at the latest block (the lens's `disputeDeadline`): only a judged valid
outcome, undisputed and inside its dispute window, takes a statement. The statement and the claim
are checked before the signature, so neither refusal uses the maker's challenge up. The pin goes
to the configured backend as the listing archives do; every answer is `no-store`; without a
deployment both answer 503 `CHAIN_NOT_CONFIGURED`.

**The ABI.** The server reads the contract through `server/src/chain/abi/StakeAttestation.json`,
onchain's merged ABI (contract plus lens), and never compiles; `npm run abi` rewrites it and a
test fails while it differs from the contracts in `onchain/`. Its tests run the indexer, the
keeper (automine off, so transactions wait in a mempool), reorgs (`evm_snapshot` /
`evm_revert`), restarts and a mock ETH/USD aggregator on the in-process Hardhat network.

## The environment builder

`builder/` turns a maker's draft `code_review.json` into a listing the arbiters can run (design
§8.2 steps 1–5, §8.8; build plan A4, A6, D4). `verdikta-build-env build --config builder.json
--spec draft.json --maker <address> [--control-proof proof.json] [--known-issues known_issues.json]
--out out/` runs, recording each step in `out/validation-report.json`, the report the maker reads
before funding. Right after the spec, and before anything is fetched for a build, the `control`
step refuses a listing without the project's proof, by name (node P9;
[`docs/control-proof.md`](docs/control-proof.md)): it reads only the repository's `refs/heads` and
`refs/tags`, so a commit a host serves by id from a fork is refused. A contract's signature is
checked through the explorer the verified-source check reads. The config's optional `control`
block holds `gitHosts` (the site's `SA_CONTROL_GIT_HOSTS`), `timeoutMs` and `maxBytes`.

1. **spec**: the draft against `@verdikta/common`'s `validateCodeReviewSpec` (with stand-ins
   for the fields the builder fills) and what the Foundry MVP hosts: `env.from: "foundry"`,
   `commands.framework: "forge"`; `known_issues.json` when the draft names one, in strict UTF-8 as arbiters read it, and
   not too large on its own (see "A listing's size"). Then **the commands**, by the rule arbiters hold
   claims to (owner decision Q31): `commands.build` is plain `forge build`, `test`, `testFiles` and `testIds` plain
   `forge test`, each with flags from an allowlist, and no shell. The builder holds no copy of that rule. It
   asks the code-runner, in a request that cannot start a run, so what it refuses here is what a
   claim's runner would refuse, by the same code (`COMMAND_NOT_ALLOWED`, `COMMAND_MISSING`, `COMMAND_INVALID`,
   `COMMAND_PLACEHOLDER`), before the `control` step, the fetch or the maker's setup. It first sends a shell in front of each of the
   four: a runner that lets one through has not got the grammar and stops the build (`RUNNER_WITHOUT_GRAMMAR`). The
   report's `commands` records this, and `sign` refuses a report that does not (`COMMANDS_NOT_CHECKED`).
   `commands.setup` is free-form: it runs only while the image is built.
2. **fetch**: the listed commit's objects, by id (shallow when the server allows it), from
   `repo` or a configured mirror of it, into a bare repository. git runs with no system or
   global config, no hooks or credential prompt, https only (and the local transport for a
   mirror path); nothing of the maker's tree is checked out on the host.
3. **build**: `docker build` of a two-stage Dockerfile. The `setup` stage is FROM the foundry
   base pinned in `@verdikta/common` (`BASE_IMAGE_PINS.foundry`, by digest), checks out the
   commit and its submodules at `/repo` (a submodule git cannot fetch is left to the setup, as
   the code-runner leaves one whose objects the image lacks) and runs the maker's `commands.setup` there as root,
   with the build's network. Its `HOME` is a build-only folder that is thrown away, and
   `XDG_DATA_HOME` is `/opt/verdikta/tools/share`, so tools installed the usual way (forge's
   solc downloads) land outside `$HOME` and `/tmp`; `$VERDIKTA_TOOLS/bin` is on `PATH` after
   the base's own directories. The final stage is FROM the same pinned base and **runs
   nothing**: it copies `/opt/verdikta/tools` (owned by root) and `/repo` (owned by uid 10001,
   the sandbox user, with the commit's objects and the installed dependencies) and declares no
   `VOLUME`, `USER`, `ENTRYPOINT` or `CMD`, so `/bin/sh` and its path are the base's, root's.
   The setup text is `setup.sh` in the build context, never Dockerfile text; the build has no
   build argument, secret or SSH agent. That is the image the code-runner's README asks for
   ("What the env image (P3a) must provide"). The setup stage's network is the build host's
   default container network: run `build` on a host whose containers can reach nothing
   private (no instance-metadata credentials, no internal services), as the ephemeral hosted
   runners of design §20 decision 3 are, or block those addresses from the build network.
4. **size**, **push**, **registry**: the unpacked size as the code-runner measures it (the layer
   sizes `docker history` lists; over 6 GB is refused before the push), the push to the
   configured registry (the image is its digest from here on), and the registry's linux/amd64
   manifest, read back and checked against the digest: over 2 GB compressed, or any `VOLUME`,
   is refused. Config may lower both limits, never raise them.
5. **verifiedSource** (a `contract` listing): the explorer configured for the listing's chain
   (Etherscan v2 API: `getsourcecode`, `eth_getCode`) against the repository's own build at
   baseCommit, made with tools the listing did not choose. In one sandbox of the pushed image
   (no network, uid 10001, read-only root, fed on stdin), the listed commit's files are laid
   out from the objects the builder fetched by id (each submodule's by the commit its gitlink
   records; never the image's checkout or objects), the image's untracked files (its installed
   dependencies) around them, never over a tracked path, as the code-runner's checkout keeps
   them (a submodule it cannot fetch over https by its gitlink commit stays an empty directory,
   and a verified file inside one is refused); then the pinned base's forge builds the contract's file with `--use` the solc release
   the explorer names, from binaries.soliditylang.org (`solc.baseUrl`) checked against the
   SHA-256 its `list.json` publishes. A maker's setup can install anything as `solc`, so the
   listing's own compiler is never used. The listing stops unless: every verified file is
   byte-identical to that path in the tree the build reads (through any symbolic link, as the
   build reads it); `foundry.toml` pins that solc release and the verified optimizer, EVM and IR
   settings; the build of the contract uses only
   verified files, with their bytes (no remapping picks another); and its runtime code is the
   deployed code, every byte but the immutables and solc's metadata trailer. A proxy, a
   flattened source, an unverified address or an unlinked library (whose address could not be
   checked) is refused.
6. **listingCheck**: the code-runner's `POST /v1/listing-checks` (verdikta-arbiter A2b), the
   runner the arbiters use: build once, the suite three times without network, `baseline.json`,
   the timings, the default limits and the harness proof. Its refusals (`LISTING_TOO_HEAVY`,
   `LIMITS_BELOW_DEFAULTS`, `LEGACY_ASSERTIONS`, `BUILD_FAILED`, ...) and its 400s stop the
   listing; an abstain is an error to retry.
7. **finalSpec**: `code_review.json` with `env.image` (the digest), `env.platform`
   (`linux/amd64`), `env.unpackedBytes` (the larger of the builder's and the runner's
   measurements) and the limits (the draft's where it set them, the runner's defaults
   otherwise), checked by `validateCodeReviewSpec`; `baseline.json` as the runner returned it,
   checked by `validateBaseline`; and the whole listing measured against the code-runner's request.

Exit status 0 accepted, 2 refused (the report says why, with the build's log when the setup
failed), 1 error. `verdikta-build-env sign --config builder.json --dir out/ --maker <address>` then
reads the project's proof again and signs `attestation.json` (`createAttestationStatement` over the exact bytes written, Ed25519) and
records it in the report; `run` does both in one process, with a dev key only.

**A listing's size.** For each claim an arbiter's External Adapter sends the code-runner one JSON
body, and the runner answers 413 above 16 MiB (16,777,216 bytes). The listing's `code_review.json`,
attestation, baseline and known issues are in that body every time, so a listing that leaves a claim
no room makes every arbiter abstain on every claim, and under erratum E6 the bonds then go to the
maker. So a listing may take at most 2 MiB (2,097,152 bytes) of it, measured as the body holds it:
`JSON.stringify(JSON.parse(file))`, and a known-issues file, which is attested as given, at its file
size if that's larger. `finalSpec` refuses one over the bound with `LISTING_REQUEST_TOO_LARGE`, stating
the size and the bound; `spec` refuses known issues too large on their own, before anything is fetched;
and `sign` measures again before the key is asked for anything, exits 2 and says why in the report.
`validation-report.json` records `listingRequest`: the bytes, each part's and the bound.

The bound comes from the request. With the listing's parts empty, a claim and its 8 prior findings at
their caps, every character of text at JSON's widest (6 bytes), make a body of 12,784,423 bytes at
`code-standard` and 14,224,422 at `code-premium`, whose `report.md` may be twice as long. That leaves the
listing 3,992,801 and 2,552,802. The External Adapter sends `code-standard` today, but a listing is signed
once, so the bound holds for both. `shared/src/listingRequestSize.js` measures this by building the
request, and lowers the bound if a release of `@verdikta/common` ever leaves less. One test costs about
`2 × id length + 46` bytes, so 2 MiB holds roughly 8,500 tests with 100-character ids. The arbiter's code
can't be imported from here, so what is its own is pinned in that file, each number with its source, and
`e2e/test/requestSize.test.js` holds that and the copy of the request to verdikta-arbiter at the pin.

**What sign checks first.** Signing may run in a job that receives only the build's output folder
(the reusable workflow below), so before any signature exists `sign` checks what it can without
re-running the build (`src/verifyBuild.js`) and refuses on the first failure, writing nothing:
the report accepted the listing; the files are the bytes it accepted; `code_review.json`, the
baseline and `known_issues.json` validate; the report is about this repository, commit and
artifact, records every step of a build (the verified-source match for a contract), a runner with
the commands' grammar that took these commands, and an accepted listing check; it names the image, platform, base and sizes `code_review.json` names,
inside the class limits. `--expect-outputs <hex>` also requires the folder to be byte for byte
the one `verdikta-build-env digest --dir out/` digested in the build job. `--check-registry` reads
the image `code_review.json` names from its registry without a credential, as arbiters pull it,
and requires the manifest and compressed size the build measured, no `VOLUME`, layers that begin
with the pinned base's (`rootfs.diff_ids`, which do not depend on compression) and the listed
commit's `io.verdikta.listing.base-commit` label. The report's `signing` records `checks` and
`trusts`: what only a re-run could check, namely the code-runner's answer (baseline, timings,
limits, harness proof, and the runner, runtime and platform it names), the verified-source
comparison, the unpacked size, that the build job ran this builder unmodified, and, without the
two options, the folder in transit and the image's publication. A maker's own CI is the maker's
to vouch for, so a production key signs only in Verdikta's own workflow.

**The signing key** is `signing.key` in the config, one of:

| Value | Trust | |
|---|---|---|
| `"dev"` (default) | `dev` | A fresh Ed25519 key per run, in memory only. Its public key is written to `dev-trust.json`, the `{ dev: true, keys }` option `validateAttestation` takes; production verification refuses its attestations (build plan A6). |
| `{ "env": "VERDIKTA_BUILDER_KEY" }` | `production` | The production key as a deploy secret: a PKCS#8 PEM Ed25519 key in that environment variable, filled from the deployment's secret store or KMS. Read once and removed from the environment, so no child process inherits it. |
| `{ "command": ["/usr/local/bin/kms-sign", "..."], "publicKey": "<base64 of the 32 raw bytes>", "env": ["AWS_PROFILE"] }` | `production` | An external signer, the KMS interface: the builder writes the signing bytes (`verdikta-attestation/v1`, a newline, the canonical JSON of the statement) to its stdin and reads the 64-byte signature, base64, from its stdout. The key never enters the builder; the signer gets `PATH`, `HOME` and the variables listed; every signature is checked against `publicKey`. |

The production key is never in code or config (decision D4). It signs only what production
verification would accept: its id must be in `@verdikta/common`'s trusted-builder set (empty
until node C6, so today every production signing is refused and nothing is written), and the
listing must have been validated under gVisor on linux/amd64. `build` refuses to start while
the `env` key is in its environment (it runs the maker's setup), and `run` refuses a production
key: signing is its own step, as design §20 decision 3 has it. No private key is written,
logged or put in the report.

**Config** (`builder.json`; paths relative to it):

```json
{
  "registry": { "repository": "ghcr.io/verdikta/stake-env" },
  "runner": { "socket": "/run/verdikta-code-runner/runner.sock", "tokenFile": "/run/secrets/code-runner-token" },
  "explorers": { "8453": { "apiUrl": "https://api.etherscan.io/v2/api", "apiKeyEnv": "ETHERSCAN_API_KEY" } },
  "signing": { "key": { "env": "VERDIKTA_BUILDER_KEY" } }
}
```

Also `solc.baseUrl` (default `https://binaries.soliditylang.org`, or a mirror with the same
layout) and `solc.cacheDir` (binaries kept by their SHA-256), `registry.apiUrl` (where manifests are read, when not the repository's host), `runner.url`
(loopback over http, else https) and `tokenEnv`, `runner.deadlineMs` (default 900000),
`registry.publishAs` (the repository `code_review.json` names when the build pushes to another,
e.g. a loopback registry:2 whose image a later step copies there byte for byte, digest kept),
`scan.agent` (below),
`limits.imageCompressedBytes` / `imageUnpackedBytes` (lower only), `repoMirrors` (`{ "<https
repo>": "<path or https URL>" }`), `workDir`, `docker.bin` / `host` / `buildTimeoutSeconds` /
`pushTimeoutSeconds`, and `platforms` (below). Secrets are named by where they live and read
when used; the parsed config holds none. Pushing uses the docker CLI's own credentials.

**Platforms.** The class platform is linux/amd64 and so is every production build. On an arm64
host without amd64 emulation (Apple silicon), `"platforms": { "setup": "linux/arm64", "run":
"linux/arm64", "extra": ["linux/arm64"] }` builds an index of linux/amd64 and linux/arm64 (the
final stage runs nothing, so the amd64 variant needs no emulation), runs the setup natively and
runs and measures the arm64 variant, as the code-runner's own `CODE_RUNNER_PLATFORM=linux/arm64`
does. The report lists that under `devOnly`, and a production key refuses to sign it.

### The baseline scan

Between listing and open the site scans the staked version (design §8.3) so the stake pays for
findings that take work, not for bugs a scanner finds for a dollar. `verdikta-build-env scan
--config builder.json --spec code_review.json --out <dir>` fetches the listed commit's objects by
id (as `build` does; submodules are not scanned), takes the files `stake.scope` includes and does
not exclude (symbolic links are not followed), and runs over them, each in a fresh sandbox of its
image with no network, a read-only root and uid 10001, the files fed on stdin as a tar stream:

| Tool | Pin |
|---|---|
| Semgrep | `semgrep/semgrep` 1.181.0, by digest (`src/scanTools.js`) |
| Verdikta's Solidity rules | `scan-rules/solidity.yml`, rule set `2026.10` (common's `SEMGREP_RULES_VERSION`), its SHA-256 pinned: a changed rule is refused until the pin and the version move |
| The secret scan | `zricethezav/gitleaks` v8.30.1, by digest, with its built-in rules and `--redact` |

The rules flag `tx.origin` authorization, Ether sent by a low-level call before a later mapping
write, ignored low-level call and ERC-20 transfer results, `transferFrom` from a caller-chosen
address, `delegatecall` to a parameter, block values used as randomness and `selfdestruct`.
Semgrep reads the in-scope `.sol` files from a folder whose empty `.semgrepignore` replaces its
default exclusions (`test/`, `vendor/`, ...); the secret scanner reads every in-scope file but its
own configuration files at the root. Each tool's `notScanned` names, with the reason, every file it
did not read: over Semgrep's 2 MB or the secret scanner's 5 MB per-file limit, missing from what
Semgrep reports it analysed, or skipped by the secret scanner (its built-in allowlist of lock
files and `node_modules`, binary files, archives, empty files), in the words of its trace log.
What verdikta-arbiter's code-runner measured of Semgrep 1.181.0 (its README, "What the runner forces"), a maker's scan
gets the same way, so it isn't quietly smaller than it looks. Its answer comes from a file: under gVisor its stdout can be cut at 64 KiB with exit 0. CI runs
this under `runsc` too, and a cut answer of any size does not parse, so it fails the scan. `--disable-nosem`: a `// nosemgrep` in
the source drops no finding. A rule named in `skipped_rules`, or an answer from another release, fails the scan.
And past 10,000 matches of one rule in one file Semgrep drops every result for the file with exit 0, so that file goes in `notScanned`
with the rule, and out of `analysed`, as does any other file Semgrep reports an error on (a rule past its time or memory, a parse failure), in fixed words.
`--agent` adds the one inexpensive agent pass, **off by default**: the model named in
`scan.agent` (`{ "provider", "model", "apiUrl"?, "apiKeyEnv" }`, a model of common's
`code-standard` pool served over a chat-completions API: OpenRouter, OpenAI or xAI) reads the
in-scope source (up to `maxSourceBytes`, fenced as data) with the scope and the severity rubric,
and lists candidates at or above `lowestClassCounted`, each with a sketch of the test that would
demonstrate it. The token is read from `apiKeyEnv` when the pass runs. Its answer is read as
data: JSON of a fixed shape, bounded, every path one of the files sent. The model is given only
the plain-text files the secret scanner's trace log says it opened and did not skip (never an
archive or a binary file), with every line it flagged replaced, all of them and not only those
the findings file keeps; without a complete secret scan (a failed run or a cut log) there is no
agent pass. The provider sees the source it is sent
(public already) and its own answer, which is one more reason the pass runs only when asked for.

The result, `scan-findings.json`, is **the maker's alone**: not a judgement, paying nobody, and
kept out of the record, the jury and `known_issues.json` unless the maker writes a finding there
themselves. So it is written only into a new or empty folder of its own (owner-only
permissions), never beside a listing's files: `sign` refuses a folder that holds it, and a draft
cannot give a listing file its name. A tool's finding keeps the rule, the path, the lines and the
rule's fixed message, never a source line or a secret's value, and a tool's error only its kind and
place (Semgrep's messages can quote the source). An agent candidate is the model's own words,
which may quote the source it was sent, never a line the secret scan flagged. The command prints where the file is and
nothing of what it says, not even a count, so its output can sit in a public CI log; a scanner
that fails is an error whose details are in the file. The reusable workflow below does not run
the scan: its logs and artifacts can be public. The site runs it on its own host (node P4b2).

### The reusable builder workflow

`.github/workflows/stake-attestation-builder.yml` runs the same builder for a maker's CI or for
the site's own workflow (design §8.2, §20 decision 3). A repository calls it at a commit of this
one and passes that commit as `builder-ref`, with `spec` (the draft's path in the calling
repository), `known-issues`, `maker` (required: the wallet that will send `list()`, named in the
listed commit's `.verdikta/stake-control.json`, or the build refuses the listing),
`deployment-proof` (a contract listing's signature, as a file in the calling repository),
`publish-repository` (e.g. `ghcr.io/<owner>/stake-env`, readable
without a credential), `runtime` (`runsc` by default; a production key needs gVisor),
`explorer-api-url` (a keyless Etherscan-shaped API for a contract listing's chain, so the build
job holds no explorer key), `signing` (`dev` by default, or `production`) and `artifact-name`
(the prefix of its artifacts' names: by default one derived from the spec, known issues and
repository, so one run can build several listings). Its outputs are `image` and
`signed-artifact`, the artifact holding the signed listing files. Three jobs:

1. **build**, `contents: read` and no secret: checks out the builder and only the draft and the
   known issues of the calling repository (the builder fetches the listed commit itself), blocks
   the runner's metadata addresses from containers, installs common's gVisor release
   (SHA-512-checked; `builder/action/pins.json`, which also pins registry:2, skopeo and the
   code-runner's commit), and starts with `builder/action/services.js` a
   registry:2 on the runner's loopback and the code-runner of verdikta-arbiter at the pinned
   commit with a token made for the run. A listing check does not run the scanner, so the job does not pull the Semgrep image a
   claim needs: `services.js` takes a `/health` of 503 whose only reason is that image, and nothing else, as up. `build` asks that runner about the
   commands, pushes to that registry with no credential,
   validates there and names `publish-repository` in `code_review.json` (`registry.publishAs`);
   the image leaves in skopeo's `dir:` layout (`builder/action/image.js export`: the pinned skopeo,
   `--preserve-digests`; unlike its `oci:` layout this reads back any manifest type, and `docker
   push` writes Docker schema-2) and the output folder as artifacts, the image and the folder's
   digest as job outputs.
2. **publish**, `packages: write`, runs none of the maker's code: `builder/action/image.js
   publish` checks the layout holds exactly the digest `code_review.json` names, with every
   manifest and blob intact, pushes it byte for byte with the job's token in an auth file of its
   own (never on a command line), and reads it back without a credential.
3. **sign**, in the `signing-environment` (default `stake-attestation-signing`, whose secret
   `VERDIKTA_BUILDER_KEY` is the production key, read only when `signing` is `production`):
   checks out the builder only, downloads only the output folder, and runs `sign
   --expect-outputs <the build job's digest> --check-registry`.

**Where the image is published.** An arbiter pulls only from its `CODE_RUNNER_REGISTRY_ALLOWLIST` and abstains on anything else, and a claim that
only gets abstentions ends with the bond to the maker. What an operator's list holds can't be read from here, but the default of the runner at the pin
can (`ghcr.io/verdikta`): `services.js` warns when `publish-repository` is off it, and with `signing: production` it stops.

The workflow has no trigger of its own and nothing in this repository calls it: publishing under
Verdikta's registry namespace is owner gate G1. Its tests read its YAML and unit-test the scripts
it calls (`test/unit/action.test.js`); `test/docker/image.docker.test.js` runs the image hand-off
with the same script and skopeo between two throwaway registry:2 (a Docker schema-2 image, an OCI
image and a multi-platform index); CI lints it with a pinned actionlint.

**Tests.** `npm test` runs the unit tests (no Docker; explorer answers come only from recorded
responses in `test/fixtures/explorer`, in the Etherscan v2 API's shape, for the fixture contract
`test/fixtures/vault`). `npm run test:docker` builds the fixture with a real daemon, pushes it to
a throwaway `registry:2`, runs the source check (with solc 0.8.31 from binaries.soliditylang.org;
an adversarial listing whose setup rewrites a tracked source, links an untracked alias to it and
plants a `solc`; and listings that pin another solc or turn the optimizer off), and validates it on the code-runner
from verdikta-arbiter at the commit pinned in `test/docker/code-runner.pin.json`, started as a
sidecar on loopback with its own token and environment (`SA_CODE_RUNNER_DIR` points at a
checkout of that commit's `code-runner/`; otherwise the tests fetch it). The fixture's commands are plain `forge`,
its setup lets forge download an official solc (the build's network), and one of its tests asks through ffi
for the routes it has, so a listing accepted with that test stable shows the network was there at setup and on none of the
suite's runs. Shell-prefixed commands are refused there by the runner's own code, and an image holding a changed `solc` or a
`vyper` is refused by name (`SOLC_NOT_OFFICIAL`, `VYPER_NOT_SUPPORTED`). `test/docker/action.docker.test.js` runs the reusable workflow's
`services.js` for real, on Linux, where the Semgrep image a claim needs may not be there yet. `SA_BUILDER_TEST_RUNSC=1`, on a daemon
with `runsc`, also runs the real Semgrep under gVisor.
The Docker tests also run `sign`'s checks on that build, the registry read included, and the
scan with the real pinned Semgrep, rules and secret scanner over the fixture plus planted bugs
and a secret written at run time (`test/fixtures/scan`). The scan's and the agent pass's unit
tests use doubles only: no test holds a provider key or reaches a provider.

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

## The hunter tool

`tool/` (node P5) is the hunter's side of a claim, a CLI and a library (`createHunter`, `src/hunter.js`): the CLI only parses
arguments and prints. Base Sepolia and local nodes only, for now: any other chain is refused.

A claim folder holds `finding.json`, `report.md`, `poc.patch` and optionally `fix.patch`.

```bash
export VERDIKTA_CONTRACT=0x…  VERDIKTA_IPFS_GATEWAY=https://…  VERDIKTA_PIN_BACKEND=pinata  VERDIKTA_PIN_TOKEN=…
export CODE_RUNNER_URL=http://127.0.0.1:8090  CODE_RUNNER_TOKEN=…   # for check
verdikta-attest check  ./claim --listing 12        # free, and nothing leaves this machine
verdikta-attest commit ./claim --listing 12 --yes  # bond + prepay; asks for --yes after saying what that means
verdikta-attest status ./claim                     # the fix window, and what comes next
verdikta-attest reveal ./claim
verdikta-attest status ./claim --wait              # polls the evaluation, up to 15 minutes
verdikta-attest claim  ./claim                     # finalize, settle, withdraw: whatever is due
```

The wallet key comes from `VERDIKTA_WALLET_KEY` or `--key-file <path>` (0600), never from an argument.

- **`check`** runs the arbiters' code-runner minus the jury, on the request an arbiter would send, and prints the gate forecast
  and the context pack. The pack, build output and recorded messages quote the proof in the clear, on this terminal only
  (`--no-pack` prints status and codes alone). The runner must
  be on this machine unless `--remote-runner` is passed, since it reads the plaintext. A failed gate says what it would settle as
  (`external-adapter/src/codeReview/settlement.js`). An **abstain** (a proof that loops or runs out of memory) is shown as one, with
  what it costs: every arbiter abstains the same way, each failed round costs the base fees, the bond goes to the maker if no
  round settles, and nothing on-chain or on IPFS says why, so `check` is the only place to see it. On `linux/arm64` there is no
  report, only gates and the pack. The forecast does not catch a trap keyed on the date: the runner fakes no clock.
- **`commit`** refuses a listing the builder did not sign, or whose on-chain key or terms are not what was signed; says P9's warning
  and the §8.6 diligence text; draws fresh keys; and leaves `archive.zip`, `keys.json`, `ciphertext.age` and `state.json` in
  `<claim>/.verdikta-claim/` at 0600. **Back that folder up: without its keys a claim cannot be revealed, and the bond is lost.**
  It sends `commit` with the bond and the live fee, and only once that is mined pins the ciphertext and calls `disclose`.
- **Run it again.** A stopped `commit` or `reveal`, at any point, goes on from what was saved. It sends the saved transaction
  again rather than a second one: the contract takes the same hashes twice, for a second bond.
- **`reveal`** refuses before the fix window ends or out of commit order, before the plaintext is pinned. `reveal --retrigger`
  sends a failed round again.
- **`status`** reads a judged claim's reason from the first block of its justification only (`Execution evidence v1`); jury text
  after it can say anything, and is not read.

**What `finding.json` names.** `check` and `commit` warn, from a static read of the patch and before anything runs, of what
would fail the runner's `claimedObservable` gate. The gate decides (`code-runner/src/observable.js`, design §10.1); the rule is
its own:

- `poc.command` and `poc.observable` are text. The runner never runs the command, so what counts is what the text spells, and
  nothing follows a shell. Name a test the patch adds and no other test: a name counts wherever it is spelled, in a filter, a
  path or a quote, and a name built at run time is not read.
- A word that is exactly one of forge's test-function prefixes (`test`, `invariant`, `statefulFuzz`, `table`, `check`, `prove`)
  names nothing in either field, unless the patch adds a test of that name. A plain `forge test` names no test, even on a
  listing with a baseline test called `test()`, and it is no name for the PoC's test either.
- In `poc.command` an identifier ending in `$` counts as itself and as what comes before it, so `^test_x$` names `test_x`. In
  `poc.observable` it counts as itself only: `$` belongs to a Solidity identifier there.
- Quote what forge prints, in double quotes: each quoted fragment must appear in the recorded failure on every run.

The read sees the patch, not forge's list of tests or the recorded failure, so a warning can be wrong where they differ: a test
inherited from elsewhere, a baseline test's declaration edited, `check` and `prove` tests (forge's only with symbolic entry
points on), or an observable that holds the whole message with nothing quoted. The `check` command, with a runner, answers those.

A pinned file is held to the chain: its bytes are hashed against the on-chain commitment before the upload and read back through
the gateway after it, and a raw CID (`bafkrei…`) is recomputed. So a gateway the arbiters cannot reach is the hunter's to avoid:
read-back through a local gateway proves less than one through a public one. Exit codes: 0 done, 1 refused or failed, 2 usage,
3 `--yes` needed, 4 still pending (run the same command again).

## The client

`client/` (nodes P6a, P6b) is the site. Routes are in the hash: `#/feed`, `#/record/<hash>`,
`#/list`, `#/fund/<listingId>`, `#/claim/<claimId>` and `#/check/<claimId>`; nothing private ever
goes in a URL.

- **Listing** (`#/list`): the artifact (a repository, or a deployed contract with its chain),
  scope, award table, lowest class counted, bond, windows (design §7.1's defaults: 14 days, 30
  for a contract, 72 h, 48 h, 7 days), invited hunters, known issues (their ids are common's
  `knownIssueId`) and the declared value at risk. The form holds the windows to decision D8
  (fix window 0 to 90 days, dispute 24 to 2160 hours, reveal 3 to 90 days, grace no longer than
  the fix window) and leaves every other rule to the server, whose issues it shows. It follows
  the listing through `GET /api/listings/:id`, shows the validation report, and once ready
  sends `list()` with the server's arguments and `fund()` with `feeDue()` plus the escrow
  through the maker's wallet. `list()` is sent only when those arguments carry the maker's own
  disclosure key and terms, and not when the maker already has an active listing of the
  version (`activeListingOf`), which the page links to instead, and only from the wallet the
  listing was built for. The request names the connected wallet as the `maker`, and that wallet
  signs it; without a wallet nothing is sent. A refusal shows here by its code. A contract
  listing's signature is made in the form, with the message the server states; once the
  baseline scan has finished, the page asks for its sign-in challenge, the wallet signs it with
  `personal_sign`, and the findings are shown on the page to that wallet only, never stored,
  and only while it stays the connected wallet.
- **A listing's page** (`#/fund/<listingId>`): its stored terms and, while it is Listed, the
  opening `fund()`, so a maker who leaves between `list()` and `fund()` can come back. Just
  before sending, the listing's state and fee are read at one block through the wallet: unless
  it is still Listed with the terms the page shows, nothing is sent, and the fee passed as
  `expectedFeeWei` makes an opening fund that lands first from elsewhere revert this one.
  Reads are checked to come from `VITE_SA_CHAIN_ID` (`chainReader`), and every transaction asks
  the wallet whether its account and chain are still the connected ones. Once it opened, the
  page lists its claims (from the record mirror's events) and links to its record; while it is
  Open or Depleted, **roll forward** offers the maker's own open listings of the same
  repository at another commit (from the feed, each confirmed on-chain: Open, the maker's, no
  predecessor) and sends `rollForward` after reading both listings again at one block.
- **Every listing page** (the feed, the record, a listing's own page) warns who reads a proof
  first and that the code may exist elsewhere (`shared/src/listingWarning.js`, which the hunter
  tool repeats). A listing's own page says whether the site offers a commit on it.
- **The record** (`#/record/<hash>`, design §4.1, §13.4): from `GET /api/records/:hash`, the
  artifact (hash, kind, repository and commit from the Listed event, and whether the host says it
  is a fork), each stake that counts (state, labels,
  award table, lowest class counted, bond, escrow, owed, declared value at risk and the top
  award's share of it, the times, days open, predecessor and successor, and the claims that failed
  integrity with each check's name, apart from its other duplicates), the history (claims,
  claims judged, verdicts by outcome, claims that failed integrity, other duplicates, released,
  expired, disputes and their outcomes, days since the last valid finding), the valid findings, what was found later (late
  claims), the bad-disclosure flags with what became of each claim, and the badge with its
  Markdown and HTML embed. Any other listing of the hash shows apart, as not counted, with why
  and no amount. Then the diligence text: what a record says and does not (design
  §4.1, §4.2, §15, without third-party figures). Only valid findings are listed; every other
  claim is a count.
- **The feed** (`#/feed`, design §15): `GET /api/feed`, every listing that takes claims, with
  its artifact, hash, labels, award table, lowest class counted, bond, windows, times, days
  open, claims so far, escrow remaining, value at risk, image and scope, and links to its record
  and its page.
- **A claim** (`#/claim/<claimId>`): its state and times from the chain (the lens's derived
  state and `claimTimes`), and the maker's actions through the wallet, each after reading the
  claim again: **release** inside the fix window of a disclosed claim, and **dispute** of a
  judged valid verdict before `disputeDeadline`. The dispute panel shows the escalation prepay
  (the lens's `disputeFee`, the dispute panel's `maxTotalFee`) before anything is sent; the
  statement (at most 4,096 bytes) is pinned by the server after the wallet signs its challenge,
  its CID must be the raw sha2-256 CID of the bytes or nothing is sent, the prepay is read
  again and a higher figure stops the dispute until the maker has seen it, and `dispute()`
  pays it. Each claim read is of one block (the claim, its listing and the lens views). A
  **pending evaluation** (a Revealed claim, or a Disputed one) is read every 5 seconds for up to
  15 minutes, each read given at most 30 seconds and never past the 15 minutes; then the page
  says plainly that no verdict was recorded in that time and offers a re-check.
- **Disclosure key.** "Generate" makes an age X25519 pair in the page with
  `@verdikta/common/src/codeReview/disclosure.js`, common's browser-safe entry, which Vite
  bundles as it is (no shim: @noble takes randomness from `globalThis.crypto`). Only the public
  half enters the listing. The private half is shown once, offered as a key file in
  age-keygen's format (stock `age -d -i` reads it) and dropped from the page when the maker
  says it is saved. It is never sent, logged or stored: the client uses no browser storage at
  all (`test/noStore.test.js`), and a Playwright test records every request of a whole maker
  session and fails if any carries the key in any encoding. A maker with an age key already
  enters its public half instead.
- **Decrypt-and-check** (`#/check/<claimId>`): reads the claim and its listing from the chain,
  fetches the disclosed ciphertext from `VITE_IPFS_GATEWAY`, checks its SHA-256 against the
  commitment, decrypts it with the maker's private key (pasted or loaded from the key file)
  using common's `decryptDisclosure`, and compares the plaintext's SHA-256 with the committed
  archive hash, all in the browser. A key that is not the listing's is the maker's mistake and
  is reported as such. A copy that fails, or that cannot be fetched, may be flagged with
  `flagBadDisclosure` through the wallet while the chain's clock is inside the grace period.

**Config** is Vite's build environment: `VITE_SA_CHAIN_ID`, `VITE_SA_CONTRACT`,
`VITE_SA_RPC_URL` (reads; without it, reads go through the wallet) and `VITE_IPFS_GATEWAY`.
The API is same-origin under `/api`; `vite` and `vite preview` proxy it to `SA_API_URL`
(default `http://127.0.0.1:5009`).

**Wording.** The record states facts only. Every UI string is in `src/strings.js`;
`test/wording.test.js` runs the shared banned-words helper and a guard against judgemental
phrases (safe, secure, audited, bug-free, vetted, approved, guaranteed, a medal tier, ...;
`e2e/support/wording.js`) over all of them, and the Playwright tests run both over the text the
record, feed and claim pages render, the server's labels and badge included.

**Tests.** `npm test` covers the form model, the known-issue ids against common's, the key
file, decrypt-and-check with common's real encryption, the record's view, the 15-minute watch,
the release and dispute rules, roll-forward successors, the dispute statement and its CID, the
enum names against the contract and the wording. `npx playwright test` starts
`e2e/support/stack.mjs`: StakeAttestation deployed on the in-process Hardhat network as the
server's chain tests deploy it, behind Hardhat's JSON-RPC server; the real API server with
mock pinning, dev trust and the server's own fake builder CLI as its builder, and its chain side
(indexer, keeper, feed, record mirror, badge, a Chainlink ETH/USD stand-in); an IPFS gateway
stand-in that also serves what the server pinned; and the production build. The browser's wallet is an injected EIP-1193 provider that
forwards to the local node's unlocked accounts. `SA_SCREENSHOTS=1` writes the screenshots under
`client/test-results/screenshots/`, with every private-key field masked.

## The local round

`e2e/` (node P7) is the first time every piece runs together: one script, on one machine, with nothing live.

```bash
cd stake-attestation/e2e && npm ci && npm test     # the unit tests, the round, and the round broken on purpose
cd stake-attestation/e2e && npm ci && npm run round # the round alone: exit 0, or 1 and why
```

It needs Docker and Node, and installs the rest itself: every package here from its lock file, verdikta-arbiter at the commit in
`e2e/arbiter.pin.json` (fetched by id from its public repository, into `e2e/.arbiter/`), its contracts compiled, Chromium for
the client's pages. It downloads images and packages (the pinned Foundry base, `registry:2`, Semgrep, which the runner needs before it starts, and gitleaks, solc 0.8.31 from
binaries.soliditylang.org, npm) and uses no credential. It reaches no real chain, provider or pin service: the local IPFS fails a run
on any CID it does not hold, and every service gets its own small environment. **What it promises about what it leaves:** after it exits, on success, failure, a crash or a signal, no process group it started and no container or
image it labelled remains; and if one does, or it cannot say, the run has failed. That is the whole promise. A process it did not start is out of
scope (an AI Node someone runs by hand on this machine, say), and so are the pinned images it pulled and BuildKit's cache, which stay as any build's do. A signal stops it in two phases: a flag that everything that only waits
honours and the closers of what has started; then the main flow comes back, so that a step already on its way to creating something gets its closer,
and the sweep runs last. That wait is bounded at 3 minutes, many times the 7 to 11 s the whole start stage takes, and past it the run has failed by
name and the sweep runs anyway. A second signal changes nothing. Logs stay in a folder of the run's own under `e2e/.round/logs`,
which is emptied, or under `SA_E2E_LOG_DIR`, where nothing is removed; and `--report <file>` writes the checks as JSON. `SA_E2E_ARBITER_DIR` runs another checkout, which must be at the
pin unless `SA_E2E_ARBITER_UNPINNED=1`. `e2e/test/failure.test.js` breaks it on purpose (`SA_E2E_BREAK`: a runner that will not start, a jury that
cannot be reached, a crash, a service whose leader dies, a live process group after every check passed; SIGTERM while running, mid-build, mid-scan, with EA requests out, twice during the startup, with a step that creates
something after the signal, and with one that outlasts the bound) and reads the exit code.

One listing of the builder's fixture takes four claims, in commit order: **a valid one** (every gate passes, the jury decides, HIGH,
the award and bond after the dispute window), **a gate-failing one** (a PoC that edits source: the runner's `testPathsOnly`, INVALID at
once, the bond to the maker, no model asked, the first claim among its prior findings), **one that fails an integrity check** (a PoC that fails as the valid
one does and writes `.gitignore`, a path the listing protects, on real forge: `protectedPathsUnchanged`, no tamper flag, DUPLICATE at once, the bond back, no model asked; its check
name reaches the API and the page from the real writer's justifications, through the real reader) and **an abstaining one** (a PoC that never ends:
the runner's clock stops it, no arbiter commits, the round times out and fails, a fresh prepay, it fails again, and at expiry the bond goes
to the maker, erratum E6). The round fails on the first check that fails, and every check is a pure function with a test that hands it
a tampered observation (`e2e/test/checks.test.js`).

| Piece | Here |
|---|---|
| EVM, `StakeAttestation` and its libraries | Real: `hardhat node`, onchain's artifacts, blocks every second so confirmations are waited for |
| Aggregator, keeper selection, reputation | **`MockVerdiktaAggregator` and the bridge** (below) |
| Chainlink node, `ArbiterOperator` | **Absent**: the bridge calls the EA as the job does |
| External Adapter, code runner, forge | Real, from the pin, under `runc`, dev trust with one explicit key |
| AI Node | Real under `next dev`; **its LLM provider is the mock**, scripted per model, every call logged |
| Registry | Real `registry:2`, local: A6a's, plus a sidecar over its storage for this machine's reads |
| IPFS | **A stand-in**: A6a's local IPFS, real CIDv0s |
| Builder, baseline scan, server, indexer, keeper, tool | Real, as a deployment starts them, with a per-run dev builder key |
| Client | The production build; Chromium reads the record and the feed. Its wallet flows are its own Playwright tests |
| Maker | A plain wallet: signs the request, `list`, `fund`, `release` |
| Clock | **Forced** with `evm_increaseTime`: windows are moved past, never slept through |

**What each platform covers.** A report exists only on `linux/amd64`, so on arm64 the runner answers `reportUnavailable` and the EA
abstains. On arm64 the round therefore starts the runner through A6a's launcher (`dev-report-runner.js`), which names the class
platform to the runner's own `buildReport`, and says so in its log. CI sets `SA_E2E_REQUIRE_CLASS_PLATFORM=1`, which fails anywhere else, so
the launcher cannot stand in there.

| | arm64 (a Mac) | linux/amd64 (CI) |
|---|---|---|
| Forge, gates, integrity checks, pack, pull by digest, builder, listing check, EA, AI Node, chain, server, keeper, client, tool | Yes, on the image's arm64 variant | Yes |
| The runner's real report path, `src/index.js` as its entry point | No: the launcher | Yes |
| `linux/amd64` forge, so the report hash a production arbiter gives | No | Yes |
| The builder's single-platform build | No: an index, listed under `devOnly` in its report | Yes |
| gVisor | No | No: `code-runner.yml` |

**The docker CLI.** The builder here gets an empty `DOCKER_CONFIG`: the registry is local and open, and an operator's config can name a
credential helper, which on a locked keychain waits for ever before a push reaches the registry.

### Moving the arbiter pin

Three files name one verdikta-arbiter commit: `builder/action/pins.json` (the runner the reusable workflow starts),
`builder/test/docker/code-runner.pin.json` (P3a's Docker tests) and `e2e/arbiter.pin.json` (this round). `builder/test/unit/pins.test.js` fails if they
differ, or if a fourth file names a commit of its own. None of them follows the branch. To move it:

1. Choose a commit on the arbiter's `claude/stake-attestation` branch. It must have node A2c and A3c, which `e2e/test/grammar.test.js` checks by calling them.
2. Put the whole commit in all three files, in one change.
3. Run `cd builder && npm test`, `cd builder && npm run test:docker` and `cd e2e && npm test`: all three, and a green `builder-docker` and `e2e` on CI. `e2e/test/requestSize.test.js` holds
   `shared/src/listingRequestSize.js` to the code at the pin: if a number moved, update that copy. The round shows whether a new honesty flag changed what the fixture settles as.

**It must move before launch to whatever arbiter commit the canaries run.** The site's listing check and the arbiters must hold listings to one rule, and nothing can check that from here: a runner's
version is `0.1.0` at every commit so far, so nothing it answers names its commit. The builder's own check is a floor (a shell in front of a command refused, the image's compilers read), not a commit. A site's runner (`runner.url` in its `builder.json`) is its operator's to keep at that commit.

A pin costs what the runner needs: the round warms the Semgrep image a claim's scan needs before its runner starts, because `/health` is 503 without it. It is the image the baseline scan pulls (a test holds the two digests equal), so that pull of about 1.6 GB moves
to the round's `prepare` stage and is not a second one. The `builder-docker` job already pulled it for its scan test, and a maker's run of the reusable workflow does not pull it at all.

### The mock bridge

`e2e/src/bridge.js` stands where the real network stands, and `e2e/src/aggregatorRound.js` is `ReputationAggregator.fulfill`,
`_finalizeAggregation` and the settlement arithmetic, off-chain (verdikta-dispatcher at the commit in
`e2e/test/fixtures/aggregator-lib.vectors.json`, whose answers came from the real `AggregatorLib`). For each request on the mock it runs K = 6
jobs with the body of `chainlink-node/basicJobSpec`, reads only what the job reads, keeps the first M = 4 commits, asks those for their
reveal as 32 lowercase hex, verifies each against its commitment, takes the first N = 3, clusters P = 2, floors their mean, comma-joins
their CIDs, works out what the oracles spent, and gives that to the mock at the N-th reveal, as the real contract finalizes inside it, whatever jobs
are still out. Those that land afterwards revert, as on the real contract. A round that fails stays open at the mock.

| The real aggregator | The mock and the bridge | Who proves it |
|---|---|---|
| `selectOracles`: class, fee, reputation, entropy. It can revert | No selection. The bridge refuses a class other than `code-standard` | Dispatcher S1 and `keeper.test.js`; **G2**, a real selection on class 5555 |
| A refused request leaves `RoundFailed`, the bond back if every attempt was refused | Reachable with `setPaused`, not in this round | `StakeAttestation.claims` tests |
| The keeper's selection and K dispatches inside exactly `SUBMISSION_GAS` | `setRequestGasCost(3M)`, a stand-in | **G2** measures it |
| Base fee to K payees at request, bonus at finalize, refund = received − base − bonus | The same refund, computed here and set on the mock before it settles. Each oracle's fee is taken as the ceiling | `aggregatorRound.test.js`; `aggregatorEth.test.js` for the real one; **G2** reads the real fee |
| A slot whose dispatch reverts is an uncredited no-show | All K dispatch | A larger refund, which the contract takes (`setRefundAmount` tests) |
| An oracle inactive at finalize stays out of the sum and earns no bonus, though its CID stays in the list | Every oracle stays active | Dispatcher tests; the contract reads a vector and a string either way |
| OracleRequest, Chainlink job, EA, `fulfillOracleRequestV`, `fulfill`: `gasLimit 6,000,000`, 2 confirmations | The bridge calls the EA with the job's body, up to the job's 840 s | **G2**: the real job and `ArbiterOperator` |
| **The callback's gas.** The N-th reveal's `fulfill` runs `_finalizeAggregation` with keeper score updates. Out of gas there, the round waits for the timeout | `scriptResult` always fits | **G2**: the N-th `fulfill` under 6M. The contract's side of a late result: `scriptLateResult` tests |
| **Timing.** One window from the request (900 s after G2's `setResponseTimeout`), commit and reveal shared; 3 to 6 minutes a round | The same window and rule on Hardhat's clock; a round takes seconds | **G2**: a cold cache, real jurors, §11's budget |
| **The failed round (E6).** `finalizeEvaluationTimeout`: commit phase, reveal phase, or enough responses after all | The same to a requester: `isComplete`, `failed`, the refund. Its phase is always "commit"; the late branch needs `scriptLateResult` | This round, commit phase; contract tests the rest; `aggregatorEth.test.js` the real one |
| `getAggregationStatus`: real counts | Canned 1s. `StakeAttestation` reads only `isComplete`, and nothing else here reads it | Nothing depends on it |
| While a round is open, `getEvaluation` answers a zero-filled scratch vector once a reveal has arrived, with `exists` false | An empty vector, with `exists` false | `_poll` reads the vector only when `exists` is true |
| **`finalize` of a timed-out round** pays K score updates inside `finalizeEvaluationTimeout`, under `StakeAttestation`'s try/catch. Out of gas there is caught, and `finalize` then reverts "evaluation not ready" | Costs almost nothing | **G2**: the keeper's and the tool's gas estimate for a real timed-out round |
| Reputation scores, penalties, entropy, `recordUsedOracles` | None | Dispatcher tests; not visible to a requester. §12's −20: **G2** |

The same on both: the input limits, fund-from-credit, the request id, poll-only, the pull ledger, no `receive`, pause gating requests only.

### What G2 must prove

What this round cannot, because the real thing is not in it:

- A real selection on class 5555 at `code-standard`'s fee, inside `SUBMISSION_GAS`.
- The real Chainlink job and `ArbiterOperator`: the job's timeout, confirmations, the N-th `fulfill` under 6M gas.
- `finalize` of a really timed-out round: the keeper's and the tool's gas estimates, with K score updates under the try/catch.
- `setResponseTimeout(900)` on the real aggregator, and a real round inside it.
- An identical report hash across hosts: several operators, and real clustering of real disagreement. One EA and scripted jurors say nothing about it.
- gVisor in the same round; the AI Node's production build; real jurors with real latency.
- Real pinning and gateways.
- The −20 timeliness penalty on real abstaining operators (§12), and a real re-trigger.
- The production builder key (C6), once it exists.

## CI

`.github/workflows/stake-attestation.yml` runs on pull requests into `main` and
`claude/stake-attestation` that touch this folder or the two workflows. It installs
each package with `npm ci --ignore-scripts`, runs its tests, the Hardhat tests,
the contract sizer, the coverage gate (a job of its own), the client's Playwright
tests against local Hardhat and the server, the builder's Docker tests (a job of its own, with
registry:2 and the pinned code-runner under runc, and gVisor for the real Semgrep's answer), the banned-words check and actionlint
(1.7.12, checksum pinned) over it and the reusable builder workflow, the local round (a job of its own,
on linux/amd64), and uses no secrets. A new
package is added to the workflow and to `shared/test/repo/helpers.js` together;
the workflow test fails until both list it.
