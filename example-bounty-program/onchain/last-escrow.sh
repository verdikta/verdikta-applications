# save as scripts/last-escrow.sh
#!/usr/bin/env bash
set -euo pipefail

# Project root = the directory containing this script's parent (adjust if needed)
# ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(pwd)"

# 1) Use env var if already exported, otherwise read from .env
if [ -z "${HARDHAT_NETWORK:-}" ]; then
  if [ -f "$ROOT/.env" ]; then
    # Grep the last occurrence (in case you have multiple), strip quotes/spaces
    HARDHAT_NETWORK="$(
      awk -F= '/^[[:space:]]*HARDHAT_NETWORK[[:space:]]*=/ {
        val=$2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)   # trim spaces
        gsub(/^"\s*|\s*"$/, "", val)                   # strip surrounding quotes
        print val
      }' "$ROOT/.env" | tail -n1
    )"
  fi
fi

# 2) Default if still empty
HARDHAT_NETWORK="${HARDHAT_NETWORK:-base_sepolia}"

echo "Network: $HARDHAT_NETWORK"
echo "Last bounty escrow contract:"
cd "$ROOT"

# 3) Run the script via Hardhat on that network
npx hardhat run scripts/last-escrow.js --network "$HARDHAT_NETWORK"

