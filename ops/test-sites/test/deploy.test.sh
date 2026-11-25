#!/usr/bin/env bash
# deploy.sh runs as root on the production machine. This checks, against a throwaway git checkout
# with npm, node and systemctl stubbed, that it
#   - installs with --ignore-scripts (no dependency's install script runs as root),
#   - leaves the sites' .env files at mode 600 (a plain cp from ops/test-sites/env/ makes them 644),
#   - refuses to run in the live checkout, and refuses a ref that would be read as an option.
# Run: bash ops/test-sites/test/deploy.test.sh   (git, bash, coreutils; no network, no root)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$HERE/../deploy.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# The stubs log their arguments.
mkdir -p "$T/bin"
for cmd in npm systemctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\n' "$cmd" "$T" > "$T/bin/$cmd"
done
printf '#!/bin/sh\necho "node $*" >> "%s/calls"\n' "$T" > "$T/node"
# npm ci must leave a node_modules for the stamp
printf '#!/bin/sh\necho "npm $*" >> "%s/calls"\nmkdir -p node_modules\n' "$T" > "$T/bin/npm"
chmod +x "$T/bin/"* "$T/node"

# An origin with the five packages, and a detached checkout of it as the test checkout.
git init -q -b beacon "$T/origin"
for p in skills/verdikta-discover example-bounty-program/server example-bounty-program/client example-arbiters/server example-arbiters/client; do
  mkdir -p "$T/origin/$p"; echo '{}' > "$T/origin/$p/package-lock.json"
done
printf 'node_modules/\n.env\n' > "$T/origin/.gitignore"
git -C "$T/origin" add -A && git -C "$T/origin" -c user.name=t -c user.email=t@t commit -qm init
git clone -q "$T/origin" "$T/test" && git -C "$T/test" checkout -q --detach
for f in example-bounty-program/server/.env example-bounty-program/client/.env example-arbiters/server/.env; do
  (umask 022; echo 'KEY=x' > "$T/test/$f")
done
mkdir -p "$T/live"

run() { # run [ref] -> exit code; output in $T/out
  rm -f "$T/calls"
  PATH="$T/bin:$PATH" VERDIKTA_DEPLOY_TEST_CHECKOUT="$1" VERDIKTA_DEPLOY_LIVE_CHECKOUT="$T/live" \
    VERDIKTA_DEPLOY_NODE="$T/node" bash "$DEPLOY" "${@:2}" > "$T/out" 2>&1
}

run "$T/test" origin/beacon; rc=$?
[ "$rc" -eq 0 ] && ok || bad "deploy failed ($rc): $(cat "$T/out")"

n_ci=$(grep -c '^npm ci' "$T/calls" 2>/dev/null)
[ "$n_ci" -eq 5 ] && ok || bad "expected 5 npm ci calls, got $n_ci"
n_safe=$(grep -c '^npm ci .*--ignore-scripts' "$T/calls" 2>/dev/null)
[ "$n_safe" -eq "$n_ci" ] && ok || bad "npm ci without --ignore-scripts: $(grep '^npm ci' "$T/calls" | grep -v -- --ignore-scripts)"

for f in example-bounty-program/server/.env example-bounty-program/client/.env example-arbiters/server/.env; do
  m=$(stat -c %a "$T/test/$f")
  [ "$m" = 600 ] && ok || bad "$f is mode $m, not 600"
done

n_build=$(grep -c 'vite.js build' "$T/calls" 2>/dev/null)
[ "$n_build" -eq 3 ] && ok || bad "expected 3 client builds, got $n_build"

# A second deploy with the same lockfiles installs nothing.
run "$T/test" origin/beacon
[ "$(grep -c '^npm ci' "$T/calls")" -eq 0 ] && ok || bad "unchanged lockfiles were installed again"

# Refusals
ln -sfn "$T/test" "$T/live-link"
PATH="$T/bin:$PATH" VERDIKTA_DEPLOY_TEST_CHECKOUT="$T/test" VERDIKTA_DEPLOY_LIVE_CHECKOUT="$T/live-link" \
  VERDIKTA_DEPLOY_NODE="$T/node" bash "$DEPLOY" origin/beacon > "$T/out" 2>&1; rc=$?
{ [ "$rc" -ne 0 ] && grep -q 'is the live checkout' "$T/out"; } && ok || bad "ran in the live checkout ($rc): $(cat "$T/out")"
run "$T/test" --upload-pack=touch; rc=$?
{ [ "$rc" -ne 0 ] && grep -q "refusing ref" "$T/out"; } && ok || bad "accepted an option-like ref ($rc)"

echo "deploy.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
