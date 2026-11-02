# The project's proof

**The project decides who may stake on it** (owner decision Q34). Every listing needs the project's
proof, with no allowlist and no exception, Verdikta included:

- a repository listing: a file at the listed commit naming the listing's maker, on one of the
  repository's own branches or tags;
- a contract listing: that file, and also a signature from the deployment's deployer or current owner.

The builder and the server's listing flow refuse a listing without it, by a named code (below), and
nothing is signed or issued. A sponsor can stake only if the project names its wallet in the file. The
record states the fact in words that hold for a sponsor:

- a repository listing: **staker named by the repository: yes / no**
- a contract listing: that, and **staker controls the deployment: yes / no**

The fact is about this listing's staker and nothing else: it says nothing about the code.

**This protects a project's name and record, not its code.** Anyone can still stake on a fork or a
copy, under their own name and on their own record, and read findings that also apply upstream. A
fork is labelled on its record where the host's API says so; a plain copy cannot be detected.

## What counts

`list()` stays open to anyone: the contract does not read a repository. So the site decides what it
shows. The record, the feed, the badge and the labels count only a listing with a valid builder
signature and the project's proof. Any other listing of the hash shows apart, as not counted, with
why and no amount, and never adds to the stake shown; the site offers no commit on it. On the API:
`GET /api/records/:hash` answers `record` for what counts and `notCounted` for the rest; `GET /api/feed`
answers `listings` and `notCounted`; `GET /api/feed/events` is the chain's events, each with `counted`.

A listing counts when, in this order:

| Reason it does not | |
|---|---|
| `ARCHIVE_UNAVAILABLE`, `ARCHIVE_TOO_LARGE`, `ARCHIVE_NOT_CID` | its listing or dispute archive could not be read |
| `ARCHIVE_INVALID` | not an archive arbiters would judge: no panel of common's for its role, another query or outcomes, no primary file, an invalid baseline. The signature covers the spec, the baseline and the known issues, so a repackaged archive still carries a good one |
| `NOT_SIGNED_BY_BUILDER` | an archive's attestation does not verify under the builder keys this site accepts (`@verdikta/common`'s trusted-builder set; under dev trust, only keys this site's own signing step made) |
| `ARCHIVE_MISMATCH` | the two archives are not this listing's: another artifact, disclosure key or terms on-chain, other signed files in the dispute archive, or one archive in the other's place |
| the proof's reasons, below | the on-chain maker is not the one the repository names, or a contract has no signature |

The hunter tool reuses this: `@verdikta/stake-attestation-shared/builder-signature` exports
`didBuilderSign` and `readSignedListing`, and `.../listing-warning` the warning every listing page
carries (who reads a proof first, and that the code may exist elsewhere).

## Refusals

The builder and the server use the same codes. Each is a refusal: nothing is built, signed or pinned.

| Code | Why |
|---|---|
| `MAKER_REQUIRED`, `MAKER_INVALID` | the request names no maker, or something that is no address |
| `MAKER_SIGNATURE_REQUIRED`, `MAKER_SIGNATURE_INVALID` | the maker's wallet did not sign the request (server) |
| `REPO_URL_FORM`, `REPO_HOST_NOT_CHECKED` | a repository URL the site does not read |
| `REPO_TOO_LARGE` | reading the repository took more than the limit |
| `COMMIT_NOT_ON_OWN_REFS` | the commit is on none of the repository's own branches or tags |
| `NO_PROOF_FILE`, `PROOF_FILE_INVALID`, `PROOF_NAMES_ANOTHER_ADDRESS` | no file, not the format, or another address |
| `NO_SIGNATURE`, `SIGNATURE_INVALID`, `SIGNER_NOT_CONTROLLER`, `NO_CONTRACT_AT_ADDRESS`, `CHAIN_NOT_CHECKED` | a contract listing's signature |

A git host or a chain that cannot be read is an error to retry, not a refusal (`REPO_UNAVAILABLE`,
`CHAIN_UNAVAILABLE`), and never an acceptance. `GET /api/status` counts refused attempts by reason
(`listings.refused`), with no address or repository name; they live beside the site's state.

## Who signs the listing request

The maker's wallet signs every listing request (`POST /api/listings/challenge`, then `POST
/api/listings` with `auth`), and the signature is of that request. Otherwise anyone could get an archive
signed, with a disclosure key of their own, by naming a project's address as the maker, and read what
hunters send it. Only ECDSA signatures of externally owned accounts are checked: a project whose treasury
is a multisig names an externally owned wallet in its file.

## Replay: a signed archive listed from another wallet

`list()` takes any CIDs from any wallet, and arbiters read only the archive, so a signed archive can be
listed from a wallet the file does not name, and arbiters would judge claims on that listing: nothing
in the signed files names the maker (`code_review.json` allows no such field), and neither the request
nor the addendum tells an arbiter who listed. Closing that needs `@verdikta/common` (the maker in the
signed statement), the contract's addendum and the External Adapter's gate. What holds today:

- the replay does not count: its on-chain maker is not the address the file names, so it shows apart, adds
  nothing to the project's stake, feed, badge or labels, and the site offers no commit on it;
- the replayer cannot read a finding: the arbiters' disclosure gate checks against the archive's key, so a
  claim they would judge is encrypted to the project's key, and the replayer does not hold it;
- a replay naming another key on-chain would cost a hunter who encrypts to that key the bond at the gate,
  so a hunter's tool must compare the two (`didBuilderSign`); the site does (`ARCHIVE_MISMATCH`).

## A repository listing: a file at the listed commit

The commit you list holds this file, as a regular file (not a symlink or a submodule), UTF-8, at most
4,096 bytes:

```
.verdikta/stake-control.json
```

```json
{ "version": 1, "maker": "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4" }
```

- `maker` is the wallet that calls `list()`, one address: the project's, or a sponsor's it names. It is
  an EIP-55 checksummed or all-lowercase `0x` address, and it is compared in checksummed form. A mixed
  case whose checksum fails, every letter in uppercase, no `0x`, ICAP, a list or anything else names
  nobody, and so does a file with other keys or another version.
- A commit cannot change, so add the file before you list. A file added later needs a new version
  listed, and another sponsor needs a new commit.
- The commit must be on one of the repository's own branches or tags, not only reachable by its id.

### Why the commit has to be on a branch or tag

A git host serves a commit by its id without asking what holds it. On GitHub a fork shares the
parent's object store, so `git fetch https://github.com/<parent>/<name> <id>` returns a commit a
stranger made on their fork (an imposter commit), with a file naming the stranger, and the host also
advertises it under `refs/pull/<n>/head`. Only `refs/heads/*` and `refs/tags/*` say what the
repository's writers put there, so a commit counts only if one of them contains it, and the site
fetches no other ref. The builder refuses any other commit (`COMMIT_NOT_ON_OWN_REFS`), and the check
runs again for every listing on-chain: `commitOnOwnRefs` on the record says the answer.

### Which repositories are read

The site reads only a plain `https://<host>/<owner>/<name>` URL (optionally ending in `.git`), in
ASCII, on a host of `SA_CONTROL_GIT_HOSTS` (by default github.com, gitlab.com, codeberg.org,
bitbucket.org): no credentials, port, query, escape or dot segment. It fetches the URL's `.git` form and
follows no redirect. A listing on anything else is refused. The record shows the URL exactly as listed: `https://github.com/acme-vault/vault`
is not `https://github.com/acme/vault`, and "yes" on one says nothing about the other.

### Check it yourself

```bash
git clone --bare --filter=tree:0 <repo> check.git
git -C check.git for-each-ref --contains <commit> refs/heads refs/tags   # any line: its own ref holds it
git -C check.git show <commit>:.verdikta/stake-control.json              # names the listing's maker
```

The record page prints these with the listing's values.

## A contract listing: a signature from the deployer or the current owner

A repository file alone does not do for a contract: a stranger's copy of a contract can be verified
against someone's repository, and what the listing stakes on is the deployment. So a contract listing
needs both, and the record states them on two lines. The signature goes with the listing request
(`deploymentProof`), and the builder and the server each check it on the listing's chain; the record
page takes a new one later, when an owner changes.

Who signs:

- **the current owner**: the address `owner()` answers on the listing's chain. It can be a contract,
  which then answers through EIP-1271's `isValidSignature`; or
- **the deployer**: the sender of the transaction that created the contract, given by its hash
  (`creationTx`), whose receipt's `contractAddress` is the deployment. A contract made through a
  factory has no such transaction, and is proved by its owner.

What is signed, with EIP-191 `personal_sign` (the record states the exact text for each listing, under
`control.<id>.deployment.message`; ASCII, one field per line, joined with `\n`, no final newline):

```
Verdikta stake attestation: control of a deployment
The signer controls the deployment below and names the maker as its staker. This is not a transaction: it costs nothing and moves no funds.

Version: 1
Maker: <the listing's maker, EIP-55>
Artifact Hash: <the record's artifact hash, 0x and lowercase hex>
Chain Id: <the deployment's chain id>
Contract: <the deployment's address, EIP-55>
Stake Chain Id: <the chain this site lists on>
Stake Contract: <its StakeAttestation address, EIP-55>
```

The artifact hash covers the repository, the commit, the chain and the address, so a new version needs
a new signature. A signature for another maker, artifact, chain or StakeAttestation deployment is
another message and does not verify. A later listing of the same hash by the same maker keeps the fact:
the signer named that maker for that artifact.

Make it in the listing form (sign with the connected wallet, or paste a signature made elsewhere; `POST
/api/listings/deployment-message { maker, repo, baseCommit, chainId, address }` states the message), or
later from the record page, or:

```
POST /api/records/<artifact hash>/listings/<listing id>/control-proof
{ "signer": "0x…", "signature": "0x…", "creationTx": "0x…" }     creationTx: a deployer only
```

Anyone may send it, since it speaks for itself; it is stored only if it counts, and a refused one never
takes away one on file. 200 `{ control }` the listing's fact; 400 a malformed field; 404 no such listing
of the hash; 409 not a contract listing; 422 it does not count (`error`: `SIGNATURE_INVALID`,
`SIGNER_NOT_CONTROLLER`, `NO_CONTRACT_AT_ADDRESS`); 429 too many being checked; 503 the listing's chain
cannot be read (`CHAIN_NOT_CHECKED`, `CHAIN_UNAVAILABLE`).

The listing's chain is read with the site's own RPC when it is the chain the site lists on, otherwise
with `SA_CONTROL_RPC_URL_<chain id>`; with neither, the fact is "no".

### Check it yourself

The record shows the signer, its role, the signature, the creation transaction and the block it was
read at. Save the message as `message.txt`, then:

```bash
cast wallet verify --address <signer> "$(cat message.txt)" <signature>
cast call <contract> "owner()(address)" --block <block> --rpc-url <chain's RPC>     # the owner, or:
cast tx <creationTx> from --rpc-url <chain's RPC>                                   # the deployer
cast receipt <creationTx> contractAddress --rpc-url <chain's RPC>
```

For a contract signer: `cast call <signer> "isValidSignature(bytes32,bytes)(bytes4)" $(cast hash-message "$(cat message.txt)") <signature>`
answers `0x1626ba7e`.

## How it stays current

The checks run beside the indexer and the keeper, never inside them: one run at a time, a few checks a
run, each bounded (`SA_CONTROL_CHECK_TIMEOUT_MS`, `SA_CONTROL_CHECK_MAX_BYTES`,
`SA_CONTROL_RPC_TIMEOUT_MS`). A check that gets no answer tries again, the wait doubling from
`SA_CONTROL_RETRY_MS` up to 6 hours; the last answer stands meanwhile, and says so, for at most 7 days,
so a host down for an hour drops no honest listing. A listing never answered is not counted yet. A live
listing is checked again every `SA_CONTROL_RECHECK_MS` (a day by default), because a branch can be
deleted and an owner can change: an answer that says otherwise takes the listing out of what counts at
the next check. A former owner's signature stops counting then, and a deployer's stays.

## The fork label

The record says what the host's API says of the repository: a fork and of what, not a fork, or unknown.
GitHub's `fork` and `parent`, GitLab's `forked_from_project`, Codeberg's `fork` and `parent`, Bitbucket's
`parent`. It is asked beside the indexer (`SA_CONTROL_FORK_TIMEOUT_MS`, a few a run), again after a day,
and an unknown answer sooner. `SA_GITHUB_TOKEN`, from the environment and optional, only raises GitHub's
rate limit, and goes nowhere else. A plain copy pushed to a new repository is no fork to any host and
cannot be detected, and the record says so.
