#!/bin/bash
# example-frontend backend only (systemd: verdikta-frontend-server, :5000).
UNIT=verdikta-frontend-server.service
echo "Starting $UNIT ..."
systemctl start "$UNIT"
systemctl is-active --quiet "$UNIT" && echo "Active. Logs: journalctl -u $UNIT -f" || { echo "FAILED:"; journalctl -u "$UNIT" -n 20 --no-pager; exit 1; }
