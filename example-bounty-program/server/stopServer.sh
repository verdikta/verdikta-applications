#!/bin/bash
# Stop server for specified network(s)
# Usage: ./stopServer.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

stop_network() {
    local net="$1"
    local pid_file="server-${net}.pid"

    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm "$pid_file"
            echo "Server ($net) stopped (PID $PID)"
        else
            rm "$pid_file"
            echo "Server ($net) was not running (stale PID file removed)"
        fi
    else
        echo "Server ($net) is not running (no PID file)"
    fi
}

# Also stop legacy server (old single-network setup)
stop_legacy() {
    if [ -f "server.pid" ]; then
        PID=$(cat "server.pid")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            echo "Legacy server stopped (PID $PID)"
        fi
        rm -f "server.pid"
    fi
}

case "$NETWORK" in
    base)
        stop_legacy
        stop_network "base"
        ;;
    base-sepolia)
        stop_legacy
        stop_network "base-sepolia"
        ;;
    both)
        stop_legacy
        stop_network "base"
        stop_network "base-sepolia"
        ;;
    *)
        echo "Usage: $0 [base|base-sepolia|both]"
        echo "  base        - Stop mainnet server"
        echo "  base-sepolia - Stop testnet server"
        echo "  both        - Stop both (default)"
        exit 1
        ;;
esac
