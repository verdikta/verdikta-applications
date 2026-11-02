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

**Status:** scaffold, plus the contract's listing half, its claim lifecycle and
settlement: finalize by polling the aggregator, the six-outcome rule, payouts,
depletion and owed awards. The packages below build and test; disputes, failed
rounds' re-trigger, late claims, the site's flows and the hunter commands arrive
with the nodes named in the plan.

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
| `server/` | Express API; `GET /health` for now. Port 5009. | `npm test` |
| `client/` | Vite + React site. Port 5176. | `npm test`, `npx playwright test` |
| `tool/` | `verdikta-attest`, the hunter's CLI: `check`, `commit`, `reveal`, `status`, `claim` arrive in P5. | `npm test` |
| `shared/` | Code shared by the packages (the banned-words helper so far) and the app's repository checks. | `npm test` |
| `builder/` | `verdikta-build-env`, the environment builder (P3a): builds and pushes a listing's env image, checks a contract's verified source, validates the listing on the arbiters' code-runner and signs `attestation.json`; the baseline scan, for the maker only (P3b). The reusable workflow that runs it is `.github/workflows/stake-attestation-builder.yml`. | `npm test`, `npm run test:docker` |
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
cd stake-attestation/builder && npm ci && npm test && npm run test:docker
```

`npm run gas` in `onchain/` prints the gas report, `npm run coverage` runs
solidity-coverage, `npm run coverage:check` runs it and fails below 95% line
coverage on any production contract, and `npx hardhat size-contracts` prints
the bytecode sizes and fails above EIP-170's 24 KiB. The Playwright smoke test builds the client and serves it
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

## The environment builder

`builder/` turns a maker's draft `code_review.json` into a listing the arbiters can run (design
§8.2 steps 1–5, §8.8; build plan A4, A6, D4). `verdikta-build-env build --config builder.json
--spec draft.json [--known-issues known_issues.json] --out out/` runs, recording each step in
`out/validation-report.json`, the report the maker reads before funding:

1. **spec**: the draft against `@verdikta/common`'s `validateCodeReviewSpec` (with stand-ins
   for the fields the builder fills) and what the Foundry MVP hosts: `env.from: "foundry"`,
   `commands.framework: "forge"`, `build`, `testFiles` with `$FILES`, `testIds` with
   `$TEST_IDS`; `known_issues.json` when the draft names one.
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
   checked by `validateBaseline`.

Exit status 0 accepted, 2 refused (the report says why, with the build's log when the setup
failed), 1 error. `verdikta-build-env sign --config builder.json --dir out/` then signs
`attestation.json` (`createAttestationStatement` over the exact bytes written, Ed25519) and
records it in the report; `run` does both in one process, with a dev key only.

**What sign checks first.** Signing may run in a job that receives only the build's output folder
(the reusable workflow below), so before any signature exists `sign` checks what it can without
re-running the build (`src/verifyBuild.js`) and refuses on the first failure, writing nothing:
the report accepted the listing; the files are the bytes it accepted; `code_review.json`, the
baseline and `known_issues.json` validate; the report is about this repository, commit and
artifact, records every step of a build (the verified-source match for a contract) and an
accepted listing check; it names the image, platform, base and sizes `code_review.json` names,
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
repository), `known-issues`, `publish-repository` (e.g. `ghcr.io/<owner>/stake-env`, readable
without a credential), `runtime` (`runsc` by default; a production key needs gVisor),
`explorer-api-url` (a keyless Etherscan-shaped API for a contract listing's chain, so the build
job holds no explorer key) and `signing` (`dev` by default, or `production`). Three jobs:

1. **build**, `contents: read` and no secret: checks out the builder and only the draft and the
   known issues of the calling repository (the builder fetches the listed commit itself), blocks
   the runner's metadata addresses from containers, installs common's gVisor release
   (SHA-512-checked; `builder/action/pins.json`, which also pins registry:2, skopeo and the
   code-runner's commit), and starts with `builder/action/services.js` a
   registry:2 on the runner's loopback and the code-runner of verdikta-arbiter at the pinned
   commit with a token made for the run. `build` pushes to that registry with no credential,
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
checkout of that commit's `code-runner/`; otherwise the tests fetch it). The fixture's setup lets
forge download solc (the build's network) and its build command passes only where the sandbox
has no route out, so an accepted listing shows the network was there at setup and nowhere after.
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

## CI

`.github/workflows/stake-attestation.yml` runs on pull requests into `main` and
`claude/stake-attestation` that touch this folder or the two workflows. It installs
each package with `npm ci --ignore-scripts`, runs its tests, the Hardhat tests,
the contract sizer, the coverage gate (a job of its own), the Playwright smoke
test, the builder's Docker tests (a job of its own, with registry:2 and the
pinned code-runner under runc), the banned-words check and actionlint (1.7.12, checksum pinned)
over it and the reusable builder workflow, and uses no secrets. A new
package is added to the workflow and to `shared/test/repo/helpers.js` together;
the workflow test fails until both list it.
