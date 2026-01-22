#!/bin/bash
# Start client for specified network(s)
# Usage: ./startClient.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

start_network() {
    local net="$1"
    local port pid_file log_file

    if [ "$net" = "base" ]; then
        port=5173
    elif [ "$net" = "base-sepolia" ]; then
        port=5174
    else
        echo "Unknown network: $net"
        return 1
    fi

    pid_file="client-${net}.pid"
    log_file="client-${net}.log"

    # Check if already running
    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Client ($net) already running with PID $PID"
            return 0
        else
            rm "$pid_file"
        fi
    fi

    # Start the client with the appropriate mode and port
    echo "Starting client ($net) on port $port..."
    nohup npm run dev -- --mode "$net" --port "$port" --host 0.0.0.0 > "$log_file" 2>&1 &
    echo $! > "$pid_file"
    sleep 2

    # Verify it started
    if kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        echo "Client ($net) started with PID $(cat "$pid_file")"
    else
        echo "ERROR: Client ($net) failed to start. Check $log_file"
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
        echo "  base        - Start mainnet client (port 5173)"
        echo "  base-sepolia - Start testnet client (port 5174)"
        echo "  both        - Start both (default)"
        exit 1
        ;;
esac
