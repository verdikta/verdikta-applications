#!/bin/bash

# Verdikta Example Frontend - Client Startup Script
# This script starts the React client with proper environment setup and logging
# Usage: ./startClient.sh [--staticconfig [classID]] [--port PORT]

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

# Default values
STATIC_CONFIG_MODE=false
STATIC_CLASS_ID=128
CLIENT_PORT=3000

# Parse command line arguments
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
        --port)
            if [[ $# -gt 1 && $2 =~ ^[0-9]+$ ]]; then
                CLIENT_PORT=$2
                shift # consume the port argument
            else
                print_error "Invalid port number"
                exit 1
            fi
            shift # consume the --port flag
            ;;
        *)
            print_error "Unknown option: $1"
            print_status "Usage: $0 [--staticconfig [classID]] [--port PORT]"
            print_status "  --staticconfig [classID]  Enable static configuration mode (default classID: 128)"
            print_status "  --port PORT              Set client port (default: 3000)"
            exit 1
            ;;
    esac
done

# Function to create .env file if needed
create_env_file() {
    local env_file=".env"
    if [ ! -f "$env_file" ]; then
        print_status "Creating .env file..."
        cat > "$env_file" << EOF
# React Client Configuration
PORT=$CLIENT_PORT
GENERATE_SOURCEMAP=false
REACT_APP_SERVER_URL=http://localhost:5000

# Network Configuration (uncomment to override default)
# REACT_APP_NETWORK=base_sepolia

# Static Configuration Mode (set by startup scripts)
# REACT_APP_STATIC_CONFIG_MODE=false
# REACT_APP_STATIC_CLASS_ID=128
EOF
        print_success ".env file created"
    else
        # Only update PORT if it exists, otherwise add it
        # Be very careful not to overwrite other important settings
        if grep -q "^PORT=" "$env_file"; then
            sed -i.bak "s/^PORT=.*/PORT=$CLIENT_PORT/" "$env_file" && rm "$env_file.bak"
            print_status ".env file PORT updated to $CLIENT_PORT"
        else
            # Add PORT at the top after any existing comments
            if grep -q "^#.*React Client Configuration" "$env_file"; then
                # Insert after the React Client Configuration comment
                sed -i.bak "/^#.*React Client Configuration/a\\
PORT=$CLIENT_PORT" "$env_file" && rm "$env_file.bak"
            else
                # Add at the beginning
                echo -e "# React Client Configuration\\nPORT=$CLIENT_PORT\\n$(cat $env_file)" > "$env_file.tmp" && mv "$env_file.tmp" "$env_file"
            fi
            print_status ".env file PORT added: $CLIENT_PORT"
        fi
    fi
}

# Function to setup logging
setup_logging() {
    local log_dir="../logs"
    if [ ! -d "$log_dir" ]; then
        mkdir -p "$log_dir"
    fi
    
    local timestamp=$(date +"%Y%m%d-%H%M%S")
    CLIENT_LOG_FILE="$log_dir/client-$timestamp.log"
    print_status "Client logs will be written to: $CLIENT_LOG_FILE"
}

# Cleanup function
cleanup() {
    print_status "Shutting down client..."
    if [ ! -z "$CLIENT_PID" ]; then
        kill $CLIENT_PID 2>/dev/null || true
        wait $CLIENT_PID 2>/dev/null || true
    fi
    print_success "Client stopped."
    exit 0
}

# Set up signal handlers for graceful shutdown
trap cleanup SIGINT SIGTERM

print_status "Starting Verdikta Example Frontend Client..."
if [ "$STATIC_CONFIG_MODE" = true ]; then
    print_status "Static configuration mode enabled (Class ID: $STATIC_CLASS_ID)"
fi
print_status "Client will run on port: $CLIENT_PORT"
print_warning "Press Ctrl+C to stop the client"
echo

# Note: We do NOT create or modify .env file here - user should manage it
# The .env file contains important user configuration that should not be overwritten
# We only export additional environment variables that may override .env settings
if [ ! -f ".env" ]; then
    print_warning "No .env file found. You may want to copy .env.example to .env and configure it."
fi

# Setup logging
setup_logging

# Export environment variables for the React app
export REACT_APP_STATIC_CONFIG_MODE="$STATIC_CONFIG_MODE"
export REACT_APP_STATIC_CLASS_ID="$STATIC_CLASS_ID"
export PORT="$CLIENT_PORT"

# Start the client
print_status "Starting React development server..."

# Start with logging
npm start 2>&1 | tee "$CLIENT_LOG_FILE" &
CLIENT_PID=$!

# Wait a moment for client to start
sleep 3

# Check if client is still running
if ! kill -0 $CLIENT_PID 2>/dev/null; then
    print_error "Client failed to start"
    print_error "Check the log file: $CLIENT_LOG_FILE"
    exit 1
fi

print_success "Client started successfully (PID: $CLIENT_PID)"
print_status "Client URL: http://localhost:$CLIENT_PORT"
print_status "Log file: $CLIENT_LOG_FILE"
echo

# Wait for the client process
wait $CLIENT_PID
