# Campaign verifier exceptions (production)

`campaign-production-exceptions.json` is the live exceptions file for the Bring a Task, Build a Habit verifier (format: `server/campaign/exceptions.example.json`; semantics: `server/campaign/OPERATIONS.md`, section "Exceptions and identity releases").

Install on the Base bounty server:

```bash
sudo install -o <service-user> -g <service-group> -m 600 \
  example-bounty-program/deploy/campaign/campaign-production-exceptions.json \
  /etc/verdikta/campaign-production-exceptions.json.tmp
sudo mv /etc/verdikta/campaign-production-exceptions.json.tmp /etc/verdikta/campaign-production-exceptions.json
```

The verifier rereads the file on every reconcile cycle; no restart is needed. Confirm `GET /api/campaign/health` stays `READY` afterwards (an invalid file holds all verification with `EXCEPTIONS_FILE_INVALID`).

## 2026-10-16: sybil ring, bounties 206–235

29 minimum-size bounties created on 15 October 2026 (07:14–12:26 UTC) by 26 wallets, each with one submission paid to another ring wallet in swapped creator/hunter pairs. The verifier's rules were satisfied (new creator, non-team hunter, minimum funding), and the ring claimed all Q4 and Q9 cash on Zealy. This file holds the 26 wallets (`WALLET_HELD_FOR_REVIEW` on every quest) and denies the 30 bounty keys 206–235 (`BOUNTY_DENIED`). Evidence and the wallet-to-account mapping are kept with the campaign records outside this repository.
