#!/bin/bash
# example-frontend backend + static client (systemd).
UNITS="verdikta-frontend-server.service verdikta-frontend-client.service"
echo "Restarting: $UNITS"
systemctl restart $UNITS
for u in $UNITS; do systemctl is-active --quiet "$u" && echo "  $u: active" || echo "  $u: FAILED (journalctl -u $u)"; done
