#!/bin/bash
# Start the example-agents client in BUILD-WATCH mode.
#
# Long-running process: rebuilds dist/ whenever source files change.
# nginx serves dist/ directly — no Vite dev server, no public-facing dev port.
# To see code changes after editing: refresh the browser. The watch process
# rebuilds within ~1–3 seconds; nginx picks up new files on next request.

cd "$(dirname "$0")"

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

echo "Starting client in build-watch mode → dist/ ..."
nohup npx vite build --watch > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 3

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Client started with PID $(cat "$PID_FILE") → dist/"
else
    echo "ERROR: Client failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
