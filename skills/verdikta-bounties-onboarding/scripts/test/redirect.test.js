// The bot API key travels in X-Bot-API-Key, a custom header that fetch keeps on a cross-origin redirect (it strips
// only Authorization and cookies). Every keyed request therefore refuses redirects, so a redirect cannot hand the key
// to another origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });

test('getSupportedModelsForClass does not follow a redirect with the bot API key', async () => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-home-'));
  const { getSupportedModelsForClass } = await import('../_lib.js');
  const seen = [];
  const evil = await listen((req, res) => { seen.push(req.headers['x-bot-api-key']); res.end('{"models":[]}'); });
  const site = await listen((req, res) => { res.writeHead(302, { Location: `http://localhost:${evil.address().port}/steal` }); res.end(); });
  try {
    await assert.rejects(getSupportedModelsForClass(`http://127.0.0.1:${site.address().port}`, 'bot-secret-key-123', 128));
    assert.deepEqual(seen, [], 'the key reached the redirect target');
  } finally { site.close(); evil.close(); }
});

test('every keyed or registration fetch in the scripts refuses redirects', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname) + '/..';
  for (const file of ['_lib.js', 'onboard.js', 'bot_register.js', 'preflight.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const calls = [...src.matchAll(/await fetch\(([\s\S]*?)\);/g)].map((m) => m[1]);
    assert.ok(calls.length, file);
    for (const call of calls) assert.match(call, /redirect: 'error'/, `${file}: ${call.slice(0, 80)}`);
  }
});
