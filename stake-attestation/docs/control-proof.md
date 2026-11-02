# Proving control of what a listing names

Anyone may stake on any repository: third-party stakes are allowed, and the design's seeding relies
on them (§14). So the record states, per listing, one fact:

- a repository listing: **staker controls the repository: yes / no**
- a contract listing: **staker controls the deployment: yes / no**

"Yes" needs the proof below, checked by the site, and anyone can repeat the check from what the
record shows. "No" covers no proof, a failed check, a git host or chain that could not be read and
a listing the site does not read; the record says which. Nothing refuses a listing for having no
proof. The fact is about this listing's staker and nothing else: it says nothing about the code.

The record API (`GET /api/records/:hash`, field `control`, by listing id), the record page, the feed
and the badge all state it. The site computes it off-chain, so the contract and `@verdikta/common`
are unchanged.

## A repository listing: a file at the listed commit

The commit you list holds this file, as a regular file (not a symlink or a submodule), UTF-8, at most
4,096 bytes:

```
.verdikta/stake-control.json
```

```json
{ "version": 1, "maker": "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4" }
```

- `maker` is the wallet that calls `list()`. It is an EIP-55 checksummed or all-lowercase `0x`
  address. A mixed case whose checksum fails, every letter in uppercase, no `0x`, ICAP or anything
  else names nobody, and so does a file with other keys or another version.
- A commit cannot change, so add the file before you list. A file added later needs a new version
  listed.
- The commit must be on one of the repository's own branches or tags, not only reachable by its id.

### Why the commit has to be on a branch or tag

A git host serves a commit by its id without asking what holds it. On GitHub a fork shares the
parent's object store, so `git fetch https://github.com/<parent>/<name> <id>` returns a commit a
stranger made on their fork (an imposter commit), with a file naming the stranger, and the host also
advertises it under `refs/pull/<n>/head`. Only `refs/heads/*` and `refs/tags/*` say what the
repository's writers put there, so a commit counts only if one of them contains it, and the site
fetches no other ref. The check runs for every listing: `commitOnOwnRefs` on the record says the
answer whether or not a file names the maker.

### Which repositories are read

The site reads only a plain `https://<host>/<owner>/<name>` URL (optionally ending in `.git`), in
ASCII, on a host of `SA_CONTROL_GIT_HOSTS` (by default github.com, gitlab.com, codeberg.org,
bitbucket.org): no credentials, port, query, escape or dot segment. It fetches the URL's `.git` form and
follows no redirect. A listing on anything else is "no". The record shows the URL exactly as listed: `https://github.com/acme-vault/vault`
is not `https://github.com/acme/vault`, and "yes" on one says nothing about the other.

### Check it yourself

```bash
git clone --bare --filter=tree:0 <repo> check.git
git -C check.git for-each-ref --contains <commit> refs/heads refs/tags   # any line: its own ref holds it
git -C check.git show <commit>:.verdikta/stake-control.json              # names the listing's maker
```

The record page prints these with the listing's values.

## A contract listing: a signature from the deployer or the current owner

A repository file alone does not count for a contract: a stranger's copy of a contract can be verified
against someone's repository, and what the listing stakes on is the deployment. The fact there is about
the deployment, so a "yes" does not say the staker controls the repository; the record shows what the
repository file says on a line of its own.

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

Send it from the record page (sign with the connected wallet, or paste a signature made elsewhere), or:

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
`SA_CONTROL_RPC_TIMEOUT_MS`). A failed check leaves "no" and tries again, the wait doubling from
`SA_CONTROL_RETRY_MS` up to 6 hours. A live listing is checked again every `SA_CONTROL_RECHECK_MS` (a
day by default), because a branch can be deleted and an owner can change: a former owner's signature
stops counting at the next check, and a deployer's stays.
