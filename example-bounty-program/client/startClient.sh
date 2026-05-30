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

    # ------------------------------------------------------------------
    # systemd-managed mode (preferred).
    #
    # The client build-watch normally runs as a systemd service so it
    # survives reboots and auto-restarts. If that unit exists we MUST defer
    # to it: launching a second nohup watcher here would race systemd's
    # watcher on the same dist-${net}/ output dir. So instead of starting a
    # competing process, we just make sure the service is running.
    # ------------------------------------------------------------------
    local unit=""
    [ "$net" = "base" ]         && unit="verdikta-bounty-client-base.service"
    [ "$net" = "base-sepolia" ] && unit="verdikta-bounty-client-testnet.service"

    if command -v systemctl >/dev/null 2>&1 && systemctl cat "$unit" >/dev/null 2>&1; then
        # Reap any leftover legacy nohup watcher so the two don't coexist.
        if [ -f "$pid_file" ]; then
            local oldpid; oldpid=$(cat "$pid_file")
            if kill -0 "$oldpid" 2>/dev/null; then
                echo "Stopping legacy nohup watcher for $net (PID $oldpid) — this client is managed by systemd now"
                pkill -P "$oldpid" 2>/dev/null
                kill "$oldpid" 2>/dev/null
            fi
            rm -f "$pid_file"
        fi

        if systemctl is-active --quiet "$unit"; then
            echo "Client ($net) is managed by systemd and already running ($unit) — nothing to do."
            echo "  To restart it:  systemctl restart $unit"
            return 0
        fi

        echo "Client ($net) is managed by systemd but not running — starting $unit ..."
        if systemctl start "$unit" && systemctl is-active --quiet "$unit"; then
            echo "Client ($net) started via systemd ($unit) → dist-${net}/"
            return 0
        fi
        echo "ERROR: failed to start $unit. Check: journalctl -u $unit -n 50 --no-pager"
        return 1
    fi
    # ------------------------------------------------------------------
    # Legacy fallback: no systemd unit installed — run the nohup watcher.
    # ------------------------------------------------------------------

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
