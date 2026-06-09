#!/bin/bash
# Rebuild the static client bundle, then restart the frontend services.
#
# WHY THIS EXISTS: the site is served from a STATIC build (client/build), and
# Create React App bakes the code + REACT_APP_* vars in at BUILD time. So editing
# client source or client/.env changes NOTHING that's served until you rebuild AND
# restart. Forgetting the rebuild makes the live site keep running the old bundle
# (which looks like "my fix didn't work" / stale-contract or stale-logic errors).
#
# This is just a convenience wrapper over the two canonical steps:
#     client/buildClient.sh   (memory-capped static production build)
#     ./restart.sh            (restart the systemd units)
#
# Usage:
#   ./rebuildAndRestart.sh [--staticconfig [classID]]
#   (any args are passed through to client/buildClient.sh)
#
# Server-only changes (server/*.js, server/data/contracts.json) need just
# ./restart.sh — no client rebuild.
set -e
cd "$(dirname "$0")"

echo "==> [1/2] Building static client..."
./client/buildClient.sh "$@"

echo "==> [2/2] Restarting frontend services..."
./restart.sh

echo
echo "Done. The bundle filename is content-hashed, so reload index.html to pick it"
echo "up — do a hard refresh (Cmd/Ctrl-Shift-R) to be sure no cached index.html lingers."
