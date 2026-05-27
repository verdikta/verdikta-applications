#!/bin/bash
# example-bounty-program backends (systemd). Usage: ./restartServer.sh [base|base-sepolia|both]
NETWORK="${1:-both}"
case "$NETWORK" in
  base)         UNITS="verdikta-bounty-base.service" ;;
  base-sepolia) UNITS="verdikta-bounty-testnet.service" ;;
  both)         UNITS="verdikta-bounty-base.service verdikta-bounty-testnet.service" ;;
  *) echo "Usage: $0 [base|base-sepolia|both]"; exit 1 ;;
esac
echo "Restarting: $UNITS"
systemctl restart $UNITS
for u in $UNITS; do systemctl is-active --quiet "$u" && echo "  $u: active" || echo "  $u: FAILED (journalctl -u $u)"; done
