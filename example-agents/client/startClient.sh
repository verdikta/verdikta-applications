#!/bin/bash
# Start the example-agents Vite dev server.
# Writes client.pid and client.log in this directory.

cd "$(dirname "$0")"

PORT="${PORT:-5174}"
PID_FILE="client.pid"
LOG_FILE="client.log"

# Already running?
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Client already running with PID $PID"
        exit 0
    else
        rm "$PID_FILE"
    fi
fi

# Kill any orphan holding the port
stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
if [ -n "$stragglers" ]; then
    echo "Killing orphaned process(es) on port $PORT: $stragglers"
    echo "$stragglers" | xargs kill 2>/dev/null
    sleep 1
    stragglers=$(lsof -t -i:"$PORT" 2>/dev/null)
    if [ -n "$stragglers" ]; then
        echo "$stragglers" | xargs kill -9 2>/dev/null
        sleep 1
    fi
fi

echo "Starting client on port $PORT..."
nohup npm run dev -- --port "$PORT" --host 0.0.0.0 > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Client started with PID $(cat "$PID_FILE")"
else
    echo "ERROR: Client failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
