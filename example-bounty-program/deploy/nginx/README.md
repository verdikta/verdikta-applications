# Nginx Configuration

This directory contains Nginx configuration files for the bounty program application.

## Files

- `bounties.verdikta.org` - Production bounty program (Base Mainnet)
- `bounties-testnet.verdikta.org` - Testnet bounty program (Base Sepolia)

## Architecture

Each domain serves a **built production** client directly from disk (no Vite dev server), and proxies only the API to the backend.

```
bounties.verdikta.org (Mainnet)
├── Static client: /var/www/verdikta-bounties/base
└── API:          localhost:5005 (NETWORK=base)

bounties-testnet.verdikta.org (Testnet)
├── Static client: /var/www/verdikta-bounties/base-sepolia
└── API:          localhost:5006 (NETWORK=base-sepolia)
```

## Deployment

1. Copy the configuration files to Nginx:
   ```bash
   sudo cp deploy/nginx/bounties.verdikta.org /etc/nginx/sites-available/
   sudo cp deploy/nginx/bounties-testnet.verdikta.org /etc/nginx/sites-available/
   ```

2. Enable the sites:
   ```bash
   sudo ln -s /etc/nginx/sites-available/bounties.verdikta.org /etc/nginx/sites-enabled/
   sudo ln -s /etc/nginx/sites-available/bounties-testnet.verdikta.org /etc/nginx/sites-enabled/
   ```

3. Test the configuration:
   ```bash
   sudo nginx -t
   ```

4. Reload Nginx:
   ```bash
   sudo systemctl reload nginx
   ```

5. Set up SSL certificates with Certbot:
   ```bash
   sudo certbot --nginx -d bounties.verdikta.org
   sudo certbot --nginx -d bounties-testnet.verdikta.org
   ```

   Certbot will automatically modify the configuration files to add HTTPS support and HTTP-to-HTTPS redirects.

## Building + Deploying the Client (Production)

Build the static client(s):

```bash
cd example-bounty-program/client

# Build both networks into example-bounty-program/deploy/www/<net>
./buildClient.sh

# Or build one
./buildClient.sh base
./buildClient.sh base-sepolia
```

Copy the built output to the server web root:

```bash
sudo mkdir -p /var/www/verdikta-bounties
sudo rsync -av --delete ../deploy/www/base/ /var/www/verdikta-bounties/base/
sudo rsync -av --delete ../deploy/www/base-sepolia/ /var/www/verdikta-bounties/base-sepolia/
```

## Starting Services

Only the backend servers need to run persistently; Nginx serves the client statically.

```bash
# Start both backend networks (default)
./server/startServer.sh

# Start specific network
./server/startServer.sh base
./server/startServer.sh base-sepolia

# Stop all
./server/stopServer.sh
```

## Notes

- These are base HTTP configurations. Certbot will add SSL settings automatically.
- Ensure DNS records point to the server before running Certbot.
- The server IP is currently `134.199.203.20`.
