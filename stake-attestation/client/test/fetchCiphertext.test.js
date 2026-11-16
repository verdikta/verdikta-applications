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

// ------------------------------------------------------------------------------------------- the gateway list
// VITE_IPFS_GATEWAY may name several gateways (src/config.js). They are asked in order, and the next only when one
// fails to deliver: a network error, a non-2xx answer or no body within the timeout. A body that arrives comes back
// as it is: whether it is the committed ciphertext is checkDisclosure's to decide, so a gateway's wrong bytes are
// never swapped for another gateway's.

const A = 'https://a.gateway.example';
const B = 'https://b.gateway.example';
const C = 'https://c.gateway.example';
const ok = (bytes) => new Response(new Uint8Array(bytes));
const hostOf = (url) => new URL(url).origin;

/** A fetch whose answer depends on the gateway asked: `answers[origin](url, init)`. Gateways not named are an error. */
function byGateway(answers) {
  return fakeFetch((url, init) => {
    const answer = answers[hostOf(url)];
    if (!answer) throw new Error(`${url} was not to be asked`);
    return answer(url, init);
  });
}

/** An answer that never comes: it rejects only when the request is aborted, as a browser's fetch does. */
const hangs = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});

test('the gateways are asked in order, and the first that delivers is the last asked', async () => {
  const f = byGateway({ [A]: () => { throw new TypeError('fetch failed'); }, [B]: () => ok([7, 8]), [C]: () => ok([9]) });
  const bytes = await fetchCiphertext([A, B, C], CID, { fetchImpl: f.impl });
  assert.deepEqual([...bytes], [7, 8]);
  assert.deepEqual(f.calls.map((c) => c.url), [`${A}/ipfs/${CID}`, `${B}/ipfs/${CID}`]);
  for (const c of f.calls) {
    assert.equal(c.init.credentials, 'omit', c.url);
    assert.equal(c.init.referrerPolicy, 'no-referrer', c.url);
  }
});

test('each failure to deliver moves on to the next gateway: a network error, a non-2xx answer, a timeout, a body cut off', async () => {
  const cutOff = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(2));
      c.error(new TypeError('network error'));
    },
  }));
  const stalls = (url, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(2));
      init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
    },
  }));
  const kinds = {
    'a network error': () => { throw new TypeError('fetch failed'); },
    'a 404': () => new Response('not found', { status: 404 }),
    'a 429': () => new Response('slow down', { status: 429 }),
    'a 502': () => new Response('bad gateway', { status: 502 }),
    'no answer within the timeout': hangs,
    'a body that stops within the timeout': stalls,
    'a body cut off': cutOff,
  };
  for (const [kind, first] of Object.entries(kinds)) {
    const f = byGateway({ [A]: first, [B]: () => ok([5]) });
    const bytes = await fetchCiphertext([A, B], CID, { fetchImpl: f.impl, timeoutMs: 50 });
    assert.deepEqual([...bytes], [5], kind);
    assert.deepEqual(f.calls.map((c) => hostOf(c.url)), [A, B], kind);
  }
});

test('a gateway whose fetch ignores the abort still gives way at the timeout', async () => {
  const f = byGateway({ [A]: () => new Promise(() => {}), [B]: () => ok([6]) });
  const bytes = await fetchCiphertext([A, B], CID, { fetchImpl: f.impl, timeoutMs: 50 });
  assert.deepEqual([...bytes], [6]);
  assert.equal(f.calls[0].init.signal.aborted, true, 'the first request was aborted');
});

test('a body that arrives is returned as it is, wrong bytes too: the next gateway is not asked', async () => {
  const f = byGateway({ [A]: () => ok([0xde, 0xad]), [B]: () => { throw new Error('B was asked'); } });
  const bytes = await fetchCiphertext([A, B], CID, { fetchImpl: f.impl });
  assert.deepEqual([...bytes], [0xde, 0xad]);
  assert.equal(f.calls.length, 1);
  // an empty body is a body
  const empty = byGateway({ [A]: () => ok([]), [B]: () => ok([1]) });
  assert.deepEqual([...await fetchCiphertext([A, B], CID, { fetchImpl: empty.impl })], []);
  assert.equal(empty.calls.length, 1);
});

test('the size cap holds at every gateway, and a body over it ends the fetch: it is the CID\'s size, not the gateway\'s failure', async () => {
  const declared = byGateway({ [A]: () => new Response(new Uint8Array(5), { headers: { 'content-length': '5' } }), [B]: () => ok([1]) });
  await assert.rejects(fetchCiphertext([A, B], CID, { maxBytes: 4, fetchImpl: declared.impl }), (e) => e.reason.key === 'tooLarge' && e.reason.vars.max === 4);
  assert.equal(declared.calls.length, 1);
  const streamed = byGateway({
    [A]: () => { throw new TypeError('fetch failed'); },
    [B]: () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(3)); } })),
    [C]: () => ok([1]),
  });
  await assert.rejects(fetchCiphertext([A, B, C], CID, { maxBytes: 8, fetchImpl: streamed.impl }), (e) => e.reason.key === 'tooLarge');
  assert.deepEqual(streamed.calls.map((c) => hostOf(c.url)), [A, B]);
});

test('when every gateway fails, the error is the last gateway\'s failure', async () => {
  const f = byGateway({ [A]: () => { throw new TypeError('fetch failed'); }, [B]: () => new Response('', { status: 503 }) });
  await assert.rejects(fetchCiphertext([A, B], CID, { fetchImpl: f.impl }), (e) => e.reason.key === 'http' && e.reason.vars.status === 503);
  const g = byGateway({ [A]: () => new Response('', { status: 404 }), [B]: () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(fetchCiphertext([A, B], CID, { fetchImpl: g.impl }), (e) => e.reason.key === 'network');
  const h = byGateway({ [A]: () => new Response('', { status: 404 }), [B]: hangs });
  await assert.rejects(fetchCiphertext([A, B], CID, { fetchImpl: h.impl, timeoutMs: 30 }), (e) => e.reason.key === 'network');
});

test('the wait is bounded: at most the per-gateway timeout for each gateway, every request aborted when its time is up', async () => {
  const f = byGateway({ [A]: hangs, [B]: hangs, [C]: hangs });
  const started = Date.now();
  await assert.rejects(fetchCiphertext([A, B, C], CID, { fetchImpl: f.impl, timeoutMs: 40 }), (e) => e.reason.key === 'network');
  const took = Date.now() - started;
  assert.ok(took >= 3 * 40 - 5, `each gateway had its time (${took} ms)`);
  assert.ok(took < 3 * 40 + 400, `and no more (${took} ms)`);
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) assert.equal(c.init.signal.aborted, true, c.url);
});

test('the CID is checked once, before any gateway is asked', async () => {
  const f = byGateway({ [A]: () => ok([1]), [B]: () => ok([2]) });
  await assert.rejects(fetchCiphertext([A, B], `${CID}/../x`, { fetchImpl: f.impl }), (e) => e.reason?.key === 'cid');
  assert.equal(f.calls.length, 0);
});

test('one gateway works as before, named alone or as a list of one', async () => {
  for (const gateways of [A, [A]]) {
    const f = byGateway({ [A]: () => ok([4]) });
    assert.deepEqual([...await fetchCiphertext(gateways, CID, { fetchImpl: f.impl })], [4]);
    assert.deepEqual(f.calls.map((c) => c.url), [`${A}/ipfs/${CID}`]);
    const down = byGateway({ [A]: () => new Response('', { status: 404 }) });
    await assert.rejects(fetchCiphertext(gateways, CID, { fetchImpl: down.impl }), (e) => e.reason.key === 'http' && e.reason.vars.status === 404);
    assert.equal(down.calls.length, 1);
  }
});

test('the default timeout is 60 s a gateway', async () => {
  const { GATEWAY_TIMEOUT_MS } = await import('../src/lib/fetchCiphertext.js');
  assert.equal(GATEWAY_TIMEOUT_MS, 60_000);
});
