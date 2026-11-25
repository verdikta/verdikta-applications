#!/bin/sh
# PROPOSED (security review, not run): a host firewall. Today ufw is inactive and the INPUT policy is
# ACCEPT, so every node service bound to 0.0.0.0/* (3001, 5000, 5005, 5006, 5008; 600x for the test
# sites) answers plain HTTP from the internet, bypassing nginx's TLS, headers, path blocks and body
# limits. Check the cloud provider's firewall too; this is defence in depth either way.
# Keep an out-of-band console open while applying.
set -e
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow in on tailscale0
ufw allow 41641/udp      # tailscale
ufw --force enable
ufw status verbose
