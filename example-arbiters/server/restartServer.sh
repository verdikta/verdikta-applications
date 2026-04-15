#!/bin/bash
cd "$(dirname "$0")"
./stopServer.sh
sleep 1
./startServer.sh
