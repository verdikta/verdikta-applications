#!/bin/bash
# Stop the example-agents Vite dev server.

cd "$(dirname "$0")"

PORT="${PORT:-5174}"
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

# Safety net: kill anything still on the port
stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
if [ -n "$stragglers" ]; then
    echo "Cleaning up orphaned process(es) on port $PORT: $stragglers"
    echo "$stragglers" | xargs kill 2>/dev/null
    sleep 1
    stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
    if [ -n "$stragglers" ]; then
        echo "$stragglers" | xargs kill -9 2>/dev/null
    fi
fi
