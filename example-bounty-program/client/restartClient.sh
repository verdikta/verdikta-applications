#!/bin/bash
# Restart client for specified network(s)
# Usage: ./restartClient.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

./stopClient.sh "$NETWORK"
sleep 1
./startClient.sh "$NETWORK"
