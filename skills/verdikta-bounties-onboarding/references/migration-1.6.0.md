# Migrating to 1.6.0

1.6.0 addresses ClawHub's security review of 1.4.3. Existing operators must migrate before any script runs again.

## The wallet password leaves `.env`

Before 1.6.0, onboarding saved `VERDIKTA_WALLET_PASSWORD` in plaintext in `~/.config/verdikta-bounties/.env`, beside the keystore it unlocks. 1.6.0 never stores it. Scripts read it from their environment, from a password file you name with `VERDIKTA_WALLET_PASSWORD_FILE`, or from a no-echo prompt, and never from the `.env`. Every script now stops with a message while that line is present.

1. Put the password in a secret store, or choose a path for a password file outside the skill (for example `~/.config/verdikta-secrets/wallet-password`).
2. Run one of these from `scripts/`:
   - `node onboard.js --migrate-password --to-file ~/.config/verdikta-secrets/wallet-password` writes the password to a new mode-600 file outside the configuration directory, records `VERDIKTA_WALLET_PASSWORD_FILE` for the scripts, then removes the password from `.env`.
   - `node onboard.js --migrate-password`, for when the password is already in your secret manager. It asks you to type it, without echo (or reads `VERDIKTA_WALLET_PASSWORD` if exported), and removes the stored copy only if the two match.

   In both cases the stored password must unlock the keystore first. If any check fails, nothing is changed.
3. If you did not use `--to-file`, configure the runtime to supply `VERDIKTA_WALLET_PASSWORD` (see [wallet password](onboarding.md#wallet-password)). OpenClaw can inject it from a SecretRef on `skills.entries.verdikta-bounties-onboarding.apiKey`, but not into the shells of Codex-harness agents: use the password file for those. Run `openclaw secrets audit --check` afterwards.
4. Delete backups or copies of the old `.env`: they still contain the password.

## Other changes

- The bot API key goes only to the network's reviewed API origin from `deployments.json`. `VERDIKTA_BOUNTIES_BASE_URL` is optional, and any other value is refused. Onboarding no longer asks for a custom URL and replaces one left in `.env`.
- Passwords and pasted private keys are no longer echoed in the terminal.
- Onboarding prints the read-only job-listing command instead of running it.
- `dotenv` and `ethers` are pinned to exact versions; install with `npm ci --ignore-scripts`.
