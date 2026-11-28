/** Security: ethers error messages embed the RPC URL (with its key); responses must not. */
const express = require('express');
const request = require('supertest');

describe('redactJsonResponses', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('scrubs the RPC URL key and secret env values from an error response', async () => {
    process.env.RPC_URL = 'https://base-sepolia.infura.io/v3/0123456789abcdef0123456789abcdef';
    process.env.IPFS_PINNING_KEY = 'eyJhbGciOiJIUzI1NiJ9.pinata-secret-jwt';
    const { redactJsonResponses } = require('../utils/redactSecrets');
    const app = express();
    app.use(redactJsonResponses);
    app.get('/x', (req, res) => res.status(503).json({
      details: `server response 401 Unauthorized (info={ "requestUrl": "${process.env.RPC_URL}" }) jwt=${process.env.IPFS_PINNING_KEY}`,
      alchemy: 'https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    }));
    const res = await request(app).get('/x');
    expect(res.status).toBe(503);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/0123456789abcdef0123456789abcdef/);
    expect(text).not.toMatch(/pinata-secret-jwt/);
    expect(text).not.toMatch(/AbCdEfGhIjKlMnOpQrStUvWxYz012345/);
    expect(text).toMatch(/\[redacted\]/);
  });

  it('leaves ordinary responses alone', async () => {
    const { redactJsonResponses } = require('../utils/redactSecrets');
    const app = express();
    app.use(redactJsonResponses);
    app.get('/y', (req, res) => res.json({ jobId: 5, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }));
    expect((await request(app).get('/y')).body).toEqual({ jobId: 5, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
  });
});

describe('redaction leaves submitted content intact (sec5 fix review)', () => {
  const { redact } = require('../utils/redactSecrets');

  it('does not rewrite base64 that happens to contain "/v2/" (a binary file served by /content)', () => {
    // 4 chars "/v2/" then 24+ base64 chars: about half of all 10 MiB random binaries hold such a run
    const b64 = `AAAA/v2/${'Q'.repeat(40)}+BBBB`;
    expect(redact(JSON.stringify({ file: { content: b64 } }), [])).toBe(JSON.stringify({ file: { content: b64 } }));
  });

  it('does not rewrite a query string in ordinary text', () => {
    const text = 'see the code: fetch(`/api?token=${t}`) and https://example.com/docs/v2/abcdefghijklmnopqrstuvwxyz0123';
    expect(redact(text, [])).toBe(text);
  });

  it('still scrubs provider URLs quoted without the configured value', () => {
    const s = redact('a https://base-mainnet.infura.io/v3/0123456789abcdef0123456789abcdef b ' +
      'https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345 c ' +
      'https://api.basescan.org/api?module=x&apikey=SECRETSECRET d', []);
    expect(s).not.toMatch(/0123456789abcdef0123456789abcdef|AbCdEfGhIjKlMnOpQrStUvWxYz012345|SECRETSECRET/);
  });
});

describe('redaction runs in linear time (review 2026-11-27, item 3)', () => {
  const { redact } = require('../utils/redactSecrets');

  it('a 2 MB file of "http://x" does not hold the event loop', () => {
    const body = JSON.stringify({ content: 'http://x'.repeat(250000) });
    const t = Date.now();
    expect(redact(body, [])).toBe(body);
    expect(Date.now() - t).toBeLessThan(1000);   // was minutes: quadratic in the body length
  });

  it('still scrubs every key parameter of a long query string', () => {
    const s = redact('https://h.example/p?a=1&apikey=AAAA1111&b=2&token=BBBB2222 and https://h.example/q?key=CCCC3333', []);
    expect(s).not.toMatch(/AAAA1111|BBBB2222|CCCC3333/);
    expect(s).toContain('a=1');
    expect(s).toContain('b=2');
  });
});
