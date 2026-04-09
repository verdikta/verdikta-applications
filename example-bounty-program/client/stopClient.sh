#!/bin/bash
# Stop client for specified network(s)
# Usage: ./stopClient.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

stop_network() {
    local net="$1"
    local port pid_file

    if [ "$net" = "base" ]; then
        port=5173
    elif [ "$net" = "base-sepolia" ]; then
        port=5174
    fi

    pid_file="client-${net}.pid"

    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            # Kill the entire process tree (npm + vite child)
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
            echo "Client ($net) stopped (PID $PID)"
        else
            echo "Client ($net) was not running (stale PID file removed)"
        fi
        rm -f "$pid_file"
    else
        echo "Client ($net) is not running (no PID file)"
    fi

    # Safety net: kill anything still listening on the expected port
    if [ -n "$port" ]; then
        local stragglers
        stragglers=$(lsof -t -i:"$port" 2>/dev/null)
        if [ -n "$stragglers" ]; then
            echo "Cleaning up orphaned process(es) on port $port: $stragglers"
            echo "$stragglers" | xargs kill 2>/dev/null
            sleep 1
            # Force-kill anything that didn't exit gracefully
            stragglers=$(lsof -t -i:"$port" 2>/dev/null)
            if [ -n "$stragglers" ]; then
                echo "$stragglers" | xargs kill -9 2>/dev/null
            fi
        fi
    fi
}

# Also stop legacy client (old single-network setup)
stop_legacy() {
    if [ -f "client.pid" ]; then
        PID=$(cat "client.pid")
        if kill -0 "$PID" 2>/dev/null; then
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
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
