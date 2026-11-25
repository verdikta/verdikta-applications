# PROPOSAL: supply chain, CI and host pivots (round-2 security review, compromise direction)

Status: a proposal for the owner. The repo-local items are in this patch: `deploy.sh --ignore-scripts`,
`.env` files at mode 600, actions pinned and checked in CI, and the servers no longer load deploy keys.
Each item below is a change on the host or on GitHub, ranked by value per effort.

1. **The GitHub SSH key on the production host** (`/root/.ssh/id_ed25519`). Every checkout fetches with
   it: applications, arbiter, common and dispatcher. One key across four repositories is a user or
   machine-user key, not a deploy key. `deploy.sh` uses it non-interactively, so it has no passphrase.
   Any root process can read it, and that includes a test server. If the key can push, a server RCE
   becomes a push to every repo and then to every arbiter that upgrades. **Fix:** a separate read-only
   deploy key per repository (`Host gh-apps` aliases in `/root/.ssh/config`), and remove this key from
   the GitHub account. **Check:** GitHub, Settings → SSH keys, and each repo's deploy keys.
2. **Branch protection on `main` and `beacon`** for all four repositories: require a PR with one
   review from someone other than the author, no force-push, and no admin bypass. `deploy.sh` runs
   whatever `origin/beacon` is, as root, on the production machine.
3. **The production clients are `vite build --watch` as root in the live checkout** (three units). Any
   write under `src/` reaches every visitor within seconds. Build once per deploy, as the test sites
   already do: a `Type=oneshot` build and nginx serving the result. Then a stray write does nothing until
   someone deploys it.
4. **Isolate the test units**: `systemd/verdikta-test-isolation.conf`, together with
   `verdikta-service-hardening.conf`. Install it before the test units are first enabled.
5. **Claude Code and other agent sessions run as root on the production machine**, with worktrees
   under `/root/verdikta/applications/.claude/worktrees/`, inside the live checkout. A session that
   reads hostile text (a bounty submission, a fetched page, an issue) runs as root next to every key.
   Move development to another machine, or at least to a non-root user without read access to
   `/root/verdikta/secrets` and `/root/.ssh`.
6. **`@verdikta/common` publishing.** Its trusted key set is the root of trust for stake attestations.
   Every lockfile pins it by integrity, so a new malicious version reaches an arbiter only through a
   lockfile bump or the installer's `npm install @verdikta/common@latest` path (unpinned components).
   Use npm trusted publishing from a GitHub Actions workflow with `--provenance`, require 2FA for publish
   on the `@verdikta` scope, and keep the token off this machine (there is no `/root/.npmrc` today, which
   is right).
7. **ClawHub.** The skills carry their own `deployments.json` (escrow address and code hash) and ABI.
   The pin protects against an address swap, but it ships in the same package as the code it checks.
   Whoever can publish `verdikta-bounties-onboarding` to ClawHub controls every agent wallet that installs
   or updates it. Enable 2FA on the publishing account. In each release's notes, publish the escrow
   address and code hash of the reviewed commit, so an agent can compare them against a second channel.
8. **DNS.** The `test.*` and production names are A records for this droplet's IP. If the droplet is
   destroyed or the IP is released while the records stay, whoever is given that IP next serves those
   names, and can get certificates for them. Make the teardown list "remove DNS first, then release
   the IP", and use a reserved IP.
9. **The arbiter installer's remaining fetches:** `npm install` (not `npm ci`) in `install-ai-node.sh`,
   `install-adapter.sh` and `upgrade-arbiter.sh`, with install scripts on, as the operator. The nvm
   installer is piped to bash from a tag, not a commit. The docs (not the installer) clone
   `github.com/yenachar/verdiktaChainlinkNode`, a personal account, unpinned. Prefer
   `npm ci --ignore-scripts` where the lockfile is committed, and pin the nvm script by commit and
   checksum.
10. **CI.** The arbiter workflows are now SHA-pinned except `actions/cache` (two calibration
    workflows). Its SHA could not be checked offline, and `.github/tests/actions-pinned.test.sh` lists
    it as pending. Add `persist-credentials: false` to checkouts followed by `npm ci`, so a dependency
    cannot read the job's token from `.git/config`. The token is read-only today, which limits the damage.
