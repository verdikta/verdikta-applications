#!/bin/bash
# Follow example-arbiters backend logs (systemd journal).
exec journalctl -u verdikta-arbiters-server.service -n 100 -f
