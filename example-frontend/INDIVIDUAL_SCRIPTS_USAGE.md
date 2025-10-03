# Individual Startup Scripts Usage

This document explains how to use the individual startup scripts for the Verdikta Example Frontend.

## Overview

You can start the server and client separately using the individual scripts:
- `server/startServer.sh` - Starts only the Express server
- `client/startClient.sh` - Starts only the React client

These scripts provide the same functionality as the combined `start.sh` script but allow for more granular control.

## Server Script (`server/startServer.sh`)

### Usage
```bash
cd server
./startServer.sh [--port PORT]
```

### Options
- `--port PORT` - Set server port (default: 5000)

### Features
- ✅ Creates/updates server `.env` file automatically
- ✅ Logs output to timestamped log files in `../logs/`
- ✅ Checks if port is available before starting
- ✅ Graceful shutdown with Ctrl+C
- ✅ Process management and error handling
- ✅ Automatic npm install if node_modules missing

### Examples
```bash
# Start server on default port (5000)
./startServer.sh

# Start server on custom port
./startServer.sh --port 8000
```

## Client Script (`client/startClient.sh`)

### Usage
```bash
cd client
./startClient.sh [--staticconfig [classID]] [--port PORT]
```

### Options
- `--staticconfig [classID]` - Enable static configuration mode (default classID: 128)
- `--port PORT` - Set client port (default: 3000)

### Features
- ✅ Creates/updates client `.env` file automatically
- ✅ Logs output to timestamped log files in `../logs/`
- ✅ Supports static configuration mode
- ✅ Graceful shutdown with Ctrl+C
- ✅ Process management and error handling
- ✅ Environment variable setup for React app

### Examples
```bash
# Start client on default port (3000)
./startClient.sh

# Start client on custom port
./startClient.sh --port 3001

# Start client with static configuration mode
./startClient.sh --staticconfig

# Start client with static configuration and custom class ID
./startClient.sh --staticconfig 256

# Combine options
./startClient.sh --staticconfig 128 --port 3001
```

## Environment Files

### Server `.env` (created automatically)
```env
# Server Configuration
PORT=5000
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info

# IPFS Configuration (optional)
# IPFS_PINNING_SERVICE=https://api.pinata.cloud
# IPFS_PINNING_KEY=your_pinata_key_here
```

### Client `.env` (USER MANAGED - NOT auto-created)

**IMPORTANT**: The client `.env` file is NOT automatically created or modified by the startup scripts. You must set it up manually.

1. Copy the example file:
```bash
cd client
cp .env.example .env
```

2. Edit `.env` with your configuration:
```env
# Contract Configuration
REACT_APP_CONTRACT_ADDRESSES=0x2E67c4D565C55E31514eDd68E42bFBb50a2C49F1
REACT_APP_CONTRACT_NAMES=Default Contract
REACT_APP_CONTRACT_CLASSES=128

# Client Configuration
PORT=3000
REACT_APP_SERVER_URL=http://localhost:5000

# Build Configuration
GENERATE_SOURCEMAP=false

# Network Configuration (uncomment to override default)
# REACT_APP_NETWORK=base_sepolia
```

See `client/ENV_SETUP.md` for detailed configuration instructions.

## Logging

Both scripts create timestamped log files in the `logs/` directory:
- Server logs: `logs/server-YYYYMMDD-HHMMSS.log`
- Client logs: `logs/client-YYYYMMDD-HHMMSS.log`

## Troubleshooting

### Port Already in Use
If you get a "port already in use" error:
```bash
# Check what's using the port
lsof -i :5000  # for server
lsof -i :3000  # for client

# Use a different port
./startServer.sh --port 5001
./startClient.sh --port 3001
```

### Missing Dependencies
If you get dependency errors, the scripts will automatically run `npm install` for missing node_modules.

### Log Files
Check the log files in the `logs/` directory for detailed error information:
```bash
# View latest server log
ls -la logs/server-*.log | tail -1
tail -f logs/server-$(ls logs/server-*.log | tail -1 | cut -d'/' -f2)

# View latest client log
ls -la logs/client-*.log | tail -1
tail -f logs/client-$(ls logs/client-*.log | tail -1 | cut -d'/' -f2)
```

## Comparison with Combined Script

| Feature | Combined `start.sh` | Individual Scripts |
|---------|--------------------|--------------------|
| Start both services | ✅ | ❌ (manual) |
| Individual service control | ❌ | ✅ |
| Environment setup | ✅ | ✅ |
| Logging | ✅ | ✅ |
| Static config mode | ✅ | ✅ |
| Custom ports | ✅ | ✅ |
| Process management | ✅ | ✅ |
| Graceful shutdown | ✅ | ✅ |

## When to Use Individual Scripts

Use individual scripts when you:
- Want to develop/debug only one service
- Need different startup timing
- Want to run services on different machines
- Need custom configuration per service
- Are experiencing issues with the combined script

Use the combined `start.sh` script when you:
- Want to start both services together
- Are doing normal development work
- Want simplified process management

