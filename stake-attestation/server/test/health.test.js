import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createApp } from '../src/app.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /health answers 200 with the service name and version', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { status: 'ok', service: 'stake-attestation-server', version });
});

test('unknown routes are 404 and the server does not advertise Express', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-powered-by'), null);
});
