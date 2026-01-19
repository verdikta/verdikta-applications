#!/usr/bin/env bash
set -euo pipefail

# Deploy BountyEscrow contract to Base mainnet

if [ ! -f ".env" ]; then
	echo ".env not found. Copy .env.example and fill in values."; exit 1;
fi

# Load environment variables from .env
if [ -f .env ]; then
	set -a; source .env; set +a
fi

NETWORK="base"

echo "Compiling..."
npx hardhat compile

echo "Deploying BountyEscrow to $NETWORK..."
npx hardhat run deploy/01_deploy_bounty.js --network "${NETWORK}"

echo "Done. Contract deployed to Base mainnet."
