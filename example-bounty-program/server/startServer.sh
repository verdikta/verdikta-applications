#!/bin/bash
# Start server for specified network(s)
# Usage: ./startServer.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

start_network() {
    local net="$1"
    local port pid_file log_file

    if [ "$net" = "base" ]; then
        port=5005
    elif [ "$net" = "base-sepolia" ]; then
        port=5006
    else
        echo "Unknown network: $net"
        return 1
    fi

    pid_file="server-${net}.pid"
    log_file="server-${net}.log"

    # Check if already running
    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Server ($net) already running with PID $PID"
            return 0
        else
            rm "$pid_file"
        fi
    fi

    # Start the server
    echo "Starting server ($net) on port $port..."
    NETWORK="$net" PORT="$port" nohup node server.js > "$log_file" 2>&1 &
    echo $! > "$pid_file"
    sleep 1

    # Verify it started
    if kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        echo "Server ($net) started with PID $(cat "$pid_file")"
    else
        echo "ERROR: Server ($net) failed to start. Check $log_file"
        rm -f "$pid_file"
        return 1
    fi
}

case "$NETWORK" in
    base)
        start_network "base"
        ;;
    base-sepolia)
        start_network "base-sepolia"
        ;;
    both)
        start_network "base"
        start_network "base-sepolia"
        ;;
    *)
        echo "Usage: $0 [base|base-sepolia|both]"
        echo "  base        - Start mainnet server (port 5005)"
        echo "  base-sepolia - Start testnet server (port 5006)"
        echo "  both        - Start both (default)"
        exit 1
        ;;
esac

# Reload nginx
systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
