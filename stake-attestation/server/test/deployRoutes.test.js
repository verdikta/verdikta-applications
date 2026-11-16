// The deploy kit's nginx config against the server's own routing (node P23, R1-F1). nginx counts a listing submission in
// its build zone, and gives the listing routes their larger body limit, by path; Express routes a path
// case-insensitively and with or without one trailing slash. So every spelling the server routes to POST /api/listings
// must be one nginx counts, or it would bypass the zone. These send each spelling to the real app and compare.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNginx } from '@verdikta/stake-attestation-shared/deploy-kit';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = parseNginx(fs.readFileSync(path.resolve(here, '..', '..', 'deploy', 'nginx', 'verifiers.verdikta.org.conf'), 'utf8'));

const nginxRegex = (pattern) => {
  const m = /^~(\*?)(.*)$/.exec(pattern);
  assert.ok(m, `a regex: ${pattern}`);
  return new RegExp(m[2], m[1] ? 'i' : '');
};
const buildMap = SITE.find((n) => n.name === 'map' && n.args[0] === '$request_method $uri');
const BUILD = nginxRegex(buildMap.block[0].name);
const https = SITE.find((n) => n.name === 'server' && n.block.some((d) => d.name === 'listen' && d.args[0] === '443' && !d.args.includes('default_server')));
const listingLocation = https.block.find((d) => d.name === 'location' && d.args[0] === '~*');
const LISTING = nginxRegex(`~*${listingLocation.args[1]}`);

// What a client could send, in the forms Express might take for the two listing routes.
const SPELLINGS = [
  '/api/listings', '/api/listings/', '/api/LISTINGS', '/api/Listings/', '/api/lIsTiNgS', '/api/listings//', '/API/listings',
  '/api/listings/challenge', '/api/listings/challenge/', '/api/LISTINGS/CHALLENGE', '/api/Listings/Challenge/',
];

let server;
let base;
const routed = [];

before(async () => {
  const app = createApp({ config: loadConfig({}), builder: {}, scanner: {}, pinner: {}, checkRepository: async () => ({}) });
  app.listings.submit = () => { routed.push('submit'); return { id: 'x', status: 'queued' }; };
  app.listings.challenge = () => { routed.push('challenge'); return {}; };
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function routeOf(pathname) {
  routed.length = 0;
  await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return routed[0] ?? null;
}

test('every spelling the server routes to the listing submission is counted in nginx\'s build zone', async () => {
  const submits = [];
  for (const p of SPELLINGS) {
    if ((await routeOf(p)) !== 'submit') continue;
    submits.push(p);
    // nginx matches its decoded, slash-merged path; none of these needs either
    assert.ok(BUILD.test(`POST ${p}`), `${p} reaches listings.submit but not the build zone`);
  }
  assert.ok(submits.length >= 4, `the server routes several spellings to it: ${submits.join(', ')}`);
});

test('every spelling the server routes to either listing route gets the listing routes\' body limit, and the challenge no build zone', async () => {
  for (const p of SPELLINGS) {
    const route = await routeOf(p);
    if (!route) continue;
    // the /api/ prefix location is case-sensitive: what it does not take never reaches the server
    if (!p.startsWith('/api/')) continue;
    assert.ok(LISTING.test(p), `${p} reaches listings.${route} under the 64 KB limit`);
    if (route === 'challenge') assert.equal(BUILD.test(`POST ${p}`), false, `${p}: a challenge, not a build`);
  }
});
