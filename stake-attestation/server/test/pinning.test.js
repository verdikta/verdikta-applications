// Acceptance 3 (node P4a), the pinning half: both archives are pinned behind config, to a mock
// store or a local kubo in development and to Pinata or Filebase by environment, and the
// credentials come from the environment only. No test reaches Pinata or Filebase: the real
// backends run against local doubles on 127.0.0.1, through a fetch that refuses any other host.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { codeReview } from '../src/common.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createMockPinner, createPinner, rawCid } from '../src/pinning/index.js';
import { fakeBuilder, listingRequest, testConfig } from './helpers/fixtures.js';
import { quietLogger, startApi } from './helpers/http.js';

const TOKEN = `tok_${crypto.randomBytes(24).toString('hex')}`;

/** fetch that refuses every host but loopback: a test can never reach a real pinning service. */
async function loopbackFetch(url, init) {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') throw new Error(`test fetch refused ${u.origin}`);
  return fetch(url, init);
}

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/** A local HTTP double: `handler(req, body) => { status, json }`; every request is kept. */
async function double(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = await handler(req, body);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** The payload a multipart upload carried (the first part's body). */
function multipartFile(req) {
  const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1];
  const text = req.body.toString('latin1');
  const part = text.split(`--${boundary}`)[1];
  return Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n')), 'latin1');
}

/** A kubo RPC double that adds the upload as one raw block and answers its CID. */
function kuboDouble({ answer } = {}) {
  return double((req, body) => {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'POST' || u.pathname !== '/api/v0/add') return { status: 404, json: { Message: 'not found' } };
    const bytes = multipartFile({ headers: req.headers, body });
    return { json: { Name: 'archive.zip', Hash: answer ?? rawCid(bytes), Size: String(bytes.length) } };
  });
}

describe('config: which backend, and where its credential lives', () => {
  test('development defaults to the mock store; production must name a real backend', () => {
    assert.equal(loadConfig({}).pinning.backend, 'mock');
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (e) => e instanceof ConfigError && /SA_PINNING/.test(e.message));
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SA_PINNING: 'mock' }), ConfigError);
    assert.throws(() => loadConfig({ SA_PINNING: 'ipfs.example' }), ConfigError);
  });

  test('kubo is a local daemon with no credential; Pinata and Filebase need theirs from the environment', () => {
    assert.deepEqual(loadConfig({ SA_PINNING: 'kubo' }).pinning, { backend: 'kubo', url: 'http://127.0.0.1:5001', tokenEnv: null, timeoutMs: 60000 });
    assert.throws(() => loadConfig({ SA_PINNING: 'pinata' }), (e) => /SA_PINATA_JWT/.test(e.message));
    assert.throws(() => loadConfig({ SA_PINNING: 'filebase' }), (e) => /SA_FILEBASE_TOKEN/.test(e.message));
    const pinata = loadConfig({ SA_PINNING: 'pinata', SA_PINATA_JWT: TOKEN });
    assert.deepEqual(pinata.pinning, { backend: 'pinata', url: 'https://api.pinata.cloud', tokenEnv: 'SA_PINATA_JWT', timeoutMs: 60000 });
    const filebase = loadConfig({ SA_PINNING: 'filebase', SA_FILEBASE_TOKEN: TOKEN });
    assert.deepEqual(filebase.pinning, { backend: 'filebase', url: 'https://rpc.filebase.io', tokenEnv: 'SA_FILEBASE_TOKEN', timeoutMs: 60000 });
  });

  test('the parsed config never holds a credential, only the name of the variable', () => {
    for (const env of [
      { SA_PINNING: 'pinata', SA_PINATA_JWT: TOKEN },
      { SA_PINNING: 'filebase', SA_FILEBASE_TOKEN: TOKEN },
      { SA_PINNING: 'kubo', SA_BUILDER_BUILD_ENV: 'ETHERSCAN_API_KEY', ETHERSCAN_API_KEY: TOKEN },
    ]) {
      assert.equal(JSON.stringify(loadConfig(env)).includes(TOKEN), false);
    }
  });

  test('oracle amounts must fit in a uint256 (R1-F2)', () => {
    assert.throws(() => loadConfig({ SA_ORACLE_MAX_FEE_WEI: (1n << 256n).toString() }), ConfigError);
    assert.equal(loadConfig({ SA_ORACLE_MAX_FEE_WEI: '130000000000000' }).oracle.maxOracleFee, '130000000000000');
  });

  test('a remote kubo URL must be https; a plain-http URL is loopback only', () => {
    assert.throws(() => loadConfig({ SA_PINNING: 'kubo', SA_KUBO_API_URL: 'http://10.0.0.5:5001' }), ConfigError);
    assert.equal(loadConfig({ SA_PINNING: 'kubo', SA_KUBO_API_URL: 'https://kubo.internal:5001' }).pinning.url, 'https://kubo.internal:5001');
  });
});

describe('backends', () => {
  test('rawCid is the CIDv1 (raw, sha2-256) of the bytes', () => {
    assert.equal(rawCid(Buffer.alloc(0)), 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });

  test('the mock store is content-addressed and its CIDs pass common\'s and the contract\'s CID rules', async () => {
    const pinner = createMockPinner();
    const bytes = Buffer.from('listing archive');
    const cid = await pinner.pin(bytes, { name: 'listing.zip' });
    assert.equal(cid, rawCid(bytes));
    assert.equal(await pinner.pin(bytes, { name: 'again.zip' }), cid);
    assert.ok(pinner.get(cid).equals(bytes));
    assert.match(cid, /^[0-9A-Za-z]{46,100}$/); // StakeAttestation._isValidCid
    assert.ok(cid.length >= codeReview.DISCLOSURE_CID_MIN_LENGTH && cid.length <= codeReview.DISCLOSURE_CID_MAX_LENGTH);
  });

  test('kubo: adds and pins the bytes over the RPC API, CIDv1 with raw leaves, no credential sent', async () => {
    const kubo = await kuboDouble();
    const pinner = createPinner({ backend: 'kubo', url: kubo.url, tokenEnv: null, timeoutMs: 5000 }, { env: {}, fetch: loopbackFetch });
    const bytes = crypto.randomBytes(2048);
    assert.equal(await pinner.pin(bytes, { name: 'listing.zip' }), rawCid(bytes));
    const [req] = kubo.requests;
    const q = new URL(req.url, 'http://x').searchParams;
    assert.equal(q.get('pin'), 'true');
    assert.equal(q.get('cid-version'), '1');
    assert.equal(q.get('raw-leaves'), 'true');
    assert.equal(req.headers.authorization, undefined);
    assert.ok(multipartFile(req).equals(bytes));
  });

  test('a CID that is not the bytes\' own is refused', async () => {
    const kubo = await kuboDouble({ answer: rawCid(Buffer.from('something else')) });
    const pinner = createPinner({ backend: 'kubo', url: kubo.url, tokenEnv: null, timeoutMs: 5000 }, { env: {}, fetch: loopbackFetch });
    await assert.rejects(pinner.pin(Buffer.from('small archive'), { name: 'listing.zip' }), /PIN_CID_MISMATCH/);
  });

  test('Filebase: the kubo RPC API with the bearer token read from SA_FILEBASE_TOKEN', async () => {
    const fb = await kuboDouble();
    const env = { SA_FILEBASE_TOKEN: TOKEN };
    const pinner = createPinner({ backend: 'filebase', url: fb.url, tokenEnv: 'SA_FILEBASE_TOKEN', timeoutMs: 5000 }, { env, fetch: loopbackFetch });
    const bytes = Buffer.from('dispute archive');
    assert.equal(await pinner.pin(bytes, { name: 'dispute.zip' }), rawCid(bytes));
    assert.equal(fb.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(fb.requests[0].url.includes(TOKEN), false, 'the token never travels in the URL');
  });

  test('Pinata: pinFileToIPFS with the JWT read from SA_PINATA_JWT, CIDv1', async () => {
    const pin = await double((req, body) => {
      if (req.url !== '/pinning/pinFileToIPFS') return { status: 404 };
      return { json: { IpfsHash: rawCid(multipartFile({ headers: req.headers, body })), PinSize: 1 } };
    });
    const env = { SA_PINATA_JWT: TOKEN };
    const pinner = createPinner({ backend: 'pinata', url: pin.url, tokenEnv: 'SA_PINATA_JWT', timeoutMs: 5000 }, { env, fetch: loopbackFetch });
    const bytes = Buffer.from('listing archive for pinata');
    assert.equal(await pinner.pin(bytes, { name: 'listing.zip' }), rawCid(bytes));
    const [req] = pin.requests;
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(req.body.toString('latin1'), /"cidVersion":1/);
  });

  test('a refused upload is an error that never quotes the credential', async () => {
    const pin = await double(() => ({ status: 401, json: { error: `invalid key ${TOKEN}` } }));
    const pinner = createPinner({ backend: 'pinata', url: pin.url, tokenEnv: 'SA_PINATA_JWT', timeoutMs: 5000 }, { env: { SA_PINATA_JWT: TOKEN }, fetch: loopbackFetch });
    const err = await pinner.pin(Buffer.from('x'), { name: 'listing.zip' }).then(() => null, (e) => e);
    assert.ok(err);
    assert.match(err.message, /PIN_FAILED/);
    assert.equal(String(err.message).includes(TOKEN), false);
    assert.equal(JSON.stringify(err).includes(TOKEN), false);
  });

  test('a credential that disappeared from the environment is an error before any request', async () => {
    const pin = await double(() => ({ json: {} }));
    const pinner = createPinner({ backend: 'pinata', url: pin.url, tokenEnv: 'SA_PINATA_JWT', timeoutMs: 5000 }, { env: {}, fetch: loopbackFetch });
    await assert.rejects(pinner.pin(Buffer.from('x'), { name: 'a.zip' }), /SA_PINATA_JWT/);
    assert.equal(pin.requests.length, 0);
  });
});

describe('the listing flow pins both archives through the configured backend', () => {
  test('a local kubo: both CIDs come back from the daemon, and the view never shows a credential', async () => {
    const kubo = await kuboDouble();
    const config = testConfig({ SA_PINNING: 'kubo', SA_KUBO_API_URL: kubo.url, SA_FILEBASE_TOKEN: TOKEN });
    const logger = quietLogger();
    const pinner = createPinner(config.pinning, { env: {}, fetch: loopbackFetch });
    const s = await startApi({ builder: fakeBuilder(), pinner, config, logger });
    try {
      const res = await s.post('/api/listings', listingRequest());
      const view = await s.settle((await res.json()).id);
      assert.equal(view.status, 'ready', JSON.stringify(view.error));
      assert.equal(kubo.requests.length, 2);
      assert.equal(view.archives.listing.cid, rawCid(multipartFile(kubo.requests[0])));
      assert.equal(view.archives.dispute.cid, rawCid(multipartFile(kubo.requests[1])));
      assert.equal(JSON.stringify(view).includes(TOKEN), false);
      assert.equal(logger.lines.join('\n').includes(TOKEN), false);
    } finally {
      await s.close();
    }
  });
});
