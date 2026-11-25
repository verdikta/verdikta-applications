# Test sites for v2

These are copies of the bounty and arbiters sites that run the v2 code (`beacon`) against a separate
v2 deployment, independently of the running system. They share only the machine with production.

| Site | Serves | API (systemd unit, port) | Network |
|---|---|---|---|
| test.bounties-testnet.verdikta.org | `example-bounty-program/client/dist-test-base-sepolia` | `verdikta-test-bounty-testnet`, :6006 | Base Sepolia |
| test.bounties.verdikta.org | `example-bounty-program/client/dist-test-base` | `verdikta-test-bounty-base`, :6005 | Base mainnet (once a v2 test deployment exists there) |
| test.arbiters.verdikta.org | `example-arbiters/client/dist-test` | `verdikta-test-arbiters-server`, :6008 | both (the site's network switch) |

The production equivalents are 5006, 5005 and 5008, served from `/root/verdikta/applications`.

## What is kept apart from production

- **Code.** The worktree `/root/verdikta/applications-test` is detached at a commit and changes only
  when `deploy.sh` runs. It is not the development worktree `/root/verdikta/applications-beacon`, so an
  edit there never reaches the test sites by itself. It is not the live checkout either, which stays on
  `main`.
- **Builds.** The clients are built once per deploy into `dist-test-*`. There are no watchers.
- **Data.** Each checkout has its own `server/data/<network>/jobs.json`. The test units also set
  `VERDIKTA_TMP_DIR=/tmp/verdikta-test`.
- **Secrets.** The test units set `VERDIKTA_SECRETS_FILE=/root/verdikta/secrets-test/.env.secrets`,
  so they never load production's `/root/verdikta/secrets/.env.secrets`. In particular there is no
  shared keeper wallet, whose transaction nonces would collide.
- **Contracts and arbiters.** A separate v2 deployment (keeper, aggregator, JuryBeacons, BountyEscrow)
  and test arbiter nodes registered with that keeper.
- **Search engines.** Every response carries `X-Robots-Tag: noindex, nofollow`, and `/robots.txt`
  disallows everything. Basic auth is ready to switch on in the nginx files.

## One-time setup

1. **DNS.** A records for `test.arbiters`, `test.bounties` and `test.bounties-testnet` point at this
   server. This is done: all three resolve to 134.199.203.20.
2. **v2 contracts on Base Sepolia.**
   - Run the dispatcher's `reputationBasedAggregator/deploy/` (libraries, aggregator, keeper and
     JuryBeacons, wiring, then `setLimits(50, 3600, 155)` and `setParams`).
   - Then run the bounty escrow's `onchain/deploy/01_deploy_bounty.js` with `VERDIKTA_AGGREGATOR_BASE_SEPOLIA`
     set to the new aggregator.
   - Note the addresses and deploy blocks.
3. **Test arbiters.** Run arbiter nodes on the arbiter repo's `beacon` branch, with test operators and
   their own Chainlink jobs.
   - Each operator owner calls `addReputationKeeper(<test keeper>)`, then `registerArbiter` with the test
     wVDKA stake.
   - Six or more covers a Small jury; a thinner pool repeats arbiters.
4. **Test secrets.**
   ```
   mkdir -p /root/verdikta/secrets-test && chmod 700 /root/verdikta/secrets-test
   cp ops/test-sites/env/secrets-test.env.secrets.template /root/verdikta/secrets-test/.env.secrets
   chmod 600 /root/verdikta/secrets-test/.env.secrets   # then fill it in
   ```
5. **Test checkout and settings.**
   ```
   git -C /root/verdikta/applications worktree add --detach /root/verdikta/applications-test origin/beacon
   T=/root/verdikta/applications-test; E=$T/ops/test-sites/env
   install -m 600 $E/bounty-server.env   $T/example-bounty-program/server/.env
   install -m 600 $E/bounty-client.env   $T/example-bounty-program/client/.env
   install -m 600 $E/arbiters-server.env $T/example-arbiters/server/.env
   ```
   Fill in the v2 addresses and deploy blocks from step 2, and the client key from step 4.
6. **First deploy:** `ops/test-sites/deploy.sh`. It installs packages (with `--ignore-scripts`: it runs as root here), sets the three `.env` files to mode 600, and builds the three clients. Its test: `bash ops/test-sites/test/deploy.test.sh`.
7. **Servers.** Copy the units, then start Sepolia and the arbiters. Start the mainnet one only after a
   v2 mainnet test deployment exists.
   ```
   cp ops/test-sites/systemd/verdikta-test-*.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now verdikta-test-bounty-testnet verdikta-test-arbiters-server
   curl -s localhost:6006/health; curl -s localhost:6008/health
   ```
   Rotate their logs (the units append to `server-test-*.log`; nothing else rotates them, and the disk
   is production's):
   ```
   cp ops/test-sites/logrotate/verdikta-test /etc/logrotate.d/ && logrotate -d /etc/logrotate.d/verdikta-test
   ```
8. **nginx and certificates.** This adds three new files and changes no production file. A reload keeps
   live connections.
   ```
   for h in test.arbiters test.bounties test.bounties-testnet; do
     cp ops/test-sites/nginx/$h.verdikta.org /etc/nginx/sites-available/
     ln -s /etc/nginx/sites-available/$h.verdikta.org /etc/nginx/sites-enabled/
   done
   nginx -t && systemctl reload nginx
   certbot --nginx -d test.arbiters.verdikta.org
   certbot --nginx -d test.bounties.verdikta.org
   certbot --nginx -d test.bounties-testnet.verdikta.org
   ```
   Use one certificate per name, as production does. A wildcard `*.verdikta.org` would not cover
   two-level names such as `test.bounties.verdikta.org`.
9. **Check** that `curl -sI https://test.bounties-testnet.verdikta.org | grep -i x-robots`,
   `/health` and `/api/...` answer, then run real rounds:
   - a Small jury;
   - a Jumbo jury with beacons;
   - a soft fail and its re-run;
   - a never-promoted round (committer shares);
   - a cancelled round (the arbiter pool), then the next draw's `PoolPayment`.

## Updating

```
ops/test-sites/deploy.sh               # origin/beacon
ops/test-sites/deploy.sh <commit|tag>  # a specific version
```

Push the commit first: the script fetches from origin. Each package is reinstalled only when its
`package-lock.json` changed.

## Removing

```
systemctl disable --now verdikta-test-bounty-testnet verdikta-test-bounty-base verdikta-test-arbiters-server
rm /etc/nginx/sites-enabled/test.{arbiters,bounties,bounties-testnet}.verdikta.org && nginx -t && systemctl reload nginx
git -C /root/verdikta/applications worktree remove /root/verdikta/applications-test
```
