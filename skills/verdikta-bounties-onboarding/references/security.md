# Security notes (bot wallet)

## Hot-wallet reality
This bot wallet is a hot wallet. Assume compromise is possible. Transactions on Base mainnet and Base Sepolia are irreversible once confirmed, and mistakes can spend gas, lock funds, or publish unwanted metadata.

Recommended practices:
- Keep balances low.
- Start on Base Sepolia and use a fresh bot-only wallet.
- Do not import high-value personal wallets.
- Use a sweep rule (e.g., send excess to cold address daily / when above threshold).
- Store the keystore file with `chmod 600` and outside web roots.

## Key storage
This skill uses an **encrypted JSON keystore** (ethers-compatible).

- The keystore password is never stored by this skill. Scripts take `VERDIKTA_WALLET_PASSWORD` from the process environment, read the mode-600 file named by `VERDIKTA_WALLET_PASSWORD_FILE` if the operator sets one, or prompt without echo. They refuse to run while the stable `.env` still contains the password. See [wallet password](onboarding.md#wallet-password).
- Never hardcode private keys.
- No script in this skill exports or prints raw private keys. Private keys are decrypted in-memory only when signing transactions and are never written to stdout, logs, or files.
- Do not decrypt keys outside the authorized executor to bypass a guard.

## Environment variable scoping
- The skill's `_env.js` loader reads `~/.config/verdikta-bounties/.env` only, for non-secret configuration; it never takes the wallet password from it. The stable path is outside the skill directory so it survives ClawHub updates and repo pulls.
- Already-exported environment variables also work; `dotenv` does not overwrite them.
- It does not read `.env` from the caller's working directory (CWD).
- It intentionally ignores `scripts/.env`. Do not store credentials or endpoint overrides in the skill directory.
- This prevents accidental exposure of unrelated secrets and avoids developer-only endpoint overrides being consumed during production operations.

## API key handling
- The API key is stored locally at `~/.config/verdikta-bounties/verdikta-bounties-bot.json` with `chmod 600`.
- Console output redacts API keys (shows only first 4 + last 4 characters).
- The API key is sent only to the configured `VERDIKTA_BOUNTIES_BASE_URL` as an `X-Bot-API-Key` header.
- The bot registration response can contain the API key and is persisted as durable local credential material. Keep the file out of backups/log captures unless you intend to preserve the credential.

## Network and transaction allowlists
Expected external destinations:

- Verdikta Agent API: `https://bounties.verdikta.org` or `https://bounties-testnet.verdikta.org`
- Base RPC: `https://mainnet.base.org` or `https://sepolia.base.org`, unless explicitly overridden in config

Transaction-capable scripts check:

- RPC/provider chain ID is Base `8453` or Base Sepolia `84532`, matching `VERDIKTA_NETWORK`
- API-provided submission/finalization transactions target the expected escrow contract
- Escrow bytecode and current ABI selectors match the reviewed snapshot; decoded arguments and exact value match intent
- Nonzero ETH value is rejected except for operations where ETH is expected

Use `--dry-run` where available, then `--yes` or `--confirm-spend` only after reviewing the printed action summary.

## Approvals / swap risk
The legacy token-swap script is retired and exits before prompting or loading credentials. Current bounty execution uses ETH prepay.
