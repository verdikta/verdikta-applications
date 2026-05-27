#!/bin/bash
# example-bounty-program backends (systemd). Usage: ./stopServer.sh [base|base-sepolia|both]
NETWORK="${1:-both}"
case "$NETWORK" in
  base)         UNITS="verdikta-bounty-base.service" ;;
  base-sepolia) UNITS="verdikta-bounty-testnet.service" ;;
  both)         UNITS="verdikta-bounty-base.service verdikta-bounty-testnet.service" ;;
  *) echo "Usage: $0 [base|base-sepolia|both]"; exit 1 ;;
esac
echo "Stopping: $UNITS"
systemctl stop $UNITS && echo "Stopped."
