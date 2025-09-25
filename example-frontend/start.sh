#!/bin/bash

# Verdikta Example Frontend - Combined Startup Script
# This script starts both the server and client for the example frontend application
# Usage: ./start.sh [--staticconfig [classID]]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to get client port from .env file
get_client_port() {
    local env_file="client/.env"
    if [ -f "$env_file" ]; then
        local port=$(grep "^PORT=" "$env_file" | cut -d'=' -f2)
        if [ ! -z "$port" ]; then
            echo "$port"
        else
            echo "3000"  # default fallback
        fi
    else
        echo "3000"  # default fallback
    fi
}

# Function to cleanup background processes
cleanup() {
    print_status "Shutting down services..."
    
    # Kill server process if it exists
    if [ ! -z "$SERVER_PID" ]; then
        print_status "Stopping server (PID: $SERVER_PID)..."
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
    
    # Kill client process if it exists
    if [ ! -z "$CLIENT_PID" ]; then
        print_status "Stopping client (PID: $CLIENT_PID)..."
        kill $CLIENT_PID 2>/dev/null || true
        wait $CLIENT_PID 2>/dev/null || true
    fi
    
    print_success "Services stopped."
    exit 0
}

# Parse command line arguments
STATIC_CONFIG_MODE=false
STATIC_CLASS_ID=128

while [[ $# -gt 0 ]]; do
    case $1 in
        --staticconfig)
            STATIC_CONFIG_MODE=true
            # Check if next argument is a number (classID)
            if [[ $# -gt 1 && $2 =~ ^[0-9]+$ ]]; then
                STATIC_CLASS_ID=$2
                shift # consume the classID argument
            fi
            shift # consume the --staticconfig flag
            ;;
        *)
            print_error "Unknown option: $1"
            print_status "Usage: $0 [--staticconfig [classID]]"
            print_status "  --staticconfig [classID]  Enable static configuration mode (default classID: 128)"
            exit 1
            ;;
    esac
done

# Set up signal handlers for graceful shutdown
trap cleanup SIGINT SIGTERM

# Check if directories exist
if [ ! -d "server" ]; then
    print_error "Server directory not found. Please run this script from the example-frontend root directory."
    exit 1
fi

if [ ! -d "client" ]; then
    print_error "Client directory not found. Please run this script from the example-frontend root directory."
    exit 1
fi

# Get client port from .env file
CLIENT_PORT=$(get_client_port)

print_status "Starting Verdikta Example Frontend..."
if [ "$STATIC_CONFIG_MODE" = true ]; then
    print_status "Static configuration mode enabled (Class ID: $STATIC_CLASS_ID)"
fi
print_status "Press Ctrl+C to stop both services"
echo

# Start the server in background
print_status "Starting server..."
cd server
npm start &
SERVER_PID=$!
cd ..

# Wait a moment for server to start
sleep 2

# Check if server is still running
if ! kill -0 $SERVER_PID 2>/dev/null; then
    print_error "Server failed to start"
    exit 1
fi

print_success "Server started (PID: $SERVER_PID)"

# Start the client in background
print_status "Starting client..."
cd client
# Export environment variables for the React app
export REACT_APP_STATIC_CONFIG_MODE="$STATIC_CONFIG_MODE"
export REACT_APP_STATIC_CLASS_ID="$STATIC_CLASS_ID"
npm start &
CLIENT_PID=$!
cd ..

# Wait a moment for client to start
sleep 2

# Check if client is still running
if ! kill -0 $CLIENT_PID 2>/dev/null; then
    print_error "Client failed to start"
    cleanup
    exit 1
fi

print_success "Client started (PID: $CLIENT_PID)"
echo
print_success "Both services are running!"
print_status "Server: http://localhost:5000 (or your configured port)"
print_status "Client: http://localhost:$CLIENT_PORT"
print_warning "Press Ctrl+C to stop both services"
echo

# Wait for both processes
wait $SERVER_PID $CLIENT_PID 