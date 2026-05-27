#!/bin/bash
# example-frontend backend + static client (systemd).
UNITS="verdikta-frontend-server.service verdikta-frontend-client.service"
echo "Stopping: $UNITS"
systemctl stop $UNITS && echo "Stopped."
