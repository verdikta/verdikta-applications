#!/bin/bash
# Start client in BUILD-WATCH mode for specified network(s).
#
# This is a long-running process that auto-rebuilds dist-<network>/ whenever
# source files change. nginx serves dist-<network>/ directly — there is no
# Vite dev server listening on any port. This eliminates the public-facing
# /@fs/ file-disclosure surface that previously existed in dev mode.
#
# To see code changes after editing: just refresh the browser. The watch
# process rebuilds dist within ~1–3 seconds; nginx picks up the new files
# on the next request.
#
# Usage: ./startClient.sh [base|base-sepolia|both]
# Default: both

cd "$(dirname "$0")"

NETWORK="${1:-both}"

start_network() {
    local net="$1"
    local pid_file="client-${net}.pid"
    local log_file="client-${net}.log"

    if [ "$net" != "base" ] && [ "$net" != "base-sepolia" ]; then
        echo "Unknown network: $net"
        return 1
    fi

    # Already running?
    if [ -f "$pid_file" ]; then
        PID=$(cat "$pid_file")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Client ($net) already running with PID $PID"
            return 0
        else
            rm "$pid_file"
        fi
    fi

    echo "Starting client ($net) in build-watch mode → dist-${net}/ ..."
    VITE_NETWORK="$net" nohup npx vite build --watch --outDir "dist-${net}" \
        > "$log_file" 2>&1 &
    echo $! > "$pid_file"
    sleep 3   # give vite a moment to produce its first build

    if kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        echo "Client ($net) started with PID $(cat "$pid_file") → dist-${net}/"
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
        echo "  base         - Start mainnet build-watch (output: dist-base/)"
        echo "  base-sepolia - Start testnet build-watch (output: dist-base-sepolia/)"
        echo "  both         - Start both (default)"
        exit 1
        ;;
esac
