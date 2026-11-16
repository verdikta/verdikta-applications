// The CSP run's web server (node P23; playwright.csp.config.js): what nginx does for the site, for a test. It serves
// the production build from client/dist, sends /api to the stack's server, and puts every header of the deploy kit's
// include file (../deploy/nginx/verifiers.verdikta.org-headers.conf, parsed by shared's parseHeaderInclude, which
// refuses any line it cannot read) on every answer, as nginx's `add_header ... always` does: a page, an asset, an API
// answer, a 404. The one header that differs is the policy, and only as kitHeaders says: its off-origin sources
// (deploy/client.env's RPC endpoint and each of its gateways) mapped to this stack's stand-ins, and a report-uri for
// this run, whose reports it keeps in .e2e/csp-reports.json for the run's teardown (e2e/support/cspTeardown.mjs).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapConnectSources, parseEnvFile, parseHeaderInclude } from '@verdikta/stake-attestation-shared/deploy-kit';

import { parseGateways } from '../../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', '..', 'deploy');
export const REPORT_PATH = '/__csp-report';
const MAX_REPORT_BYTES = 64 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
// hop-by-hop: never passed on by a proxy
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const origin = (u) => new URL(u).origin;
const kitEnv = () => parseEnvFile(fs.readFileSync(path.join(KIT, 'client.env'), 'utf8'));

/** deploy/client.env's gateways, in order, read as the client reads them: the stack starts a stand-in for each. */
export const kitGateways = () => parseGateways(kitEnv().get('VITE_IPFS_GATEWAY'));

/**
 * The policy's off-origin sources and their stand-ins: deploy/client.env's RPC endpoint to `rpcUrl`, and its gateways,
 * in order, to `gatewayUrls`, one stand-in each.
 * @returns {Record<string, string>}
 */
export function standIns({ rpcUrl, gatewayUrls }) {
  const gateways = kitGateways();
  if (gateways.length !== gatewayUrls.length) throw new Error(`deploy/client.env names ${gateways.length} gateways and the stack has ${gatewayUrls.length} stand-ins: one each`);
  const map = { [origin(kitEnv().get('VITE_SA_RPC_URL'))]: origin(rpcUrl) };
  gateways.forEach((g, i) => { map[g] = origin(gatewayUrls[i]); });
  if (new Set(Object.values(map)).size !== Object.keys(map).length) throw new Error('each off-origin source has a stand-in of its own');
  return map;
}

/**
 * The deploy kit's headers for this stack: the include file's, with the policy's RPC endpoint and gateways mapped to
 * `rpcUrl` and `gatewayUrls` (standIns), and a report-uri added. Nothing else of any header changes.
 * @returns {{ name: string, value: string }[]}
 */
export function kitHeaders({ rpcUrl, gatewayUrls }) {
  const headers = parseHeaderInclude(fs.readFileSync(path.join(KIT, 'nginx', 'verifiers.verdikta.org-headers.conf'), 'utf8'));
  if (!headers.every((h) => h.always)) throw new Error('every header of the include file is `always`, so this server puts each on every answer');
  return headers.map(({ name, value }) => {
    if (name !== 'Content-Security-Policy') return { name, value };
    const mapped = mapConnectSources(value, standIns({ rpcUrl, gatewayUrls }));
    return { name, value: `${mapped}; report-uri ${REPORT_PATH}` };
  });
}

/**
 * @param {{ dist: string, port: number, apiUrl: string, headers: { name: string, value: string }[], reportsFile: string }} o
 * @returns {Promise<http.Server>}
 */
export function startHeaderServer({ dist, port, apiUrl, headers, reportsFile }) {
  const root = path.resolve(dist);
  const reports = [];
  fs.writeFileSync(reportsFile, '[]');
  const api = new URL(apiUrl);
  const withHeaders = (res) => { for (const h of headers) res.setHeader(h.name, h.value); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === REPORT_PATH && req.method === 'POST') {
      const parts = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= MAX_REPORT_BYTES) parts.push(c);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
          reports.push(body['csp-report'] ?? body);
        } catch {
          reports.push({ unreadable: true });
        }
        fs.writeFileSync(reportsFile, JSON.stringify(reports, null, 2));
        withHeaders(res);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const upstream = http.request({
        host: api.hostname, port: api.port, method: req.method, path: req.url,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k))),
      }, (up) => {
        for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k)) res.setHeader(k, v);
        withHeaders(res);
        res.statusCode = up.statusCode;
        up.pipe(res);
      });
      upstream.on('error', () => {
        withHeaders(res);
        res.statusCode = 502;
        res.end();
      });
      req.pipe(upstream);
      return;
    }
    withHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    const file = path.resolve(root, `.${rel === '/' ? '/index.html' : rel}`);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('not found');
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
