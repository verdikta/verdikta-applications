#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   NETWORK=base-sepolia ./deploy.sh
#   NETWORK=base          ./deploy.sh

# : "${NETWORK:=base-sepolia}"

if [ ! -f ".env" ]; then
	  echo ".env not found. Copy .env.example and fill in values."; exit 1;
fi

# Load HARDHAT_NETWORK from .env if it exists
if [ -f .env ]; then
	  set -a; source .env; set +a
fi

NETWORK=${NETWORK:-${HARDHAT_NETWORK:-base_sepolia}}

echo "Compiling..."
npx hardhat compile

echo "Deploying BountyEscrow to $NETWORK..."
npx hardhat run deploy/01_deploy_bounty.js  --network "${NETWORK}"

echo "Done."

