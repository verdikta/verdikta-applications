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
