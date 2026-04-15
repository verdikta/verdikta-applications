#!/bin/bash
cd "$(dirname "$0")"
./stopClient.sh
sleep 1
./startClient.sh
