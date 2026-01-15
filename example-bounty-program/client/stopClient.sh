#!/bin/bash
cd "$(dirname "$0")"
if [ -f client.pid ]; then
  PID=$(cat client.pid)
  if kill -0 $PID 2>/dev/null; then
    kill $PID
    rm client.pid
    echo "Client stopped (PID $PID)"
  else
    rm client.pid
    echo "Client was not running"
  fi
else
  echo "No client.pid file found"
fi

