#!/bin/bash
# Round 6 (clean_shell): set up a throwaway OpenClaw install with production 'main''s versions, for the injection cases with an
# unsandboxed shell. Run as root inside a fresh container from the local ubuntu:24.04 image (CONNECTED_DESIGN.md, round 6):
#   docker run -d --name vdisc-r6 --cap-add NET_ADMIN --label purpose=vdisc-r6 \
#     ubuntu@sha256:69cecf4bbf72d2d44a9eef1b71fb98c7fb973d78af11399deccef19beb008ad9 sleep infinity
#   docker cp clean-shell-setup.sh vdisc-r6:/root/ && docker exec vdisc-r6 /root/clean-shell-setup.sh
# (A container rather than an image build: on the owner's Mac, Docker Desktop's registry proxy stalls pulls and builds.)
# Nothing of value goes in: no wallet, keystore, RPC URL or repository checkout; the decoy .env is added later.
# The last step closes egress to private, link-local and host addresses and to IPv6. NET_ADMIN serves only this root script:
# the gateway and the agent run as 'oc', whose processes carry no capabilities, so they cannot change the rules.
# The rules live in the container's network namespace: if the container restarts, run the egress part again and re-check.
set -euo pipefail
NODE_VERSION=v22.23.3
OPENCLAW_VERSION=2026.8.33
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils iptables iproute2 procps git python3 >/dev/null
A=$(dpkg --print-architecture | sed 's/amd64/x64/'); T="node-$NODE_VERSION-linux-$A.tar.xz"
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$T"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $T\$" | sha256sum -c -
tar -xJf "$T" -C /usr/local --strip-components=1 && rm "$T"
id oc >/dev/null 2>&1 || useradd -m -s /bin/bash oc
su - oc -c "npm config set prefix ~/.npm-global && npm i -g openclaw@$OPENCLAW_VERSION --no-fund --no-audit --loglevel=error"

# Egress: loopback and the resolver's port 53 stay open; private, link-local, loopback-range, multicast and reserved IPv4 is
# rejected (the owner's Mac and LAN, Docker Desktop's host services); public IPv4 stays open for the model API and the fixtures.
iptables -A OUTPUT -o lo -j ACCEPT
DNS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
if [ -n "$DNS" ]; then
  iptables -A OUTPUT -d "$DNS" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$DNS" -p tcp --dport 53 -j ACCEPT
fi
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$net" -j REJECT
done
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -P OUTPUT DROP
{ iptables -S OUTPUT; ip6tables -S OUTPUT; } > /root/egress-rules.txt

# Record what was installed and check, as 'oc', that it holds no capabilities and that egress behaves.
su - oc -c '
export PATH=$HOME/.npm-global/bin:$PATH
echo "node $(node --version); $(openclaw --version | head -1)"
grep CapEff /proc/self/status
probe() { node -e "const s=require(\"net\").connect({host:process.argv[1],port:+process.argv[2],timeout:4000},()=>{console.log(\"reachable\");s.destroy()});s.on(\"error\",e=>console.log(\"blocked (\"+e.code+\")\"));s.on(\"timeout\",()=>{console.log(\"blocked (timeout)\");s.destroy()})" "$1" "$2"; }
echo "raw.githubusercontent.com:443 $(probe raw.githubusercontent.com 443)"
echo "host.docker.internal:22      $(probe host.docker.internal 22)"
echo "192.168.0.1:80               $(probe 192.168.0.1 80)"
echo "172.17.0.1:80                $(probe 172.17.0.1 80)"
'
