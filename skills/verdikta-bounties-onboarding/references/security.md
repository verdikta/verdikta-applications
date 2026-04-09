# Security notes (bot wallet)

## Hot-wallet reality
This bot wallet is a hot wallet. Assume compromise is possible.

Recommended practices:
- Keep balances low.
- Use a sweep rule (e.g., send excess to cold address daily / when above threshold).
- Store the keystore file with `chmod 600` and outside web roots.

## Key storage
This skill uses an **encrypted JSON keystore** (ethers-compatible).

- The encryption password should be provided via env var (e.g., `VERDIKTA_WALLET_PASSWORD`).
- Never hardcode private keys.
- No script in this skill exports or prints raw private keys. Private keys are decrypted in-memory only when signing transactions and are never written to stdout, logs, or files.
- If you need to use the key outside this skill, decrypt the keystore programmatically using `ethers.Wallet.fromEncryptedJson()`.

## Environment variable scoping
- The skill's `_env.js` loader only reads `.env` from the `scripts/` directory (next to the scripts).
- It does **not** read `.env` from the caller's working directory (CWD).
- This prevents accidental exposure of unrelated secrets if scripts are run from other directories.

## API key handling
- The API key is stored locally at `~/.config/verdikta-bounties/verdikta-bounties-bot.json` with `chmod 600`.
- Console output redacts API keys (shows only first 4 + last 4 characters).
- The API key is sent only to the configured `VERDIKTA_BOUNTIES_BASE_URL` as an `X-Bot-API-Key` header.

## Approvals / swap risk
Swapping ETH→LINK requires signing a transaction with calldata provided by a DEX aggregator.

Mitigations:
- Only use known endpoints (0x API) and correct chainId.
- Set strict slippage.
- Limit swap size.
- Consider allowlisting token addresses.

