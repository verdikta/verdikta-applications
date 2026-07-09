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

- The encryption password should be provided via env var (e.g., `VERDIKTA_WALLET_PASSWORD`).
- Never hardcode private keys.
- No script in this skill exports or prints raw private keys. Private keys are decrypted in-memory only when signing transactions and are never written to stdout, logs, or files.
- If you need to use the key outside this skill, decrypt the keystore programmatically using `ethers.Wallet.fromEncryptedJson()`.

## Environment variable scoping
- The skill's `_env.js` loader reads `~/.config/verdikta-bounties/.env` only. The stable path is outside the skill directory so it survives ClawHub updates and repo pulls.
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
- Optional 0x swap API: `https://api.0x.org` on mainnet only

Transaction-capable scripts check:

- RPC/provider chain ID is Base `8453` or Base Sepolia `84532`, matching `VERDIKTA_NETWORK`
- API-provided submission/finalization transactions target the expected escrow contract
- API-provided LINK approval transactions target the configured LINK token
- Nonzero ETH value is rejected except for operations where ETH is expected

Use `--dry-run` where available, then `--yes` or `--confirm-spend` only after reviewing the printed action summary.

## Approvals / swap risk
Swapping ETH→LINK requires signing a transaction with calldata provided by a DEX aggregator.

Mitigations:
- Prefer not to swap unless the active backend requires LINK.
- Only use known endpoints (0x API) and correct chainId.
- Set strict slippage.
- Limit swap size.
- Validate token addresses, transaction value, and quote recipient before signing.
- Custom 0x endpoints require explicit `--allow-custom-0x`.
