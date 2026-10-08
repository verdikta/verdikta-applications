'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { Store } = require('../store');
const { install } = require('../index');
test('dead PID lock is reclaimed safely', (testContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-'));
  fs.writeFileSync(path.join(directory, 'writer.lock'), '2147483647');
  const store = new Store(directory, 'policy', { isAlive: () => false });
  assert.equal(fs.readFileSync(store.lock, 'utf8'), String(process.pid));
  testContext.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
test('live PID disables only campaign, keeping the bounty API operational', async (testContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-'));
  const owner = new Store(directory, 'policy');
  testContext.after(() => {
    owner.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const app = express();
  const secret = 'x'.repeat(32);
  assert.doesNotThrow(() =>
    install(
      app,
      { stateDirectory: directory, policyHash: 'policy' },
      'http://unused.invalid',
      secret,
    ),
  );
  app.get('/api/jobs', (incoming, response) => response.json({ ok: true }));
  assert.equal((await request(app).get('/api/jobs')).status, 200);
  assert.equal((await request(app).get('/api/campaign/health')).status, 503);
  const result = await request(app)
    .post('/api/campaign/verify')
    .set('X-Api-Key', secret)
    .send({});
  assert.equal(result.status, 400);
  assert.match(result.body.message, /\[VERIFICATION_UNAVAILABLE_RETRY\]$/);
  assert.equal(fs.readFileSync(owner.lock, 'utf8'), String(process.pid));
});
test('invalid config, corrupt state and unwritable directory never escape installation', async () => {
  for (const source of [
    () => {
      throw Error('config JSON contains secret');
    },
    { stateDirectory: '/dev/null/not-a-directory', policyHash: 'policy' },
  ]) {
    const app = express();
    assert.doesNotThrow(() => install(app, source, null, 'x'.repeat(32)));
    assert.equal((await request(app).get('/api/campaign/health')).status, 503);
  }
});
