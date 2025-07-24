## Verdikta Simple Frontend

### Overview

Verdikta Simple Frontend is a reference web application that showcases how to interact with the Verdikta on‑chain AI‑jury protocol.  It lets a user:

1. Define a **question / dispute** with a set of mutually exclusive **outcomes**.
2. Bundle supporting evidence into a **query package** (ZIP archive) that is uploaded to IPFS.
3. Choose an **AI jury** (set of models or nodes) and submit the request to the **Verdikta Aggregator** smart‑contract running on **Base Sepolia**.
4. Poll the chain until the Chainlink job fulfils the request, then fetch and render the **result vector** and the **AI‑generated justification**.

This repository contains:

* **client/** – React 18 SPA powered by `ethers.js`.
* **server/** – Minimal Express API that uploads files to IPFS (via Pinata) and persists contract metadata.

> ⚠️ This project is meant for **local development and demonstration**.  **Do not** deploy to production without a proper security review.

---

### Tech‑stack

| Layer      | Tech                                             |
|------------|--------------------------------------------------|
| Front‑end  | React 18 · React Router · Chart.js · Ethers v6    |
| Back‑end   | Node 20 · Express 4 · @verdikta/common            |
| Blockchain | Base Sepolia test‑net · Chainlink Functions       |
| Storage    | IPFS                                             |

---

## Project structure

```text
.
├─ client/                 # React SPA (Create‑React‑App)
│  ├─ src/
│  │  ├─ pages/            # Main wizard‑style pages
│  │  ├─ components/       # Re‑usable presentational comps
│  │  ├─ services/         # Browser-compatible verdikta-common wrapper
│  │  └─ utils/            # Pure helpers & blockchain utils
│  └─ public/
│
├─ server/                 # Express API + utility scripts
│  ├─ routes/              # REST endpoints (file & contract mgmt)
│  ├─ utils/               # JSON persistence, graceful shutdown
│  └─ tmp/                 # Runtime upload buffer (git‑ignored)
├─ start.sh                # Combined startup script for both services
├─ test-startup.sh         # Test script for validation
└─ README.md               # ← you are here
```

*The smart‑contracts live in a dedicated Solidity repo and are **not** part of this project.*

---

## Quick start

### 1. Prerequisites

* **Node.js ≥ 18** and **npm ≥ 9** (or `pnpm`/`yarn`).
* A **MetaMask** wallet connected to **Base Sepolia** with a small amount of test ETH & LINK.
* A **Pinata** account (or any IPFS pinning service) to obtain a JWT token.

### 2. Clone & install

```bash
# clone
$ git clone https://github.com/verdikta/verdiktaSimpleFrontend.git
$ cd verdiktaSimpleFrontend

# client dependencies
$ cd client && npm install
# server dependencies
$ cd ../server && npm install
```

### 3. Environment variables

Create `.env` files from the provided templates and fill in the blanks:

```bash
# client/.env
cp client/.env.example client/.env

# server/.env
cp server/.env.example server/.env
```

Key variables:

| File          | Variable                       | Description                                  |
|---------------|--------------------------------|----------------------------------------------|
| client/.env   | `REACT_APP_CONTRACT_ADDRESSES` | Comma‑separated list of Verdikta contract addresses. |
|               | `REACT_APP_CONTRACT_NAMES`     | Human‑readable labels in the same order.     |
|               | `REACT_APP_CONTRACT_CLASSES`   | Comma-separated list of class values (0-99999, default 128) for each contract, in the same order as addresses/names. |
|               | `REACT_APP_SERVER_URL`         | URL where the Express API is reachable.      |
| server/.env   | `PORT`                         | Port for the API (defaults to `5000`).       |
|               | `IPFS_PINNING_SERVICE`         | Base URL of your pinning provider.           |
|               | `IPFS_PINNING_KEY`             | **JWT** token for the above provider.        |

### 4. Run in development mode

#### Option A: Quick start (recommended)

Use the combined startup script from the project root:

```bash
# Start both client and server with one command
$ ./start.sh
```

This will:
- Start the server on `http://localhost:5000` 
- Start the client on `http://localhost:3000`
- Provide colored status output
- Allow graceful shutdown with `Ctrl+C`

#### Option B: Manual start (advanced)

Open **two** terminals for individual control:

```bash
# Terminal 1 – start the API
$ cd server
a) cp .env.example .env  # if not done yet
b) npm run dev           # nodemon will watch & restart

# Terminal 2 – start the React app
$ cd client
a) cp .env.example .env  # if not done yet
b) npm start             # CRA will serve on http://localhost:3000
```

The client proxies API calls to `http://localhost:5000` by default (configure via `REACT_APP_SERVER_URL`).  When both services are up you can navigate to the React app and follow the wizard.

---

## Typical workflow

1. **Query Definition** – Write the question and enumerate possible outcomes.
2. **Jury Selection** – Choose which AI nodes / models will deliberate and set runtime parameters.
3. **Run Query** – Build or upload a query package and submit the on‑chain transaction.
4. **Results** – Once the Chainlink oracle fulfils the request the result vector is displayed alongside the justification markdown.

Each step corresponds to a page in `client/src/pages/*` and local‑storage keeps draft data so you can navigate back & forth.

---

## NPM scripts

| Location | Script   | Purpose                                   |
|----------|----------|-------------------------------------------|
| client   | `npm start`  | Development server (CRA)                |
|          | `npm test`   | Jest + React‑Testing‑Library            |
|          | `npm run build` | Production build to `client/build/` |
| server   | `npm run dev`   | Run API with `nodemon` watch          |
|          | `npm start`    | Run API with Node                     |

Small helper shells are included at root of each package: `startClient.sh`, `startServer.sh`, `killold3001.sh`.

**New in this version:** A combined startup script `start.sh` at the project root launches both services simultaneously.

---

## Production deployment

1. Build the React app:
   ```bash
   cd client && npm run build
   ```
2. Serve `client/build` via **Nginx**, **Vercel**, **Netlify** or any static host.
3. Deploy the Express API on **Render**, **Heroku**, **Fly.io** or your own server.
4. Point `REACT_APP_SERVER_URL` to the deployed API and rebuild/redeploy the front‑end if needed.

For containerised deployments create a Dockerfile per package or leverage multi‑stage builds.

---

## Testing

* Front‑end uses **Jest** & **@testing‑library/react** (`npm test`).
* Back‑end currently has no automated tests – PRs welcome 🤝.

---

## Troubleshooting

* **`MetaMask RPC Error: chainId`** – ensure you added **Base Sepolia** (chainId `84532`).  The app will attempt to prompt MetaMask automatically.
* **IPFS upload fails** – verify your `IPFS_PINNING_KEY` JWT is valid and the server can reach the pinning service.
* **Contract mismatch** – the server keeps a copy of contracts in `server/data/contracts.json`.  It is auto‑synced with the **client** `.env`.  Delete the JSON file if you change addresses and restart the server.

---

## Contributing

1. Fork the repo & create a feature branch (`git checkout -b feature/my‑idea`).
2. Adhere to the existing coding style – run `npm run lint` if you add ESLint.
3. Include **tests** and **documentation** for any new feature.
4. Submit a clear Pull‑Request describing **what** and **why**.

We follow the [Conventional Commits](https://www.conventionalcommits.org/) spec for commit messages.

---

## License

This repository is released under the **MIT License** – see [`LICENSE`](LICENSE) for details.

---

### Acknowledgements

* [Chainlink](https://chain.link/) for oracle infrastructure.
* [Pinata](https://www.pinata.cloud/) for IPFS pinning.
* [Base](https://base.org/) for the L2 network.
* All open‑source packages that made this project possible. 