// The build's IPFS gateways (src/config.js): VITE_IPFS_GATEWAY is one gateway origin or several, comma-separated, in
// the order the check page asks them (src/lib/fetchCiphertext.js); the record page links an archive to the first.
// Each is an https origin, or plain http on a loopback address (the tests' stand-ins): the build is public and the
// page is served over https, so anything else is left out rather than asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, parseGateways } from '../src/config.js';

test('a list is read in its order, each origin trimmed of spaces and a trailing slash', () => {
  assert.deepEqual(parseGateways('https://gateway.pinata.cloud,https://ipfs.io'), ['https://gateway.pinata.cloud', 'https://ipfs.io']);
  assert.deepEqual(parseGateways(' https://b.example/ , https://a.example,,'), ['https://b.example', 'https://a.example']);
});

test('one value works as before', () => {
  assert.deepEqual(parseGateways('https://ipfs.io'), ['https://ipfs.io']);
  assert.deepEqual(parseGateways('https://ipfs.io/'), ['https://ipfs.io']);
});

test('none set is no gateway', () => {
  for (const v of [undefined, null, '', ' ', ',']) assert.deepEqual(parseGateways(v), [], String(v));
});

test('plain http only on a loopback address, for the tests\' stand-ins', () => {
  assert.deepEqual(parseGateways('http://127.0.0.1:8080,http://localhost:9,http://[::1]:7'), ['http://127.0.0.1:8080', 'http://localhost:9', 'http://[::1]:7']);
  assert.deepEqual(parseGateways('http://gateway.example,https://ipfs.io'), ['https://ipfs.io']);
});

test('an entry that is not an origin is left out: no path, query, fragment, credentials or other scheme', () => {
  for (const bad of ['https://a.example/ipfs', 'https://a.example/?k=1', 'https://a.example/#x', 'https://user:pw@a.example', 'ftp://a.example', 'a.example', 'not a url']) {
    assert.deepEqual(parseGateways(`${bad},https://ipfs.io`), ['https://ipfs.io'], bad);
  }
});

test('a gateway named twice is asked once', () => {
  assert.deepEqual(parseGateways('https://ipfs.io,https://gateway.pinata.cloud,https://ipfs.io/'), ['https://ipfs.io', 'https://gateway.pinata.cloud']);
});

test('the config exposes the list and its first, for the record page\'s archive link', () => {
  // under node there is no Vite environment: nothing is configured
  assert.deepEqual(CONFIG.ipfsGateways, []);
  assert.equal(CONFIG.ipfsGateway, null);
  assert.ok(Object.isFrozen(CONFIG.ipfsGateways));
});
