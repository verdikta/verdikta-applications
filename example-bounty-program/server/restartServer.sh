#!/bin/bash
# Restart server for specified network(s)
# Usage: ./restartServer.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

./stopServer.sh "$NETWORK"
sleep 1
./startServer.sh "$NETWORK"
