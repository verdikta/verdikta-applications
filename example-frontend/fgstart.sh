#!/bin/bash
# Start the frontend services (systemd) and follow their logs in the foreground.
# Ctrl+C exits the log view; the services keep running under systemd.
UNITS="verdikta-frontend-server.service verdikta-frontend-client.service"
systemctl start $UNITS
echo "Started (systemd). Following logs — Ctrl+C exits the view; services stay up."
exec journalctl -u verdikta-frontend-server.service -u verdikta-frontend-client.service -n 50 -f
