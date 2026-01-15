#!/bin/bash
cd "$(dirname "$0")"
nohup npm run dev -- --host 0.0.0.0 > client.log 2>&1 &
echo $! > client.pid
echo "Client started with PID $(cat client.pid)"


# npm run dev -- --host 0.0.0.0

