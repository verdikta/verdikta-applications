# Production signing with the KMS key

The production builder key stays in AWS KMS, usable only by the builder's signing job (owner decisions Q5
and Q47). This page says how the reusable workflows use it, what can reach it, and what the owner sets up at
gate G1. Public here: the key's public half and id (`builder/action/pins.json`). Never in this repository: the
account id, the region, the alias, the key's ARN, the role's ARN.

## How a signature is made

`stake-attestation-builder.yml` builds and publishes, with no cloud identity and no secret. With `signing:
production` it stops there, and the caller's next job calls `stake-attestation-builder-sign.yml`:

1. The first step, before any checkout, refuses a trigger other than `workflow_dispatch` or
   `repository_dispatch`, an `outputs-sha256` that isn't a digest (the builder workflow hands one on only with
   `signing: production`, whose checks the listing then passed), empty references, a job with no OIDC token, and a
   `builder-ref` that isn't the commit the workflow is called at.
2. `services.js sign-config` writes the builder's `{ command, publicKey, env }` config, with `command` set to
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
| `pull_request_target`, `issue_comment` or `workflow_run` in the caller | The first step refuses the trigger. They run on the default branch, so the environment's branch rule would not stop them, and required reviewers are what's left | Commit pin, so the first step is what runs |
| `build` or `publish` of the builder workflow (the maker's setup runs in `build`) | No `id-token` permission, no environment, a separate machine | GitHub's job isolation |
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
        "token.actions.githubusercontent.com:sub": "repo:verdikta/<caller>:environment:stake-attestation-signing",
        "token.actions.githubusercontent.com:repository_id": "<the caller's numeric repository id>",
        "token.actions.githubusercontent.com:ref": "refs/heads/main",
        "token.actions.githubusercontent.com:job_workflow_ref": "verdikta/verdikta-applications/.github/workflows/stake-attestation-builder-sign.yml@<commit>"
      }
    }
  }]
}
```

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

**4. The GitHub environment,** `stake-attestation-signing` in `<caller>`: required reviewers (the owner), self-review
prevented, deployment branches limited to `main`, no administrator bypass. It holds two environment secrets,
`VERDIKTA_KMS_KEY_ARN` and `VERDIKTA_KMS_ROLE_ARN`. Protect `main` in `<caller>` with required reviews. Required
reviewers mean every production signature waits for a person. If the site is to sign unattended later, dropping them
is the owner's decision: what then stands in the way is the branch rule, the protected `main` and the trust policy.

**5. The caller,** on `main` of `<caller>`, triggered by `workflow_dispatch` or `repository_dispatch` and nothing
else. Pass the secrets by name; GitHub reads them from the environment. Don't use `secrets: inherit`. The first job has
no cloud identity, and only the second holds `id-token: write`:

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
      spec: <the draft's path>
      maker: <the wallet that will send list()>
      publish-repository: <the repository arbiters pull from>
      signing: production
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
      maker: <the wallet that will send list()>
      publish-repository: <the repository arbiters pull from>
    secrets:
      VERDIKTA_KMS_KEY_ARN: ${{ secrets.VERDIKTA_KMS_KEY_ARN }}
      VERDIKTA_KMS_ROLE_ARN: ${{ secrets.VERDIKTA_KMS_ROLE_ARN }}
```

**6. The common pin.** Production signing stays refused (`SIGNING_KEY_NOT_TRUSTED`) until the builder pins a
`@verdikta/common` release holding this key. That release, `1.9.0-attest.3`, has to be published and the pin moved
first, and `<commit>` has to be a commit with the moved pin.

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

**8. The first real run.** A `workflow_dispatch` of the caller over a test listing is the only proof of the OIDC path.
Check the attestation says `trust: production` and the key id above, and that CloudTrail shows one `Sign`, under the
session `verdikta-builder-sign-<run id>`.

**Moving to a new builder commit** is a reviewed change to the caller and an edit of `job_workflow_ref` in the trust
policy, both at the owner's hand. That is deliberate: it decides what code may sign.
