# Production signing with the KMS key

The production builder key stays in AWS KMS, usable only by the builder's signing job (owner decisions Q5
and Q47). This page says how the reusable workflows use it, what can reach it, and what the owner sets up at
gate G1. Public here: the key's public half and id (`builder/action/pins.json`). Never in this repository: the
account id, the region, the alias, the key's ARN, the role's ARN.

## This key is testnet-only

The owner accepted this on 2026-11-05. Once required reviewers are off, anyone who passes the site's gates gets a
production signature from this key, with no person in the loop. An attestation names no chain and no deployment, and
`list()` takes any CIDs, so a signature made on testnet is just as valid on mainnet wherever this key is trusted.
Retiring the key wouldn't help: `@verdikta/common` keeps a retired key valid for anything issued before its
`retiredAt`. So mainnet gets a new key, in a `@verdikta/common` release that does not hold this one. Until then,
nothing stops an unattended testnet signature from counting on a mainnet that trusts this key: the rule is the
owner's, and a release has to carry it out. The server refuses this route on Base mainnet (`SA_CHAIN_ID=8453`), so a site
can't start signing there by accident; that says nothing about a signature made on testnet.

The owner also accepted the container boundary for testnet:

- **What it is.** A maker's `commands.setup` runs as root in a `docker build`, with network, under the daemon's
  default container runtime (predicted: runc). gVisor is not around it: the workflow registers `runsc` as a named
  runtime, and `docker build` doesn't use it. The builder, the code-runner and the job's outputs are on the same
  machine.
- **What an escape gets.** Someone who breaks out of that container, with a kernel or runtime exploit, owns the build
  job's machine and can write its report, its files and its digest. The sign job can't tell: the listing check's
  results, a contract's verified-source match and the unpacked size are recorded as trusted
  (`builder/src/verifyBuild.js`). With reviewers off, that forged validation gets a real signature.
- **What it doesn't get.** The key: that machine has no OIDC token to ask with. The project's proof and the terms the
  maker's wallet signed are checked again on the sign job's own machine, so an escape can't change who the listing is
  for or what it promises. And an image the maker built is the maker's anyway, escape or no escape.
- **Why it's accepted here.** A forged testnet listing costs no real money, as long as this key never counts on
  mainnet.
- **What closes it.** Node P15b, on the before-mainnet list: `docker build` on a machine of its own that hands on only
  the image bytes, and everything measured and reported on a clean machine where the maker's code runs only under
  gVisor.

## How a signature is made

`stake-attestation-builder.yml` builds and publishes, with no cloud identity and no secret. With `signing:
production` it stops there, and the caller's next job calls `stake-attestation-builder-sign.yml`:

1. The first step, before any checkout, refuses a trigger other than `workflow_dispatch`, an `outputs-sha256` that isn't a digest (the builder workflow hands one on only with
   `signing: production`, whose checks the listing then passed), empty references, a job with no OIDC token, and a
   `builder-ref` that isn't the commit the workflow is called at.
2. `site-request.js check` recovers the maker's wallet from the signed request, and refuses unless it signed these
   exact bytes and the built `code_review.json` and known issues keep every term it signed. Then
   `services.js sign-config` writes the builder's `{ command, publicKey, env }` config, with `command` set to
   `builder/action/kms-sign.js` and `publicKey` to the pin. It refuses while `@verdikta/common`'s trusted set
   doesn't hold the pin; so does the build job's start, with `signing: production`, before anything is published.
3. `verdikta-build-env sign` checks the build's outputs, the published image and the project's proof, then checks
   the key against common's set again, and only then asks the signer.
4. `kms-sign.js` refuses anything above KMS's 4,096-byte limit for a RAW message. It asks the runner for an OIDC
   token for `sts.amazonaws.com` and runs `aws kms sign --message-type RAW --signing-algorithm ED25519_SHA_512`,
   with a role to assume and nothing else of the job's in its environment. The aws command line is the runner
   image's, and no third-party action is involved. The session, the token and the message live in one
   private folder, which is removed when it exits.
5. The builder verifies the signature against the pinned public key, then runs common's own production
   verification over the whole attestation. A failure at either writes nothing, and the upload step runs only
   after this one passed.

## What can reach the key

`kms:Sign` is a signing oracle, so the question is who can ask for a signature.

| Who | What stops it | What that relies on |
|---|---|---|
| A maker's caller | AWS refuses its identity: `sub`, `repository_id` and `ref` name Verdikta's caller. It also holds no references, so the first step refuses it, and a KMS key of its own fails against the pinned public key. | The trust policy below |
| A fork of the caller, or of this repository | The same conditions name the repository, and `job_workflow_ref` names this repository's file | The trust policy below |
| A pull request from a fork, to the caller | GitHub gives it no OIDC token. The environment's branch rule also refuses it, and the first step refuses the trigger | GitHub's fork rule; the environment's settings |
| `pull_request_target`, `issue_comment`, `workflow_run` or `repository_dispatch` in the caller | The first step refuses the trigger. They run on the default branch, so the environment's branch rule would not stop them, and required reviewers are what's left | Commit pin, so the first step is what runs |
| `build` or `publish` of the builder workflow (the maker's setup runs in `build`) | No `id-token` permission, no environment, a separate machine. `build` has `permissions: {}` | GitHub's job isolation |
| A holder of the server's Actions token | It can start a run with any request, but not name a wallet it doesn't hold: the sign job checks the wallet's signature. With reviewers on, a person stands there too | The wallet check; the project's proof |
| Another job or workflow in the caller's repository | Its `job_workflow_ref` differs. Without the environment its `sub` differs too | The trust policy below |
| A caller's bad `builder-ref` | The first step reads the commit from the job's OIDC claims and refuses a different one | Commit pin, so the first step is what runs |
| A commit pushed to a fork of this repository (GitHub resolves such a commit through this repository's name) | `job_workflow_ref` must equal the one commit the owner reviewed | The trust policy below |
| Code in the sign job | Only pinned code runs: the builder at the pinned commit, its locked dependencies with no lifecycle scripts, four GitHub actions pinned by commit, and the runner image's `aws`. Git and registry reads get an environment without the runner's token | Those pins; GitHub's image. The job does read a maker's repository and image through git and HTTP, as the PEM route's job did |
| Anyone with write access to the caller | The environment's required reviewers. Changing the caller means a pull request to its protected branch | The environment and branch settings: enforced by GitHub, not AWS |
| An AWS principal other than this role | The key policy and an access review | The owner's check, step 3 below |

Enforced by code here, and tested without a cloud: the first step, the job's permissions, the signer's refusal and
its flags, the signature and trust checks, the log filter. Predicted from GitHub's and AWS's documents, and proved
only by the first real run: that GitHub refuses a fork's token, that AWS applies the trust conditions, that the
claims look as written here, and that the runner's `aws` signs with these flags.

## How the site gets a listing signed

The server can't sign: a signature needs a GitHub runner's OIDC token. So with `SA_BUILD_BACKEND=workflow` it starts a
run of Verdikta's caller, follows it, and collects what it signed. The caller is
`builder/caller/stake-attestation-site-build.yml`, which the owner copies (below).

1. The maker's wallet signs the request. The server checks that, the limits below, and the project's proof. Only then
   does it send a `workflow_dispatch`, to one file, on `main`.
2. `source` runs nothing of the maker's. It checks the wallet's signature and writes the request as files, at fixed
   names, for the build. `build` runs the maker's setup. `publish` pushes the image. `sign` checks the signature again,
   then the build, then signs.
3. The server downloads `site-listing-signed` and checks it as it checks any build, then verifies both archives under
   `@verdikta/common`'s production set. An archive that fails is refused, and nothing is pinned or offered. That can't
   undo a signature already made: the run's artifact stays, for anyone who can read the run.

| The run | The listing's job |
|---|---|
| queued or running | `building`, with `run.url` |
| waiting for a required reviewer | `awaiting_approval`: visible, not a failure, holding no slot |
| running again, once approved | `signing` |
| succeeded, and the archives verify | `scanning`, `pinning`, `ready` |
| succeeded, and an archive doesn't verify | `error`, `ARCHIVE_INVALID` |
| the builder refused the listing | `refused`, with the report's codes |
| a reviewer declined | `refused`, `SIGNING_DECLINED` |
| the builder errored | `error`, with its code |
| the build passed and a later job failed | `error`, `PUBLISH_OR_SIGN_FAILED` |
| ended otherwise, with no report | `error`, `RUN_<CONCLUSION>` |
| never appeared, or was deleted | `error`, `RUN_NOT_FOUND`, `RUN_LOST` |
| past a deadline | `error`, `RUN_DEADLINE`, `APPROVAL_DEADLINE` |

The baseline scan stays on the server: its findings are the maker's alone, and the run's logs can be public. A server
with no builder config says the scan errored, and the listing goes on.

**Deadlines and slots.** A slot is held only while a run uses a runner. A run's time not waiting for a person has a
deadline of 3 h, against job limits that add up to 145 min, and is cancelled at it. A run waiting for a person holds no
slot, and at most 8 can wait before no new one starts. If nobody answers in 72 h, the run is cancelled, nothing is
signed, and the maker has to submit again: that counts as another build, and the image it published stays. GitHub's own
limit on that wait is longer (predicted: 30 days). So at most 8 listings can wait at once, and a stranger able to fill
those places with git-host accounts stops new builds until a reviewer clears them or 72 h pass. That place is only
reachable with reviewers on.

**A lost run or a restart.** Jobs live in memory, so a restart abandons what it started. A sweep, at start and every 5
min, cancels any active run under this site's prefix that no live build owns, and forces the cancel after two tries.
This also covers a run that appeared late and a dispatch whose answer was lost. A person's test by hand, under another
name, is left alone. A restart gives nothing back: the attempts stay charged, and the counts live in `build-budget.json`.

**The limits.** Enforced and tested:

| Limit (default) | Charged | Several wallets? |
|---|---|---|
| A wallet: 3 attempts in 24 h, and one in flight | once the wallet has signed; a refused proof still costs its wallet the attempt | gets round it |
| A repository's owner on its git host: 5 builds in 24 h, and one in flight | once the proof stands | doesn't get round it; several git-host accounts do |
| Everyone: 20 builds in 24 h | at the request, given back if no run starts | nothing gets round it |

One slot and those limits bound the spend at about 29 job-hours a day: at most 24 h of `source`, `build` and `publish`,
and 20 × 15 min of `sign`. A public repository's standard runners bill no minutes (predicted), so what's at risk is the
org's concurrency and GitHub's terms, not an invoice.

**This does not stop a stranger.** A wallet costs nothing, a proof file costs a commit, and a git-host account costs an
email and a captcha. Someone with several wallets and git-host accounts can use the whole budget every day, and other
makers then wait for the next window. Requests with bad proofs from fresh wallets run no build and cost no budget, but
they can keep the queue full, each for up to the 2 min a proof check may take. What would stop them is a paid gate (a fee or deposit before the build), an
allowlist of makers, or a person approving before the build. None is built here.

**Inputs.** A dispatch's only inputs are the correlation id, the request and the wallet's signature as base64, the
maker's address, and a chain id. A step takes them through its `env`, never `${{ }}` inside `run` (pinned by a test).
The workflow files, the commit, the environment and where the image goes are written in the caller. A request over
what a dispatch can carry is refused at the challenge, as `DISPATCH_REQUEST_TOO_LARGE`. An explorer comes from a
repository variable, chosen by chain, so no input names one.

**Where the image goes.** A listing's image goes to `ghcr.io/verdikta/stake-env`, pushed by the builder workflow (owner
decision Q42 (a)), and arbiters' default allowlist stays as it is. **A stranger's image lands there before any review**,
reviewers or not, because `publish` runs before `sign`. No arbiter pulls it without a signed listing, but Verdikta does
host a stranger's bytes under its own name, up to the limits. That is an abuse and terms risk, and only watching it and
the IPFS route the owner wants before mainnet address it.

**What the build job holds.** `permissions: {}`, so the job's GitHub token has no scope, and nothing hands it on. No OIDC:
GitHub sets no token endpoint without `id-token: write`. No `packages: write`: that is `publish`'s alone. No secret. The
maker's setup runs in a container with none of the runner's environment. The runner itself holds a runtime token for
uploading artifacts, which is out of a container's reach and within an escape's: it could add artifacts to that run or
write a cache for `main`. Neither `publish` nor `sign` restores a cache (tested), and neither runs anything from an
artifact, so what reaches them from `build` is data: the outputs and the folder the sign job checks. A step's output is
filtered, so a maker's text can't be a workflow command.

**What the token can do.** The server's token has Actions read and write on the one caller repository.
**It can start or cancel any workflow in that repository, on any branch or tag it holds.** It can also re-run a run, enable
or disable a workflow, and delete runs, logs, artifacts and caches, and it can read every run's logs and artifacts. It can't
read secrets, variables or contents, or change a workflow file. So the repository holds this workflow and nothing else,
and nothing in its logs is secret.

A stolen token gets what a stranger gets, without the site's limits: a build of a repository that names a wallet the
thief holds. It can't get a signature naming a wallet it doesn't hold, since the source and sign jobs check that
signature. It can replay a request it has seen, which builds and signs again what that wallet already asked for. And it
can spend minutes, cancel runs, and delete GitHub's record of them. CloudTrail keeps the record of each `Sign`.

## With reviewers off

The owner decided (Q51, testnet only): keep required reviewers on for the first real signed listing, then drop them
before outside makers can list. Mainnet stays the owner's to decide. The switch is a GitHub setting, and no code or
config changes with it.

**What's lost.** With reviewers off, no person is in the loop: anyone who passes the site's gates gets a production
signature on their build, within the limits above. Nobody looks at a setup, an image or a report before it is signed.

**What protects the key then, and what each thing doesn't stop:**

| Control | What it stops | What it doesn't stop |
|---|---|---|
| The key in KMS, usable only through this role | The key leaving, or anything else using it | A signature the sign job asks for. CloudTrail records one; it doesn't prevent it |
| AWS trust policy | Any other repository, fork, environment or workflow, and the sign file at any other commit | A run of the caller on `main`, with any request |
| The environment's branch rule, and the protected `main` | A run from another branch; a changed caller without a reviewed pull request | A dispatch from `main`. Anyone with write access to the caller who can merge a change |
| The sign job's first step | Another trigger; a `builder-ref` that isn't its own commit; a missing digest | A dispatch |
| The wallet check, in `source` and `sign` | A token holder naming a wallet it doesn't hold; a build that changed a term the wallet signed | A stranger with their own wallet; a replay of a request already signed |
| The project's proof, read again in `sign` | A listing of a repository that doesn't name the maker, or a commit not on its own refs | A stranger's own repository, fork or copy, listed under their own name |
| The sign job's checks of the build (`verifyBuild.js`) | A folder that isn't the build's, or an image that isn't published, from the pinned base and labelled with the commit | A setup that rigs its own image, which the design allows. Forged results after a container escape, accepted above |
| The site's gates and limits | Unsigned requests; one wallet or one git-host account running on | Several wallets and git-host accounts using the whole budget. A token holder, for whom they don't apply |
| The server's verification at the end | Offering an archive that fails `@verdikta/common`'s production set | A signature already made: it stays in the run's artifact |

**The owner's step, after the first real signed listing passes:** in the caller's settings, under Environments,
`stake-attestation-signing`, turn off required reviewers. Keep the deployment branch rule, and the protected `main`.
To put them back, turn them on again: the site then shows `awaiting_approval` as before.

## Why OIDC, and why these are secrets

The job authenticates by GitHub OIDC, so no long-lived AWS key exists. The verdikta-agents pattern (an IAM key pair
in a secret) would work with the same signer, and would leave a credential that works from anywhere until someone
revokes it.

The references are GitHub secrets, though neither is a credential: GitHub prints a step's `env` in the log, and a
caller's log can be public, so a variable would publish the account id. For the same reason `kms-sign.js` never
repeats what AWS says, whose messages name the account and the key: the log gets the error's class only. CloudTrail
has the rest.

GitHub checks a called job's `id-token` permission against its caller before anything runs, whatever the job's
condition. That is why signing has a file of its own: in the builder workflow, every maker would have to grant
`id-token: write` to call it.

## The owner's steps at G1

Fill in the placeholders in the console, not in this repository. `<commit>` is the commit of this repository the
caller pins; `<caller>` is the Verdikta repository whose workflow calls these two files.

**1. The OIDC provider.** In IAM, add `token.actions.githubusercontent.com` with the audience `sts.amazonaws.com`,
if the account doesn't have it.

**2. The cloud principal: one IAM role, for this job alone.** Its trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "<the subject, below>",
        "token.actions.githubusercontent.com:environment": "stake-attestation-signing",
        "token.actions.githubusercontent.com:repository_id": "<the caller's numeric repository id>",
        "token.actions.githubusercontent.com:ref": "refs/heads/main",
        "token.actions.githubusercontent.com:workflow": "Stake attestation site build",
        "token.actions.githubusercontent.com:job_workflow_ref": "verdikta/verdikta-applications/.github/workflows/stake-attestation-builder-sign.yml@<commit>"
      }
    }
  }]
}
```

The subject takes one of two forms, and IAM requires it (it must also not be only a wildcard):

- A repository created before July 15, 2026, not opted in to immutable subject claims, and not renamed or transferred
  since: `repo:verdikta/<caller>:environment:stake-attestation-signing`.
- Any other repository: `repo:verdikta@<owner-id>/<caller>@<repository-id>:environment:stake-attestation-signing`.

Use the form the caller's repository has. A wrong one denies every signature, and fails safe. The job's first step
prints the `sub` it presents, so a first run tells you which it is.

The caller is Verdikta's and the content is a stranger's, so the policy can only say which job may ask: it has no view of
what's being signed. `workflow` is the caller's `name:`. AWS documents no condition key for `event_name`,
`runner_environment` or `workflow_ref`, and a condition on a key it doesn't have denies every signature. So don't add
them. The first step refuses another trigger, which `job_workflow_ref` pins as the code that runs. `runs-on` is fixed in
the same file, so keep self-hosted runners away from the caller. A new workflow in the caller needs a reviewed change
to `main`.

Its only permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "kms:Sign",
    "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>",
    "Condition": {
      "StringEquals": { "kms:SigningAlgorithm": "ED25519_SHA_512", "kms:MessageType": "RAW" }
    }
  }]
}
```

Nothing else: not `kms:GetPublicKey`, not `kms:DescribeKey`, no wildcard, no other resource. If the first run says
`AccessDenied`, its first step prints the `sub` and `job_workflow_ref` it presented, to compare with the above. The
exact form of a commit in `job_workflow_ref` is one of the predicted items.

**3. Nothing else gets access.** Read the key policy and grants (`aws kms get-key-policy`, `aws kms list-grants`).
Only this role may use `kms:Sign`, and any statement that delegates to IAM must not let another principal reach it.
Key administrators keep what they need to administer it, without `kms:Sign`.

**4. The caller repository,** dedicated to this, public (predicted: required reviewers on a private repository need
GitHub Enterprise; its logs and dispatch inputs are then public, so nothing secret goes there), with `main` protected
by required reviews. On its `main`, the caller and nothing else:

```sh
sed 's/BUILDER_COMMIT/<commit>/g' stake-attestation/builder/caller/stake-attestation-site-build.yml \
  > .github/workflows/stake-attestation-site-build.yml
```

It passes the secrets by name, never `secrets: inherit`, and only `sign` holds `id-token: write`:

```yaml
permissions: {}
jobs:
  listing:
    uses: verdikta/verdikta-applications/.github/workflows/stake-attestation-builder.yml@<commit>
    permissions:
      contents: read
      packages: write
    with:
      builder-ref: <commit>
      site-request: ${{ inputs.request }}
      site-auth: ${{ inputs.auth }}
      maker: ${{ inputs.maker }}
      publish-repository: ghcr.io/verdikta/stake-env
      signing: production
      artifact-name: site
  sign:
    needs: listing
    uses: verdikta/verdikta-applications/.github/workflows/stake-attestation-builder-sign.yml@<commit>
    permissions:
      contents: read
      id-token: write
    with:
      builder-ref: <commit>
      artifact-id: ${{ needs.listing.outputs.artifact-id }}
      outputs-sha256: ${{ needs.listing.outputs.outputs-sha256 }}
      maker: ${{ inputs.maker }}
      publish-repository: ghcr.io/verdikta/stake-env
      site-request: ${{ inputs.request }}
      site-auth: ${{ inputs.auth }}
    secrets:
      VERDIKTA_KMS_KEY_ARN: ${{ secrets.VERDIKTA_KMS_KEY_ARN }}
      VERDIKTA_KMS_ROLE_ARN: ${{ secrets.VERDIKTA_KMS_ROLE_ARN }}
```

Also on that repository: the variable `STAKE_ATTESTATION_EXPLORERS`, a JSON object from chain id to a keyless explorer
API in the Etherscan shape (`{"84532":"https://base-sepolia.blockscout.com/api"}`); no self-hosted runner; artifact
retention longer than the 72 h a run can wait.

**5. The GitHub environment,** `stake-attestation-signing` in the caller: required reviewers (the owner), self-review
prevented, deployment branches limited to `main`, no administrator bypass. It holds two environment secrets,
`VERDIKTA_KMS_KEY_ARN` and `VERDIKTA_KMS_ROLE_ARN`. Required reviewers mean every production signature waits for a
person, until the owner's step under "With reviewers off".

**6. The image and the token.** `ghcr.io/verdikta/stake-env` public, with only the caller given write access. A token
with Actions: read and write on the caller and nothing else, without Deployments, held by an identity that isn't a
required reviewer: `SA_BUILD_WORKFLOW_TOKEN` in the server's environment, with `SA_BUILD_BACKEND=workflow`,
`SA_BUILD_WORKFLOW_REPO=verdikta/<caller>`, and `SA_BUILD_WORKFLOW_SITE` naming this site. Its reach is under "What the
token can do".

The pin: this repository's packages pin `@verdikta/common` `1.9.0-attest.3`, which holds this key, so production signing
is no longer refused as `SIGNING_KEY_NOT_TRUSTED`. `<commit>` has to be at or after that change. The arbiter pins move
separately.

**7. The live check, opt-in.** This one reaches the real KMS, and it's the only code here that does. It signs a
throwaway message under a context of its own, which can't pass for an attestation, and verifies the answer against the
pin, with no AWS code involved. Run it under an identity allowed `kms:Sign`, in CloudShell for instance, before
narrowing the key policy in step 3, or under the role itself:

```sh
cd stake-attestation/builder && npm ci --ignore-scripts
VERDIKTA_KMS_LIVE_CHECK=1 VERDIKTA_KMS_KEY_ARN=<the key's ARN> node action/kms-live-check.js
```

Exit 0 and an `OK` line mean the key signs plain Ed25519 and matches the pin. A `NOTE` line about the trusted set is
expected until step 6. Neither `npm test` nor CI runs this: their `aws` is a stub.

**8. The first real run,** through the site, with required reviewers on: a real listing, its proof and its wallet. It's
the only proof of the OIDC path and of the items marked predicted. Check the site shows `awaiting_approval`, the
attestation says `trust: production` and the key id above, and CloudTrail shows one `Sign`, under the session
`verdikta-builder-sign-<run id>`.

**9. Then, if the owner still wants it,** turn reviewers off: "With reviewers off" above, before outside makers list.

**Moving to a new builder commit** is a reviewed change to the caller and an edit of `job_workflow_ref` in the trust
policy, both at the owner's hand. That is deliberate: it decides what code may sign.
