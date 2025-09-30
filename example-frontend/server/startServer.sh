#!/bin/bash

# Verdikta Example Frontend - Server Startup Script
# This script starts the Express server with proper logging and process management
# Usage: ./startServer.sh [--port PORT]

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
SERVER_PORT=5000

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            if [[ $# -gt 1 && $2 =~ ^[0-9]+$ ]]; then
                SERVER_PORT=$2
                shift # consume the port argument
            else
                print_error "Invalid port number"
                exit 1
            fi
            shift # consume the --port flag
            ;;
        *)
            print_error "Unknown option: $1"
            print_status "Usage: $0 [--port PORT]"
            print_status "  --port PORT    Set server port (default: 5000)"
            exit 1
            ;;
    esac
done

# Function to create/update .env file if needed
create_env_file() {
    local env_file=".env"
    if [ ! -f "$env_file" ]; then
        print_status "Creating server .env file..."
        cat > "$env_file" << EOF
# Server Configuration
PORT=$SERVER_PORT
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info

# IPFS Configuration (optional - set if using custom IPFS services)
# IPFS_PINNING_SERVICE=https://api.pinata.cloud
# IPFS_PINNING_KEY=your_pinata_key_here
EOF
        print_success "Server .env file created"
    else
        # Update port in existing .env file
        if grep -q "^PORT=" "$env_file"; then
            sed -i.bak "s/^PORT=.*/PORT=$SERVER_PORT/" "$env_file" && rm "$env_file.bak"
        else
            echo "PORT=$SERVER_PORT" >> "$env_file"
        fi
        print_status "Server .env file updated with PORT=$SERVER_PORT"
    fi
}

# Function to setup logging
setup_logging() {
    local log_dir="../logs"
    if [ ! -d "$log_dir" ]; then
        mkdir -p "$log_dir"
    fi
    
    local timestamp=$(date +"%Y%m%d-%H%M%S")
    SERVER_LOG_FILE="$log_dir/server-$timestamp.log"
    print_status "Server logs will be written to: $SERVER_LOG_FILE"
}

# Function to check if port is available
check_port() {
    if lsof -Pi :$SERVER_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        print_error "Port $SERVER_PORT is already in use"
        print_status "Please choose a different port or stop the service using port $SERVER_PORT"
        exit 1
    fi
}

# Cleanup function
cleanup() {
    print_status "Shutting down server..."
    if [ ! -z "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
    print_success "Server stopped."
    exit 0
}

# Set up signal handlers for graceful shutdown
trap cleanup SIGINT SIGTERM

print_status "Starting Verdikta Example Frontend Server..."
print_status "Server will run on port: $SERVER_PORT"
print_warning "Press Ctrl+C to stop the server"
echo

# Check if port is available
check_port

# Create .env file with proper configuration
create_env_file

# Setup logging
setup_logging

# Export environment variables
export PORT="$SERVER_PORT"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    print_warning "node_modules not found. Running npm install..."
    npm install
fi

# Start the server
print_status "Starting Express server..."

# Start with logging
npm start 2>&1 | tee "$SERVER_LOG_FILE" &
SERVER_PID=$!

# Wait a moment for server to start
sleep 3

# Check if server is still running
if ! kill -0 $SERVER_PID 2>/dev/null; then
    print_error "Server failed to start"
    print_error "Check the log file: $SERVER_LOG_FILE"
    exit 1
fi

print_success "Server started successfully (PID: $SERVER_PID)"
print_status "Server URL: http://localhost:$SERVER_PORT"
print_status "Health check: http://localhost:$SERVER_PORT/health"
print_status "Log file: $SERVER_LOG_FILE"
echo

# Wait for the server process
wait $SERVER_PID
