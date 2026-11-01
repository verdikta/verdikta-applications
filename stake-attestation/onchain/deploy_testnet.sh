#!/usr/bin/env bash
set -euo pipefail

# Deploy StakeAttestation, with its libraries ClaimLogic and RecordLogic, to Base Sepolia testnet.
# Every value comes from the environment (see .env.example): PRIVATE_KEY (the deployer),
# VERDIKTA_AGGREGATOR_BASE_SEPOLIA, SA_INITIAL_OWNER, SA_FEE_RECIPIENT, SA_LISTING_FEE_WEI;
# optionally BASE_SEPOLIA_RPC_URL and ETHERSCAN_API_KEY (verification). A local, untracked .env
# is loaded first if there is one.

cd "$(dirname "$0")"

# Load environment variables from .env
if [ -f .env ]; then
	set -a; source .env; set +a
fi

NETWORK="base_sepolia"

for v in PRIVATE_KEY VERDIKTA_AGGREGATOR_BASE_SEPOLIA SA_INITIAL_OWNER SA_FEE_RECIPIENT SA_LISTING_FEE_WEI; do
	if [ -z "${!v:-}" ]; then
		echo "Set $v in the environment (see .env.example)."; exit 1
	fi
done

echo "Compiling..."
npx hardhat compile

echo "Deploying StakeAttestation to $NETWORK..."
npx hardhat run deploy/01_deploy_stake_attestation.js --network "${NETWORK}"

echo "Done. Contract deployed to Base Sepolia testnet."
