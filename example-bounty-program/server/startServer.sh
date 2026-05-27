#!/bin/bash
# example-bounty-program backends — managed by systemd.
#   base         -> verdikta-bounty-base.service    (:5005)
#   base-sepolia -> verdikta-bounty-testnet.service (:5006)
# Usage: ./startServer.sh [base|base-sepolia|both]   (default: both)
NETWORK="${1:-both}"
case "$NETWORK" in
  base)         UNITS="verdikta-bounty-base.service" ;;
  base-sepolia) UNITS="verdikta-bounty-testnet.service" ;;
  both)         UNITS="verdikta-bounty-base.service verdikta-bounty-testnet.service" ;;
  *) echo "Usage: $0 [base|base-sepolia|both]"; exit 1 ;;
esac
echo "Starting: $UNITS"
systemctl start $UNITS
for u in $UNITS; do systemctl is-active --quiet "$u" && echo "  $u: active" || echo "  $u: FAILED (journalctl -u $u)"; done
