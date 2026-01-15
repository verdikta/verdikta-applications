#!/bin/bash
cd "$(dirname "$0")"
if [ -f server.pid ]; then
  PID=$(cat server.pid)
  if kill -0 $PID 2>/dev/null; then
    kill $PID
    rm server.pid
    echo "Server stopped (PID $PID)"
  else
    rm server.pid
    echo "Server was not running"
  fi
else
  echo "No server.pid file found"
fi
