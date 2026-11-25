# TODO — example-bounty-program

## API availability / DoS hardening (from external report, verified in code 2026-11-11)

**Target: part of the hardening work before the next major release.**

Context: an outside reporter claimed a public, unauthenticated, un-rate-limited
endpoint can degrade or take down the API at zero on-chain cost. The report named
no endpoint. Code review confirmed the general claim; no live load test was run.

Findings:
- No `limit_req` / `limit_conn` anywhere in `deploy/nginx/*` or live `/etc/nginx`.
- Only anonymous `GET /api/jobs/:id` (+ `/onchain-status`) is rate-limited
  (60/min/IP, `server/middleware/clientIdentification.js`). Everything in
  `PUBLIC_PATHS` is open and unthrottled.
- `POST /api/bots/register` hands out unlimited free keys, and keyed requests are
  never throttled, so "authenticated" endpoints are effectively open too.
- Severity: mostly availability. Finalize, `closeFailedRound` and close have no
  on-chain expiry and can be sent directly to the contract, so an outage delays
  them but loses no funds. On v2 some steps ARE time-boxed, though anyone can
  send them directly too: the draw (the seed must be stored within 8,191 blocks,
  about 27 minutes, and the jury drawn within a day, or the round is cancelled
  and its prepay goes to the aggregator's arbiter pool), `closeCommits` / `promote`
  before the round's deadline (else the unspent prepay goes to the committers, not back), a
  re-run within its 2-hour window, and the creator approval window (creators can
  approve on-chain directly). An outage of the server's round keeper therefore
  can cost hunters prepay if nobody else sends those steps.

Tasks:

- [ ] **nginx rate limiting.** Add `limit_req_zone`s and apply them to `/api/`,
      `/r/`, `/og/`, with a tight zone (e.g. a few/hour/IP) on
      `= /api/bots/register`. Return 429. Update `deploy/nginx/*` AND mirror the
      change into the live `/etc/nginx` config (they must stay in sync), then
      `nginx -t` + reload. Biggest single win.
- [ ] **Cache receipt / OG responses.** `/og/receipt/:job/:sub.png|.svg` and
      `/r/:job/:sub` (`server/routes/receiptRoutes.js`) make 2 RPC reads
      (getBounty + getSubmission) + an ETH-price lookup + a sharp SVG→PNG render
      per request, with no server-side cache; RPC reads happen before the
      paid-winner 404 check, so rotating submissionIds on any real bounty
      amplifies load and burns RPC quota. Add an in-memory LRU keyed by
      `jobId:submissionId` (cache paid receipts long, negatives briefly), and/or
      nginx `proxy_cache` on `/og/`.
- [ ] **Bot registry hardening.** `server/routes/botRoutes.js` appends to
      `data/bots.json` with a synchronous full-file rewrite per registration, and
      `clientIdentification.js` `loadBots()` does a synchronous read + JSON.parse
      of the whole file on EVERY bot-keyed request (679 bots / 244 KB as of
      2026-11-11). Registration spam grows it without bound and the degradation
      persists after the attack. Fix: keep the registry in memory (load once,
      index by apiKey, write-through on change); cap registrations per IP (and
      possibly per ownerAddress); consider pruning inactive/unused bots.
- [ ] **Cheaper full-scan public endpoints (lower priority).** `/api/jobs.txt`,
      `/sitemap.xml`, `/feed.xml` (`server/routes/agentRoutes.js`) call
      `jobStorage.listJobs()` on every request. Add a short TTL cache like
      `/api/market-summary` already has.
