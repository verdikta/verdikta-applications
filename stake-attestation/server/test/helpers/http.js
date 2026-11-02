// The API on an ephemeral loopback port, with the builder and the pinning backend the test gives.
import { createApp } from '../../src/app.js';
import { createMockPinner } from '../../src/pinning/index.js';
import { testConfig } from './fixtures.js';

const TERMINAL = new Set(['ready', 'refused', 'error']);

/**
 * @param {{ builder: object, pinner?: object, config?: object, logger?: object, site?: object }} o - `site`: the
 *   indexer's site (src/site/index.js), for the feed, record and badge routes
 * @returns {Promise<{ base: string, pinner: object, app: object, close(): Promise<void>, post(path: string, body: unknown): Promise<Response>, get(path: string): Promise<Response>, settle(id: string): Promise<object> }>}
 */
export async function startApi({ builder, pinner = createMockPinner(), config = testConfig(), logger = quietLogger(), site }) {
  const app = createApp({ config, builder, pinner, logger, site });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const get = (path) => fetch(`${base}${path}`);
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
    post,
    get,
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
