#!/bin/bash
# Start the example-arbiters server.
# Writes server.pid and server.log in this directory.

cd "$(dirname "$0")"

PORT="${PORT:-5008}"
PID_FILE="server.pid"
LOG_FILE="server.log"

# Already running?
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Server already running with PID $PID"
        exit 0
    else
        rm "$PID_FILE"
    fi
fi

# Kill any orphan still holding the port
stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
if [ -n "$stragglers" ]; then
    echo "Killing orphaned process(es) on port $PORT: $stragglers"
    echo "$stragglers" | xargs kill 2>/dev/null
    sleep 1
    stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
    if [ -n "$stragglers" ]; then
        echo "$stragglers" | xargs kill -9 2>/dev/null
    fi
fi

echo "Starting server on port $PORT..."
PORT="$PORT" nohup node server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Server started with PID $(cat "$PID_FILE")"
else
    echo "ERROR: Server failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
