#!/bin/bash
# Follow example-bounty-program backend logs. Usage: ./viewServer.sh [base|base-sepolia|both]
NETWORK="${1:-both}"
case "$NETWORK" in
  base)         ARGS="-u verdikta-bounty-base.service" ;;
  base-sepolia) ARGS="-u verdikta-bounty-testnet.service" ;;
  both)         ARGS="-u verdikta-bounty-base.service -u verdikta-bounty-testnet.service" ;;
  *) echo "Usage: $0 [base|base-sepolia|both]"; exit 1 ;;
esac
exec journalctl $ARGS -n 100 -f
