#!/bin/bash
cd "$(dirname "$0")"
nohup node server.js > server.log 2>&1 &
echo $! > server.pid
sleep 1
systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null
echo "Server started with PID $(cat server.pid)"

# npm run dev

