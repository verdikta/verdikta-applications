#!/bin/bash
# Verdikta Example Frontend - Client (production STATIC build).
#
# This box serves the client as a low-RAM STATIC build via `serve`, managed by
# systemd (verdikta-frontend-client, :3001). The old react-scripts hot-reload
# dev server (~400MB) is intentionally NOT run here anymore.
#
# This script rebuilds the static client and restarts the systemd service so the
# new build goes live.
#
# Usage: ./startClient.sh [--staticconfig [classID]]
#   (For instant-refresh hot-reload development, do that on a dev machine —
#    `npm start` — not on this production server.)
set -e
cd "$(dirname "$0")"

UNIT=verdikta-frontend-client.service

# Build the static bundle (passes through --staticconfig [classID] to buildClient).
echo "Building static client..."
./buildClient.sh "$@"

# Make the new build live.
echo "Restarting $UNIT ..."
systemctl restart "$UNIT"
if systemctl is-active --quiet "$UNIT"; then
    echo "Live on :3001 (static).  Logs: journalctl -u $UNIT -f"
else
    echo "FAILED to start — recent logs:"
    journalctl -u "$UNIT" -n 20 --no-pager
    exit 1
fi
