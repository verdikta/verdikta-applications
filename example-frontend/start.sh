#!/bin/bash

# Verdikta Example Frontend - Combined Startup Script
# This script starts both the server and client for the example frontend application

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

print_status "Starting Verdikta Example Frontend..."
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
print_status "Client: http://localhost:3000 (or your configured port)"
print_warning "Press Ctrl+C to stop both services"
echo

# Wait for both processes
wait $SERVER_PID $CLIENT_PID 