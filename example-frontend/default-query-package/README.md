# Default query package

Source of the query package the example frontend offers by default on the Run
Query page ("Use IPFS CID"). The archive is these three files, zipped:

| File | Role |
|------|------|
| `manifest.json` | Jury, iterations, and the list of supporting files |
| `primary_query.json` | The query and its two outcomes |
| `contractTestCode.sol` | The supporting file the query refers to |

The query, outcomes and supporting file are byte for byte those of the archive
this package replaces, `QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH`. Only
the jury differs:

| | Old archive | This package |
|---|---|---|
| OpenAI, weight 0.5 | `gpt-4o` | `gpt-5.2-2025-12-11` |
| Anthropic, weight 0.5 | `claude-3-5-sonnet-20241022` (retired) | `claude-haiku-4-5-20251001` |

Both new models are in class 128's pool in every `@verdikta/common` release from
1.6.0 (the version `server/package-lock.json` pins) to 1.8.0 (the latest, which
the server's `prestart` step installs); neither old one is in any of them.
`claude-sonnet-4-5-20250929` was not chosen because class 128 lists it in 1.6.0
only: 1.7.0 and 1.8.0 dropped it.

## Changing the package

An IPFS archive is immutable, so any change here needs a new archive, a new pin
and a new CID in the client. From `example-frontend/server`:

```bash
npm test                                        # jury is in class 128's pool, archive is reproducible
node scripts/default-query-package.js build     # writes default-query-package.zip, prints the expected CID
node scripts/default-query-package.js pin       # builds, pins, prints the pinned CID
```

`pin` uses the pinning service and key the server's upload endpoint uses
(`IPFS_PINNING_SERVICE`, `IPFS_PINNING_KEY`, from the environment or
`server/.env`). The archive is built identically on every machine, so `pin`
fails if the service returns a CID other than the one `build` prints.

Then set `DEFAULT_QUERY_CID` in `client/src/pages/RunQuery.js` to the pinned CID.

Use only models the class lists: an arbiter answers a request only when every
juror answered, so one retired model leaves the whole request without a verdict.
