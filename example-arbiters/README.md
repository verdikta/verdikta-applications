# Example Arbiters

Peer project to `example-bounty-program` — a scaffold for the Verdikta Arbiters application. Currently a "coming soon" placeholder; ready to grow.

## Layout

```
client/   # Vite + React 19 frontend
server/   # Express API
```

Client and server are fully independent packages. Install and run each in its own terminal.

## Run locally

```bash
# Terminal 1 — server (port 5008)
cd server
npm install
npm run dev

# Terminal 2 — client (port 5175, proxies /api/* to the server)
cd client
npm install
npm run dev
```

Open http://localhost:5175.

## Ports

- Client dev: `5175`
- Server: `5008`

Chosen to avoid collisions with `example-frontend` (5000/3001), `example-bounty-program` (5005–5006/5173), and `example-agents` (5007/5174).

## Notes

- No wallet / blockchain / IPFS code yet. Keep it that way until the feature set demands it.
- Visual theme mirrors `example-bounty-program` (shared CSS variables and components). Keep in sync when the design system evolves.
