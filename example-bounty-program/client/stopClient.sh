#!/bin/bash
# Stop client for specified network(s)
# Usage: ./stopClient.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

stop_network() {
    local net="$1"
    local pid_file="client-${net}.pid"

    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm "$pid_file"
            echo "Client ($net) stopped (PID $PID)"
        else
            rm "$pid_file"
            echo "Client ($net) was not running (stale PID file removed)"
        fi
    else
        echo "Client ($net) is not running (no PID file)"
    fi
}

# Also stop legacy client (old single-network setup)
stop_legacy() {
    if [ -f "client.pid" ]; then
        PID=$(cat "client.pid")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            echo "Legacy client stopped (PID $PID)"
        fi
        rm -f "client.pid"
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
        echo "  base        - Stop mainnet client"
        echo "  base-sepolia - Stop testnet client"
        echo "  both        - Stop both (default)"
        exit 1
        ;;
esac
