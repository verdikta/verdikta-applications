#!/bin/bash
# example-arbiters backend (systemd: verdikta-arbiters-server)
UNIT=verdikta-arbiters-server.service
echo "Stopping $UNIT ..."
systemctl stop "$UNIT" && echo "Stopped."
