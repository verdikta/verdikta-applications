#!/usr/bin/env bash
# Build a clean bundle for ClawHub publishing.
# Usage: ./publish.sh [--dry-run]
#
# Assembles only the files ClawHub needs into a staging directory,
# then runs clawhub publish. Excludes .env, node_modules, package-lock.json,
# .gitignore, and other non-skill files.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGE_DIR="${SKILL_DIR}/.clawhub-stage"
VERSION="${VERSION:-1.0.0}"
DRY_RUN=""

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/scripts" "$STAGE_DIR/references"

cp "$SKILL_DIR/SKILL.md" "$STAGE_DIR/"
cp "$SKILL_DIR/README.md" "$STAGE_DIR/"

# Scripts: source files + package.json + .env.example only
for f in "$SKILL_DIR"/scripts/*.js "$SKILL_DIR"/scripts/package.json "$SKILL_DIR"/scripts/.env.example; do
  [ -f "$f" ] && cp "$f" "$STAGE_DIR/scripts/"
done

# Reference docs
cp "$SKILL_DIR"/references/*.md "$STAGE_DIR/references/"

echo "Staged files:"
find "$STAGE_DIR" -type f | sort | sed "s|$STAGE_DIR/||"
echo ""
echo "Total: $(find "$STAGE_DIR" -type f | wc -l | tr -d ' ') files"

if [[ -n "$DRY_RUN" ]]; then
  echo ""
  echo "[dry-run] Would publish: clawhub publish $STAGE_DIR --slug verdikta-bounties-onboarding --name \"Verdikta Bounties Onboarding\" --version $VERSION --tags latest"
  echo "[dry-run] Cleaning up staging directory."
  rm -rf "$STAGE_DIR"
  exit 0
fi

clawhub publish "$STAGE_DIR" \
  --slug verdikta-bounties-onboarding \
  --name "Verdikta Bounties Onboarding" \
  --version "$VERSION" \
  --tags latest

rm -rf "$STAGE_DIR"
echo "Published and cleaned up staging directory."
