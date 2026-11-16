#!/usr/bin/env bash
# What a container on a GitHub-hosted runner may reach of the runner's own services: the egress rules of the
# reusable builder workflow's build job (.github/workflows/stake-attestation-builder.yml), which CI's
# builder-docker job runs too (.github/workflows/stake-attestation.yml), so its Docker tests build under them.
#
# A maker's commands.setup runs in the image build with the build's network, and needs it: a Foundry listing's
# `forge build` downloads its solc from binaries.soliditylang.org there. It must reach nothing private of the
# runner's, and it needs DNS:
#
#   169.254.169.254  the instance metadata service. Dropped, all of it.
#   168.63.129.16    the VM host's address. Dropped, but for port 53. It is also the resolver the VM was given,
#                    and Docker hands a build's containers that resolver: the host's own, systemd-resolved's
#                    stub, is on a loopback address a container can't use. With the whole address dropped, a setup
#                    has no DNS at all, and the first production listing failed that way (IMAGE_BUILD_FAILED,
#                    "Temporary failure in name resolution"). So UDP and TCP port 53 go back to Docker's own
#                    chains (RETURN, not ACCEPT). Nothing else on that address answers a name, and what does
#                    answer there (the host agent's endpoints, 80 and 32526) is the VM's alone.
#
# The rules are a chain of their own, flushed and filled in order on every run, and jumped to from the first
# position of DOCKER-USER: their order never depends on the order of -I calls, and a second run leaves one jump
# and one set. The workflow runs this before anything is built.
# IPv4 only: Docker's default bridge, which the build's RUN steps use, has no IPv6 unless the daemon is set up
# for it, and this script refuses to go on if it is. Without a DOCKER-USER chain (Docker's iptables) it refuses
# too, before any rule is written: a build with no rules must not start.
#
#   sudo bash action/egress-rules.sh
set -euo pipefail

CHAIN=VERDIKTA-BUILD-EGRESS
METADATA=169.254.169.254
HOST=168.63.129.16

ipt() { iptables -w "$@"; }

ipv6=$(docker network inspect bridge --format '{{.EnableIPv6}}')
if [ "$ipv6" != false ]; then
  echo "::error::Docker's default bridge has IPv6 (${ipv6:-unknown}); these egress rules are IPv4 only" >&2
  exit 1
fi
if ! ipt -n -L DOCKER-USER > /dev/null 2>&1; then
  echo "::error::there is no DOCKER-USER chain in iptables: these egress rules need Docker's iptables chains" >&2
  exit 1
fi

ipt -N "$CHAIN" 2> /dev/null || ipt -F "$CHAIN"
ipt -A "$CHAIN" -d "$HOST/32" -p udp --dport 53 -j RETURN
ipt -A "$CHAIN" -d "$HOST/32" -p tcp --dport 53 -j RETURN
ipt -A "$CHAIN" -d "$HOST/32" -j DROP
ipt -A "$CHAIN" -d "$METADATA/32" -j DROP
# One jump, at the top of DOCKER-USER, wherever an earlier run left one.
while ipt -D DOCKER-USER -j "$CHAIN" 2> /dev/null; do :; done
ipt -I DOCKER-USER 1 -j "$CHAIN"

echo "egress rules for this runner's containers (IPv4; Docker's default bridge has no IPv6):"
ipt -S DOCKER-USER
ipt -S "$CHAIN"
