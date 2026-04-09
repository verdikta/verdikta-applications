# Verdikta Bounty Program — Client

React + Vite frontend for the Verdikta AI-Powered Bounty Program.

## Quick start

```bash
npm install
cp .env.example .env       # then fill in network + contract addresses
npm run dev                # Vite dev server on port 5173
```

The frontend uses a relative `/api` URL — start the server (`../server`) before using the UI.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server (port 5173) |
| `npm run build` | Production bundle to `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run lint` | ESLint |

## Environment

See `.env.example` for the full list. At minimum you need:

- `VITE_NETWORK` — `base-sepolia` or `base`
- `VITE_CLIENT_KEY` — must match `FRONTEND_CLIENT_KEY` on the server
- `VITE_BOUNTY_ESCROW_ADDRESS_*`, `VITE_LINK_TOKEN_ADDRESS_*`, `VITE_VERDIKTA_AGGREGATOR_ADDRESS_*` for the active network

## Project context

For project overview, contract addresses, and architecture, see [../README.md](../README.md).
For commands, conventions, and debugging, see [../DEVELOPER-GUIDE.md](../DEVELOPER-GUIDE.md).
