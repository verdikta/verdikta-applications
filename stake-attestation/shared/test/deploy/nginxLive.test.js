// The site config against a real nginx (node P23): CI's deploy job installs deploy/nginx as the host has it, with a
// throwaway certificate at certbot's paths, starts nginx and runs this with SA_DEPLOY_NGINX_LIVE=1. Everything else
// skips it. A stub stands where the server listens (127.0.0.1:5009) and answers what it was asked, so these see what
// nginx does to a request: the redirect, the headers on every kind of answer, the proxy, the body limits and the rate
// limits, including that the client's own polling of a listing is never refused.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHeaderInclude } from '../../src/deployKit.js';

const LIVE = process.env.SA_DEPLOY_NGINX_LIVE === '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'verifiers.verdikta.org';
const HEADERS = parseHeaderInclude(fs.readFileSync(path.join(here, '..', '..', '..', 'deploy', 'nginx', `${SITE}-headers.conf`), 'utf8'));
const opts = { skip: !LIVE && 'set SA_DEPLOY_NGINX_LIVE=1 with nginx running the kit (CI\'s deploy job)' };

let stub;
const seen = [];

before(async () => {
  if (!LIVE) return;
  stub = http.createServer((req, res) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, size });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, size }));
    });
  });
  await new Promise((resolve, reject) => {
    stub.once('error', reject);
    stub.listen(5009, '127.0.0.1', resolve);
  });
});

after(() => stub?.close());

/** One request to nginx on this machine, addressed to `host` (TLS with SNI on 443). */
function ask({ port = 443, host = SITE, method = 'GET', pathname = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = port === 443 ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port, method, path: pathname, servername: port === 443 ? host : undefined, rejectUnauthorized: false,
      headers: { host, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers },
      agent: false,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const hasKitHeaders = (res, what) => {
  for (const h of HEADERS) assert.equal(res.headers[h.name.toLowerCase()], h.value, `${what}: ${h.name}`);
};

test('HTTP: the site redirects to HTTPS, certbot\'s challenge is served from its webroot, any other name gets nothing', opts, async () => {
  const r = await ask({ port: 80, pathname: '/record?x=1' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, `https://${SITE}/record?x=1`);
  const acme = await ask({ port: 80, pathname: '/.well-known/acme-challenge/test-token' });
  assert.equal(acme.status, 200);
  assert.equal(acme.body.trim(), 'test-token');
  await assert.rejects(ask({ port: 80, host: 'other.invalid' }), /socket hang up|ECONNRESET/);
  await assert.rejects(ask({ port: 443, host: 'other.invalid' }), /alert|handshake|EPROTO|ECONNRESET|socket hang up/i);
});

test('HTTPS: the page, an asset, an API answer, a 404 and a 413 all carry the include file\'s headers', opts, async () => {
  const page = await ask({ pathname: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['cache-control'], /no-cache/);
  hasKitHeaders(page, '/');
  const asset = await ask({ pathname: '/assets/index-test.js' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers['cache-control'], /max-age=\d{6,}/);
  hasKitHeaders(asset, 'an asset');
  const api = await ask({ pathname: '/api/feed' });
  assert.equal(api.status, 200);
  assert.deepEqual(JSON.parse(api.body), { method: 'GET', url: '/api/feed', size: 0 });
  hasKitHeaders(api, '/api/feed');
  const missing = await ask({ pathname: '/nothing-here' });
  assert.equal(missing.status, 404);
  hasKitHeaders(missing, 'a 404');
  assert.equal(missing.headers.server, 'nginx', 'server_tokens off: no version');
  const big = await ask({ method: 'POST', pathname: '/api/claims/1/dispute-statement', body: JSON.stringify({ statement: 'x'.repeat(100 * 1024) }) });
  assert.equal(big.status, 413);
  hasKitHeaders(big, 'a 413');
});

test('/api is proxied to 127.0.0.1:5009 as it was asked, with the site\'s host; nothing else is', opts, async () => {
  seen.length = 0;
  const r = await ask({ method: 'POST', pathname: '/api/listings/deployment-message', body: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { method: 'POST', url: '/api/listings/deployment-message', size: 7 });
  assert.equal(seen[0].headers.host, SITE);
  assert.equal(seen[0].headers['x-forwarded-proto'], 'https');
  const health = await ask({ pathname: '/health' });
  assert.equal(health.status, 404, 'the server\'s /health stays on loopback');
  assert.equal(seen.length, 1);
});

test('the listing routes take a draft of more than the server\'s 1 MB, so the server answers its own 413, in any spelling it routes', opts, async () => {
  for (const pathname of ['/api/listings/challenge', '/api/Listings/Challenge/']) {
    const r = await ask({ method: 'POST', pathname, body: JSON.stringify({ spec: 'x'.repeat(1536 * 1024) }) });
    assert.equal(r.status, 200, pathname);
    assert.ok(JSON.parse(r.body).size > 1536 * 1024);
  }
});

test('the client\'s own polling of a listing is never refused: every 500 ms for 10 s, with a page load\'s burst first', opts, async () => {
  const burst = await Promise.all([ask({ pathname: '/api/feed' }), ask({ pathname: '/api/records/0x' + '1'.repeat(64) }), ask({ pathname: '/api/records/0x' + '1'.repeat(64) + '/badge.svg' })]);
  for (const r of burst) assert.equal(r.status, 200);
  for (let i = 0; i < 20; i++) {
    const r = await ask({ pathname: `/api/listings/${'a'.repeat(32)}` });
    assert.equal(r.status, 200, `poll ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

test('listing submissions: a few at once, then 429; and the other POSTs (challenges, proofs, pins) a few more, then 429', opts, async () => {
  // the server routes these spellings to the submission (server/test/deployRoutes.test.js), and nginx reads // as one
  // slash: one zone for all of them
  const spellings = ['/api/listings', '/api/listings', '/api/listings', '/api/listings/', '/api/LISTINGS', '/api/Listings/', '/api//listings'];
  const submits = [];
  for (const pathname of spellings) submits.push((await ask({ method: 'POST', pathname, body: '{}' })).status);
  assert.deepEqual(submits.slice(0, 2), [200, 200], `the burst passes first: ${submits}`);
  assert.ok(submits.slice(3).every((s) => s === 429), `then every spelling is refused, the zone's: ${submits}`);
  const work = [];
  for (let i = 0; i < 20; i++) work.push((await ask({ method: 'POST', pathname: '/api/claims/1/dispute-statement/challenge', body: '{}' })).status);
  assert.ok(work.includes(429), `POSTs: ${work}`);
  assert.ok(work.indexOf(429) >= 4, `a maker's session of POSTs passes first: ${work}`);
  // a GET is never counted against the POST zones
  assert.equal((await ask({ pathname: `/api/listings/${'b'.repeat(32)}` })).status, 200);
});

test('a flood of GETs is refused with 429 once past the general zone\'s burst', opts, async () => {
  // the POSTs above went through the general zone too: let its bucket drain (30 at 5 a second) first
  await new Promise((resolve) => setTimeout(resolve, 7000));
  const answers = await Promise.all(Array.from({ length: 80 }, () => ask({ pathname: '/api/feed' })));
  const refused = answers.filter((r) => r.status === 429);
  assert.ok(refused.length > 0, 'some refused');
  assert.ok(answers.filter((r) => r.status === 200).length >= 30, 'the burst served');
  hasKitHeaders(refused[0], 'a 429');
});
