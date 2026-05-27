#!/bin/bash
# example-frontend — managed by systemd:
#   verdikta-frontend-server  (:5000)  backend
#   verdikta-frontend-client  (:3001)  static build served by `serve`
# The client is a STATIC build. To change it (incl. --staticconfig), run
# client/buildClient.sh then ./restart.sh. (Dev hot-reload: client/startClient.sh,
# after stopping verdikta-frontend-client.)
cd "$(dirname "$0")"
UNITS="verdikta-frontend-server.service verdikta-frontend-client.service"
if [ ! -f client/build/index.html ]; then
    echo "No client/build found — building static client first..."
    ( cd client && ./buildClient.sh )
fi
echo "Starting: $UNITS"
systemctl start $UNITS
for u in $UNITS; do systemctl is-active --quiet "$u" && echo "  $u: active" || echo "  $u: FAILED (journalctl -u $u)"; done
