# Nginx Configuration

This directory contains Nginx configuration files for the bounty program application.

## Files

- `bounties.verdikta.org` - Production bounty program
- `bounties-testnet.verdikta.org` - Testnet bounty program

Both configurations proxy to the same backend services:
- Frontend (Vite): `localhost:5173`
- Backend API: `localhost:5005`

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

## Notes

- These are base HTTP configurations. Certbot will add SSL settings automatically.
- Ensure DNS records point to the server before running Certbot.
- The server IP is currently `134.199.203.20`.
