#!/usr/bin/env bash
# Deploy the TEST sites (test.arbiters, test.bounties, test.bounties-testnet) from a git ref.
#
#   ops/test-sites/deploy.sh [ref]        default ref: origin/beacon
#
# - moves the TEST checkout (a git worktree, detached) to <ref>; it never touches the live checkout
#   /root/verdikta/applications, which serves production and stays on main
# - installs packages only where a package-lock.json changed since the last deploy
# - builds the clients once into dist-test-* (no watchers: the test sites change only when deployed)
# - restarts the test servers whose systemd units are installed
#
# One-time setup and the files it expects: ops/test-sites/README.md.
set -euo pipefail

TEST=/root/verdikta/applications-test
LIVE=/root/verdikta/applications
REF="${1:-origin/beacon}"
NODE=/opt/node22/bin/node

die() { echo "deploy: $*" >&2; exit 1; }

[ -d "$TEST" ] || die "no test checkout at $TEST (see README: git worktree add --detach $TEST beacon)"
[ "$(realpath "$TEST")" != "$(realpath "$LIVE")" ] || die "refusing: $TEST is the live checkout"
git -C "$TEST" rev-parse --git-dir >/dev/null 2>&1 || die "$TEST is not a git checkout"
[ -z "$(git -C "$TEST" status --porcelain --untracked-files=no)" ] || die "$TEST has local changes to tracked files; the test checkout is deploy-only"

git -C "$TEST" fetch -q origin
git -C "$TEST" checkout -q --detach "$REF"
echo "deploy: $TEST at $(git -C "$TEST" log -1 --format='%h %s')"

# packages: npm ci where the lockfile changed (a stamp in node_modules records the last one installed)
for pkg in skills/verdikta-discover example-bounty-program/server example-bounty-program/client example-arbiters/server example-arbiters/client; do
  dir="$TEST/$pkg"
  sum=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  if [ "$(cat "$dir/node_modules/.deploy-lock-sha" 2>/dev/null)" != "$sum" ]; then
    echo "deploy: npm ci in $pkg"
    (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error)
    echo "$sum" > "$dir/node_modules/.deploy-lock-sha"
  fi
done

for f in example-bounty-program/server/.env example-bounty-program/client/.env example-arbiters/server/.env; do
  [ -f "$TEST/$f" ] || die "missing $TEST/$f (copy it from ops/test-sites/env/ and fill it in)"
done

# clients: one build per site, into the folders the test nginx sites serve
build() { # dir outDir [VITE_NETWORK]
  local dir="$TEST/$1" out="$2" net="${3:-}"
  echo "deploy: build $1 -> $out${net:+ ($net)}"
  (cd "$dir" && env NODE_ENV=production ${net:+VITE_NETWORK=$net} "$NODE" node_modules/vite/bin/vite.js build \
      --outDir "$out" --emptyOutDir --logLevel warn)
}
build example-bounty-program/client dist-test-base base
build example-bounty-program/client dist-test-base-sepolia base-sepolia
build example-arbiters/client dist-test

# servers: restart the installed test units (a unit not installed, e.g. mainnet before its v2 deploy, is skipped)
for unit in verdikta-test-bounty-testnet verdikta-test-bounty-base verdikta-test-arbiters-server; do
  if systemctl cat "$unit.service" >/dev/null 2>&1 && systemctl is-enabled -q "$unit.service" 2>/dev/null; then
    echo "deploy: restart $unit"
    systemctl restart "$unit.service"
  fi
done
echo "deploy: done"
