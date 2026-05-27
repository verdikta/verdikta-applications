#!/bin/bash
# example-arbiters backend — now managed by systemd (verdikta-arbiters-server).
# Kept for convenience; equivalent to: systemctl start verdikta-arbiters-server
UNIT=verdikta-arbiters-server.service
echo "Starting $UNIT ..."
systemctl start "$UNIT"
if systemctl is-active --quiet "$UNIT"; then
    echo "Active.  Logs: journalctl -u $UNIT -f"
else
    echo "FAILED to start — recent logs:"; journalctl -u "$UNIT" -n 20 --no-pager; exit 1
fi
