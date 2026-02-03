#!/bin/bash

# Verdikta Example Frontend - Daemon Startup Script
# Starts client and server processes in backgroung.
# Ensures nginx is running to supprt HTTPS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Directories for temp files
mkdir -p ./client/tmp
mkdir -p ./server/tmp

# Function to check and start nginx if needed
check_nginx() {
    print_status "Checking nginx status..."
    
    if ! systemctl is-active --quiet nginx; then
        print_warning "Nginx is not running. Attempting to start..."
        sudo systemctl start nginx
        sleep 2
        
        if systemctl is-active --quiet nginx; then
            print_success "Nginx started successfully"
        else
            print_error "Failed to start nginx. HTTPS may not work."
            return 1
        fi
    else
        print_success "Nginx is running"
    fi
    
    # Test nginx configuration
    if sudo nginx -t 2>/dev/null; then
        print_success "Nginx configuration is valid"
    else
        print_warning "Nginx configuration has errors. Run 'sudo nginx -t' to check."
    fi
    
    # Reload nginx to pick up any config changes
    print_status "Reloading nginx configuration..."
    sudo systemctl reload nginx
}

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# PID files
SERVER_PID_FILE="./tmp/verdikta-server.pid"
CLIENT_PID_FILE="./tmp/verdikta-client.pid"

# Log files
SERVER_LOG_FILE="./tmp/verdikta-server.log"
CLIENT_LOG_FILE="./tmp/verdikta-client.log"

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

get_client_port() {
    local env_file="client/.env"
    if [ -f "$env_file" ]; then
        local port=$(grep "^PORT=" "$env_file" | cut -d'=' -f2)
        if [ ! -z "$port" ]; then
            echo "$port"
        else
            echo "3000"
        fi
    else
        echo "3000"
    fi
}

# Function to kill all processes on a port
kill_port() {
    local port=$1
    local pids=$(lsof -ti:$port 2>/dev/null)
    
    if [ ! -z "$pids" ]; then
        print_status "Killing processes on port $port..."
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
}

kill_existing_processes() {
    print_status "Checking for existing processes..."
    
    # Kill by PID file first (cleaner)
    if [ -f "$SERVER_PID_FILE" ]; then
        SERVER_PID=$(cat "$SERVER_PID_FILE")
        if kill -0 $SERVER_PID 2>/dev/null; then
            print_status "Stopping existing server (PID: $SERVER_PID)..."
            # Kill the process group to get all children
            kill -- -$SERVER_PID 2>/dev/null || kill $SERVER_PID 2>/dev/null || true
            sleep 1
        fi
        rm -f "$SERVER_PID_FILE"
    fi
    
    if [ -f "$CLIENT_PID_FILE" ]; then
        CLIENT_PID=$(cat "$CLIENT_PID_FILE")
        if kill -0 $CLIENT_PID 2>/dev/null; then
            print_status "Stopping existing client (PID: $CLIENT_PID)..."
            # Kill the process group to get all children
            kill -- -$CLIENT_PID 2>/dev/null || kill $CLIENT_PID 2>/dev/null || true
            sleep 1
        fi
        rm -f "$CLIENT_PID_FILE"
    fi
    
    # Force kill anything still on the ports
    kill_port 5000
    kill_port $(get_client_port)
    
    # Final check
    sleep 1
    if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        print_warning "Port 5000 still occupied, forcing cleanup..."
        kill_port 5000
    fi
}

# Parse command line arguments
STATIC_CONFIG_MODE=false
STATIC_CLASS_ID=128

while [[ $# -gt 0 ]]; do
    case $1 in
        --staticconfig)
            STATIC_CONFIG_MODE=true
            if [[ $# -gt 1 && $2 =~ ^[0-9]+$ ]]; then
                STATIC_CLASS_ID=$2
                shift
            fi
            shift
            ;;
        *)
            print_error "Unknown option: $1"
            print_status "Usage: $0 [--staticconfig [classID]]"
            exit 1
            ;;
    esac
done

# Check if directories exist
if [ ! -d "server" ]; then
    print_error "Server directory not found. Please run this script from the example-frontend root directory."
    exit 1
fi

if [ ! -d "client" ]; then
    print_error "Client directory not found. Please run this script from the example-frontend root directory."
    exit 1
fi

# Kill any existing processes
kill_existing_processes

# Check nginx
check_nginx

# Get client port
CLIENT_PORT=$(get_client_port)

print_status "Starting Verdikta Example Frontend..."
if [ "$STATIC_CONFIG_MODE" = true ]; then
    print_status "Static configuration mode enabled (Class ID: $STATIC_CLASS_ID)"
fi
echo

# Start the server in background (detached)
print_status "Starting server..."
cd server
nohup npm start > "$SERVER_LOG_FILE" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$SERVER_PID_FILE"
cd ..

# Wait and check if server started
sleep 3
if ! kill -0 $SERVER_PID 2>/dev/null; then
    print_error "Server failed to start. Check logs: $SERVER_LOG_FILE"
    print_error "Last few lines of log:"
    tail -10 "$SERVER_LOG_FILE"
    exit 1
fi
print_success "Server started (PID: $SERVER_PID)"

# Start the client in background (detached)
print_status "Starting client..."
cd client
REACT_APP_STATIC_CONFIG_MODE="$STATIC_CONFIG_MODE" \
REACT_APP_STATIC_CLASS_ID="$STATIC_CLASS_ID" \
nohup npm start > "$CLIENT_LOG_FILE" 2>&1 &
CLIENT_PID=$!
echo $CLIENT_PID > "$CLIENT_PID_FILE"
cd ..

# Wait and check if client started
sleep 3
if ! kill -0 $CLIENT_PID 2>/dev/null; then
    print_error "Client failed to start. Check logs: $CLIENT_LOG_FILE"
    print_error "Last few lines of log:"
    tail -10 "$CLIENT_LOG_FILE"
    exit 1
fi
print_success "Client started (PID: $CLIENT_PID)"

echo
print_success "Both services are running in the background!"
print_status "Server: http://localhost:5000 (PID: $SERVER_PID)"
print_status "Client: http://localhost:$CLIENT_PORT (PID: $CLIENT_PID)"
echo
print_status "Logs:"
print_status "  Server: $SERVER_LOG_FILE"
print_status "  Client: $CLIENT_LOG_FILE"
echo
print_status "To stop services, run: ./stop.sh"
print_status "To view logs: tail -f $SERVER_LOG_FILE"

