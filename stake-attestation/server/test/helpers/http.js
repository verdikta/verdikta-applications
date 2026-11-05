// The API on an ephemeral loopback port, with the builder and the pinning backend the test gives.
import { createApp } from '../../src/app.js';
import { createMockPinner } from '../../src/pinning/index.js';
import { MAKER, MAKER_WALLET, testConfig } from './fixtures.js';
import { proofFile } from './gitRepo.js';

const TERMINAL = new Set(['ready', 'refused', 'error']);

/**
 * @param {{ builder: object, pinner?: object, config?: object, logger?: object, scanner?: object, auth?: object, site?: object }} o -
 *   `scanner`: the baseline scan's stand-in (test/helpers/scan.js); `auth`: a wallet sign-in
 *   (src/auth/walletAuth.js) with a clock of the test's; `site`: the indexer's site
 *   (src/site/index.js), for the feed, record and badge routes; `checkRepository`: what git says of a
 *   listing's repository (by default a file naming the request's maker, on main; no host is reached);
 *   `checkDeployment`: a contract's signature on its chain (by default it counts); `env`: where the
 *   workflow backend reads its token
 * @returns {Promise<{ base: string, pinner: object, app: object, close(): Promise<void>, post(path: string, body: unknown): Promise<Response>, get(path: string): Promise<Response>, settle(id: string): Promise<object> }>}
 */
export async function startApi({
  builder,
  pinner = createMockPinner(),
  config = testConfig(),
  logger = quietLogger(),
  scanner,
  auth,
  site,
  checkRepository,
  checkDeployment = site ? undefined : async () => ({ ok: true }),
  env,
}) {
  // by default the project names whoever the last request names as its maker
  let named = MAKER;
  const check = checkRepository ?? (async () => ({ reachable: true, ref: 'refs/heads/main', file: { blob: 'b'.repeat(40), text: proofFile(named), problem: null } }));
  const app = createApp({ config, builder, pinner, logger, scanner, auth, site, checkRepository: check, checkDeployment, env });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const get = (path) => fetch(`${base}${path}`);
  /** POST /api/listings the way a maker does: the challenge for this request, signed by the wallet. */
  const submit = async (body, { wallet = MAKER_WALLET } = {}) => {
    if (body && typeof body.maker === 'string') named = body.maker;
    const c = await post('/api/listings/challenge', body);
    if (c.status !== 200) return c;
    const challenge = await c.json();
    return post('/api/listings', { ...body, auth: { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) } });
  };
  /** Polls GET /api/listings/:id until the listing is ready, refused or in error. */
  const settle = async (id, timeoutMs = 20000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const res = await get(`/api/listings/${id}`);
      const view = await res.json();
      if (TERMINAL.has(view.status)) return view;
      if (Date.now() > until) throw new Error(`listing ${id} still ${view.status} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    base,
    app,
    pinner,
    builder,
    post,
    get,
    submit,
    settle,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A logger that keeps every line, for tests that check what is (never) logged. */
export function quietLogger() {
  const lines = [];
  const keep = (level) => (...args) => lines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  return { lines, info: keep('info'), warn: keep('warn'), error: keep('error'), debug: keep('debug') };
}
