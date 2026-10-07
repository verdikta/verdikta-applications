#!/usr/bin/env bash
# Build a clean bundle for ClawHub publishing.
# Usage: ./publish.sh [--dry-run]
#
# Assembles only the files ClawHub needs into a temporary staging directory,
# then runs clawhub publish. Leaves out the tests, node_modules, .gitignore,
# scripts/.env.example (the ClawHub CLI never uploads dot-files, and nothing
# reads it at run time) and two repository-only maintainer tools,
# compile-contracts.js and sync_contract_assets.js, which work only inside a
# full repository checkout.
#
# --dry-run stages and lists the files, then runs `clawhub publish --dry-run`:
# the CLI hashes the files locally and asks the registry which version it would
# publish. No file is uploaded.

set -euo pipefail

REQUIRED_VERSION="0.23.1"

if ! command -v clawhub >/dev/null 2>&1; then
  echo "Error: ClawHub CLI not found. Run: npm install -g clawhub@latest" >&2
  exit 1
fi

INSTALLED_VERSION="$(clawhub --cli-version 2>/dev/null | tail -n1)"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$INSTALLED_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
  echo "Error: ClawHub CLI $REQUIRED_VERSION or newer is required."
  echo "Installed: $INSTALLED_VERSION"
  echo "Run: npm install -g clawhub@latest"
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${VERSION:-1.7.2}"
DRY_RUN=""

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

META_VERSION="$(node -p 'require(process.argv[1]).version' "$SKILL_DIR/_meta.json")"
if [[ "$VERSION" != "$META_VERSION" ]]; then
  echo "Error: VERSION $VERSION differs from _meta.json version $META_VERSION." >&2
  exit 1
fi

# Publish only a committed revision, so the release matches a reviewable commit.
if git -C "$SKILL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git -C "$SKILL_DIR" diff --quiet HEAD -- . || [[ -n "$(git -C "$SKILL_DIR" ls-files --others --exclude-standard -- .)" ]]; then
    if [[ -n "$DRY_RUN" ]]; then
      echo "Warning: uncommitted changes in $SKILL_DIR; a real publish would stop here." >&2
    else
      echo "Error: uncommitted changes in $SKILL_DIR. Commit and review them first." >&2
      exit 1
    fi
  fi
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/verdikta-bounties-onboarding-stage.XXXXXX")"
trap 'rm -rf "${STAGE_DIR:?}"' EXIT
mkdir -p "$STAGE_DIR/scripts" "$STAGE_DIR/references" "$STAGE_DIR/examples"

cp "$SKILL_DIR/SKILL.md" "$STAGE_DIR/"
cp "$SKILL_DIR/README.md" "$STAGE_DIR/"
cp "$SKILL_DIR/_meta.json" "$STAGE_DIR/"

# Scripts: source files, package.json and the lockfile
for f in "$SKILL_DIR"/scripts/*.js "$SKILL_DIR"/scripts/*.cjs "$SKILL_DIR"/scripts/bounty-escrow.abi.json "$SKILL_DIR"/scripts/deployments.json "$SKILL_DIR"/scripts/package-lock.json "$SKILL_DIR"/scripts/package.json; do
  case "$(basename "$f")" in
    compile-contracts.js|sync_contract_assets.js) continue ;;
  esac
  [ -f "$f" ] && cp "$f" "$STAGE_DIR/scripts/"
done

cp "$SKILL_DIR"/examples/*.json "$STAGE_DIR/examples/"

# Reference docs
cp "$SKILL_DIR"/references/*.md "$STAGE_DIR/references/"

echo "Staged files:"
find "$STAGE_DIR" -type f | sort | sed "s|$STAGE_DIR/||"
echo ""
echo "Total: $(find "$STAGE_DIR" -type f | wc -l | tr -d ' ') files"

PUBLISH_ARGS=("$STAGE_DIR" --slug verdikta-bounties-onboarding --name "Verdikta Bounties Onboarding" --version "$VERSION" --tags latest)

if [[ -n "$DRY_RUN" ]]; then
  echo ""
  clawhub publish "${PUBLISH_ARGS[@]}" --dry-run
  echo "[dry-run] Nothing was uploaded."
  exit 0
fi

clawhub publish "${PUBLISH_ARGS[@]}"
echo "Published; the staging directory is removed on exit."
