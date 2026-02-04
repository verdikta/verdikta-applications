#!/bin/bash
# Build the Vite client for a given network mode and output a deployable dist folder.
# Usage: ./buildClient.sh [base|base-sepolia|both] [output_dir]
# Default: both, output under ../deploy/www/<net>

set -euo pipefail

cd "$(dirname "$0")"

NETWORK="${1:-both}"
OUTPUT_DIR="${2:-""}"

build_network() {
  local net="$1"
  local out

  if [ -n "$OUTPUT_DIR" ]; then
    out="$OUTPUT_DIR/$net"
  else
    out="../deploy/www/$net"
  fi

  echo "Building client for mode=$net → $out"
  rm -rf "$out"

  # Install deps (deterministic)
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi

  # Build with Vite mode, output to a network-specific folder
  npx vite build --mode "$net" --outDir "$out"

  echo "Built $net client: $out"
}

case "$NETWORK" in
  base)
    build_network "base"
    ;;
  base-sepolia)
    build_network "base-sepolia"
    ;;
  both)
    build_network "base"
    build_network "base-sepolia"
    ;;
  *)
    echo "Usage: $0 [base|base-sepolia|both] [output_dir]"
    exit 1
    ;;
esac
