#!/bin/bash
# Stop the example-arbiters client (build-watch mode).
# Also cleans up any legacy dev-mode process still bound to the old port.

cd "$(dirname "$0")"

LEGACY_PORT="${PORT:-5175}"  # only used if a legacy `npm run dev` was started
PID_FILE="client.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        pkill -P "$PID" 2>/dev/null
        kill "$PID" 2>/dev/null
        echo "Client stopped (PID $PID)"
    else
        echo "Client was not running (stale PID file removed)"
    fi
    rm -f "$PID_FILE"
else
    echo "Client is not running (no PID file)"
fi

# Safety net: in build-watch mode no port is bound — but if a legacy
# `npm run dev` is still running on the old port, kill it.
stragglers=$(lsof -t -i:"$LEGACY_PORT" 2>/dev/null)
if [ -n "$stragglers" ]; then
    echo "Cleaning up legacy dev-mode processes on port $LEGACY_PORT: $stragglers"
    echo "$stragglers" | xargs kill 2>/dev/null
    sleep 1
    stragglers=$(lsof -t -i:"$LEGACY_PORT" 2>/dev/null)
    if [ -n "$stragglers" ]; then
        echo "$stragglers" | xargs kill -9 2>/dev/null
    fi
fi
