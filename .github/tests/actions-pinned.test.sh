#!/bin/bash
# Every third-party action a workflow uses is pinned to a full commit SHA. A tag such as @v4 can be
# moved by whoever controls the action's repository, and the moved code then runs in our jobs, some
# of which hold secrets (the stake-attestation signing job's KMS identity). A local action (./...) or a reusable
# workflow in this repository is not fetched, so it needs no pin.
#
# PENDING lists actions not yet pinned because their SHA could not be checked when this test was
# written. Pin them (look up the commit of the tag you trust) and empty the list; the test fails if
# an action is listed here but already pinned, so the list cannot go stale.
# Run: bash .github/tests/actions-pinned.test.sh   (plain bash, grep and sed)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WF="${WF_DIR:-$ROOT/.github/workflows}"
PENDING=()
pass=0; fail=0

is_pending() { local a; for a in "${PENDING[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }

shopt -s nullglob
files=("$WF"/*.yml "$WF"/*.yaml)
[ ${#files[@]} -gt 0 ] || { echo "FAIL: no workflow files in $WF"; exit 1; }
for f in "${files[@]}"; do
    while IFS= read -r line; do
        n=${line%%:*}
        ref=$(printf '%s' "${line#*:}" | sed -E 's/^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']$//')
        case "$ref" in ./*|docker://*) pass=$((pass+1)); continue ;; esac
        action=${ref%@*}; version=${ref##*@}
        if [[ "$ref" != *@* ]]; then
            fail=$((fail+1)); echo "FAIL: $(basename "$f"):$n: $ref has no version"
        elif [[ "$version" =~ ^[0-9a-f]{40}$ ]]; then
            if is_pending "$action"; then fail=$((fail+1)); echo "FAIL: $action is pinned now: remove it from PENDING"; else pass=$((pass+1)); fi
        elif is_pending "$action"; then
            pass=$((pass+1))
        else
            fail=$((fail+1)); echo "FAIL: $(basename "$f"):$n: $ref is not pinned to a commit SHA"
        fi
    done < <(grep -nE '^[[:space:]]*(-[[:space:]]*)?uses:' "$f")
done

echo "actions pinned: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
