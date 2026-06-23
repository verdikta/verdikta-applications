# Nginx Configuration

Nginx config for the bounty program. These files are the **source of truth** for
how the live site is served — keep them in sync with `/etc/nginx/sites-available/*`
(the live files are symlinked into `sites-enabled/`).

## Files

- `bounties.verdikta.org` — Production (Base Mainnet), backend on `localhost:5005`
- `bounties-testnet.verdikta.org` — Testnet (Base Sepolia), backend on `localhost:5006`

## Serving model

The client is served as a **static Vite build**, not a dev server:

```
bounties.verdikta.org (Mainnet)
├── Client: STATIC files at client/dist-base/        (built by `vite build --watch`)
└── API:    Express @ localhost:5005 (NETWORK=base)

bounties-testnet.verdikta.org (Testnet)
├── Client: STATIC files at client/dist-base-sepolia/ (built by `vite build --watch`)
└── API:    Express @ localhost:5006 (NETWORK=base-sepolia)
```

nginx serves the static build directly and falls back to `index.html` for clean
React-Router routes. The Vite build-watchers run as systemd services
(`verdikta-bounty-client-{base,testnet}.service`); the API servers are started
via `server/startServer.sh [base|base-sepolia]`.

## Backend allow-list — IMPORTANT, read before adding routes

Because the client is static and nginx only falls back to `index.html`, **every
path that the Express backend serves to a browser or crawler must have an
explicit `location` block here that proxies to the backend.** Anything not
listed is served by the static SPA — so a backend route with no nginx entry
returns the React `NotFound` page (an unhelpful "No page exists at …").

Current backend-served paths (must stay in sync with `server/routes/*`):

| Path                | Backend route (server/…)                          | Why it's not SPA            |
|---------------------|---------------------------------------------------|-----------------------------|
| `/api/`             | all `routes/*` under `/api`                        | JSON API                    |
| `/r/`               | `routes/receiptRoutes.js` `/r/:jobId/:subId[/share]` | server-rendered OG share page |
| `/og/`              | `routes/receiptRoutes.js` `/og/receipt/:id/:sub.{svg,png}` | OG card image            |
| `/agents.txt`       | `routes/agentRoutes.js`                            | agent discovery             |
| `/feed.xml`         | `routes/agentRoutes.js`                            | feed                        |
| `/llms.txt`         | `routes/agentRoutes.js`                            | LLM discovery               |
| `/robots.txt`       | `routes/agentRoutes.js`                            | SEO                         |
| `/sitemap.xml`      | `routes/agentRoutes.js`                            | SEO                         |
| `/health`           | `server.js`                                        | health check                |

Gotcha: `/og/` images end in `.png`/`.svg`, and there's a regex location
(`location ~* \.[a-z0-9]+$`) that tries to serve any extensioned path from disk
(→404). So `/og/` (and `/r/`, for consistency) use the `^~` modifier, which makes
the prefix match win over that regex. Plain `location /og/` would still 404.

**When you add a new browser/crawler-facing Express route, add a matching
`location` to BOTH config files here AND the live `/etc/nginx` files, then
`nginx -t && systemctl reload nginx`.** (`/r/` and `/og/` were missing for a
while and 404'd on the live site precisely because this step was skipped when the
serving model changed from dev-server to static build.)

## Deployment

1. Copy configs to nginx:
   ```bash
   sudo cp deploy/nginx/bounties.verdikta.org /etc/nginx/sites-available/
   sudo cp deploy/nginx/bounties-testnet.verdikta.org /etc/nginx/sites-available/
   ```
2. Enable the sites:
   ```bash
   sudo ln -s /etc/nginx/sites-available/bounties.verdikta.org /etc/nginx/sites-enabled/
   sudo ln -s /etc/nginx/sites-available/bounties-testnet.verdikta.org /etc/nginx/sites-enabled/
   ```
3. Test + reload:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. SSL (certbot rewrites `listen 80` → the 443/SSL block and adds the HTTP→HTTPS redirect):
   ```bash
   sudo certbot --nginx -d bounties.verdikta.org
   sudo certbot --nginx -d bounties-testnet.verdikta.org
   ```

## Notes

- These are HTTP-only base configs; certbot adds SSL automatically.
- The `include .../snippets/verdikta-hardening.conf` and `verdikta-security-headers.conf`
  lines reference host-side snippet files on the live box. Provide equivalents,
  or remove those `include` lines, when recreating on a fresh host.
- Build the client per network before first serve: `cd client && VITE_NETWORK=base npm run build` (output dir is `dist-base` / `dist-base-sepolia`); the systemd watchers then keep it fresh.
- Ensure DNS points at the server before running certbot.
