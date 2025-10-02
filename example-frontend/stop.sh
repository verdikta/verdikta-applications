#!/bin/bash

# Verdikta Example Frontend - Stop Client and Server processes 

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVER_PID_FILE="/tmp/verdikta-server.pid"
CLIENT_PID_FILE="/tmp/verdikta-client.pid"

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_status "Stopping Verdikta services..."

# Stop server
if [ -f "$SERVER_PID_FILE" ]; then
    SERVER_PID=$(cat "$SERVER_PID_FILE")
    if kill -0 $SERVER_PID 2>/dev/null; then
        print_status "Stopping server (PID: $SERVER_PID)..."
        kill $SERVER_PID 2>/dev/null
        sleep 1
        kill -9 $SERVER_PID 2>/dev/null || true
        print_success "Server stopped"
    else
        print_status "Server not running"
    fi
    rm -f "$SERVER_PID_FILE"
fi

# Stop client
if [ -f "$CLIENT_PID_FILE" ]; then
    CLIENT_PID=$(cat "$CLIENT_PID_FILE")
    if kill -0 $CLIENT_PID 2>/dev/null; then
        print_status "Stopping client (PID: $CLIENT_PID)..."
        kill $CLIENT_PID 2>/dev/null
        sleep 1
        kill -9 $CLIENT_PID 2>/dev/null || true
        print_success "Client stopped"
    else
        print_status "Client not running"
    fi
    rm -f "$CLIENT_PID_FILE"
fi

print_success "All services stopped"

