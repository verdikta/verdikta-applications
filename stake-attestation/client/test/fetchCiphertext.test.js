// Fetching the disclosed ciphertext (src/lib/fetchCiphertext.js): only a CID the contract would
// store goes into the URL, the request carries no credentials, and the body is read up to a cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCiphertext } from '../src/lib/fetchCiphertext.js';

const CID = `bafkrei${'a'.repeat(52)}`;
const GATEWAY = 'https://gateway.example';

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, impl };
}

test('the ciphertext comes back as bytes from <gateway>/ipfs/<cid>, with no credentials or referrer', async () => {
  const f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])));
  const bytes = await fetchCiphertext(GATEWAY, CID, { fetchImpl: f.impl });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${GATEWAY}/ipfs/${CID}`);
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.referrerPolicy, 'no-referrer');
});

test('a CID the contract would not store is refused before any request', async () => {
  const f = fakeFetch(() => new Response('x'));
  for (const cid of ['', 'short', `${CID}/../x`, `${CID}?a=b`, 'a'.repeat(101)]) {
    await assert.rejects(fetchCiphertext(GATEWAY, cid, { fetchImpl: f.impl }), (e) => e.reason?.key === 'cid');
  }
  assert.equal(f.calls.length, 0);
});

test('an HTTP error, a network error and a body over the cap are reasons, not bytes', async () => {
  await assert.rejects(
    fetchCiphertext(GATEWAY, CID, { fetchImpl: async () => new Response('gone', { status: 404 }) }),
    (e) => e.reason.key === 'http' && e.reason.vars.status === 404,
  );
  await assert.rejects(
    fetchCiphertext(GATEWAY, CID, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    (e) => e.reason.key === 'network',
  );
  await assert.rejects(
    fetchCiphertext(GATEWAY, CID, { maxBytes: 4, fetchImpl: async () => new Response(new Uint8Array(5), { headers: { 'content-length': '5' } }) }),
    (e) => e.reason.key === 'tooLarge' && e.reason.vars.max === 4,
  );
  // no length declared: the stream is cut at the cap
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(3)); },
  });
  await assert.rejects(
    fetchCiphertext(GATEWAY, CID, { maxBytes: 8, fetchImpl: async () => new Response(stream) }),
    (e) => e.reason.key === 'tooLarge',
  );
});
