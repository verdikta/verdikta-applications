# Nginx Configuration

This directory contains Nginx configuration files for the bounty program application.

## Files

- `bounties.verdikta.org` - Production bounty program (Base Mainnet)
- `bounties-testnet.verdikta.org` - Testnet bounty program (Base Sepolia)

## Architecture

Each domain routes to its own client and server instances:

```
bounties.verdikta.org (Mainnet)
├── Client: localhost:5173 (VITE_NETWORK=base)
└── API:    localhost:5005 (NETWORK=base)

bounties-testnet.verdikta.org (Testnet)
├── Client: localhost:5174 (VITE_NETWORK=base-sepolia)
└── API:    localhost:5006 (NETWORK=base-sepolia)
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

## Starting Services

Use the parameterized scripts to start/stop services:

```bash
# Start both networks (default)
./server/startServer.sh
./client/startClient.sh

# Start specific network
./server/startServer.sh base
./client/startClient.sh base-sepolia

# Stop all
./server/stopServer.sh
./client/stopClient.sh
```

## Notes

- These are base HTTP configurations. Certbot will add SSL settings automatically.
- Ensure DNS records point to the server before running Certbot.
- The server IP is currently `134.199.203.20`.
