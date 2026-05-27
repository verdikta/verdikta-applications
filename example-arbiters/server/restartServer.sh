#!/bin/bash
# example-arbiters backend (systemd: verdikta-arbiters-server)
UNIT=verdikta-arbiters-server.service
echo "Restarting $UNIT ..."
systemctl restart "$UNIT"
if systemctl is-active --quiet "$UNIT"; then
    echo "Active.  Logs: journalctl -u $UNIT -f"
else
    echo "FAILED to restart — recent logs:"; journalctl -u "$UNIT" -n 20 --no-pager; exit 1
fi
