#!/usr/bin/env bash
set -euo pipefail

# Deploy StakeAttestation, with its libraries ClaimLogic and RecordLogic, to Base mainnet.
# Every value comes from the environment (see .env.example): PRIVATE_KEY (the deployer),
# VERDIKTA_AGGREGATOR_BASE, SA_INITIAL_OWNER, SA_FEE_RECIPIENT, SA_LISTING_FEE_WEI; optionally
# BASE_RPC_URL and ETHERSCAN_API_KEY (verification). A local, untracked .env is loaded first if
# there is one. The launch values (the listing fee among them) are the owner's decision before
# mainnet (build plan, assumption A5), so the script asks before it spends: set
# SA_CONFIRM_MAINNET=base to answer in advance.

cd "$(dirname "$0")"

# Load environment variables from .env
if [ -f .env ]; then
	set -a; source .env; set +a
fi

NETWORK="base"

for v in PRIVATE_KEY VERDIKTA_AGGREGATOR_BASE SA_INITIAL_OWNER SA_FEE_RECIPIENT SA_LISTING_FEE_WEI; do
	if [ -z "${!v:-}" ]; then
		echo "Set $v in the environment (see .env.example)."; exit 1
	fi
done

echo "Base MAINNET: aggregator $VERDIKTA_AGGREGATOR_BASE, owner $SA_INITIAL_OWNER,"
echo "fee recipient $SA_FEE_RECIPIENT, listing fee $SA_LISTING_FEE_WEI wei."
CONFIRM="${SA_CONFIRM_MAINNET:-}"
if [ -z "$CONFIRM" ]; then
	read -r -p "Type 'base' to deploy to Base mainnet: " CONFIRM
fi
if [ "$CONFIRM" != "base" ]; then
	echo "Not confirmed; nothing deployed."; exit 1
fi

echo "Compiling..."
npx hardhat compile

echo "Deploying StakeAttestation to $NETWORK..."
npx hardhat run deploy/01_deploy_stake_attestation.js --network "${NETWORK}"

echo "Done. Contract deployed to Base mainnet."
