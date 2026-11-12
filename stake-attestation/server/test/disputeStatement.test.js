// The dispute statement's pin (node P6b; design §13.2, erratum E2): the maker's statement, at most
// 4,096 bytes of UTF-8, is pinned by the server, because the browser holds no pinning credentials,
// and dispute() carries only its CID. Only the listing's maker may pin one, proven with a wallet
// signature over a one-time challenge (src/auth/walletAuth.js, action pin-dispute), and only while
// the claim can be disputed. The chain is the in-process Hardhat network; the pins go to the mock
// store.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_ACTIONS } from '../src/auth/walletAuth.js';
import { rawCid } from '../src/pinning/index.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import { chainContext, finalize, HOUR, increaseTime, listing, revealedClaim, siteFor, verdict } from './helpers/scenario.js';
import { wallet } from './helpers/scan.js';

const STATEMENT = 'The proof reads a slot the listed known issue covers; the claimed class is not reached. Ünïcödé.';
const REQUEST_GAS = 12_000_000n;

describe('POST /api/claims/:id/dispute-statement', () => {
  let ctx;
  let site;
  let api;
  let judged; // a valid verdict inside its dispute window
  let revealed; // not judged yet
  let invalid; // judged INVALID: no dispute
  let lapsed; // judged valid, its dispute window over

  before(async () => {
    ctx = await chainContext();
    const [h1, h2, h3, h4] = ctx.hunters;
    const a = await listing(ctx, { stake: { disputeWindowHours: 24 } });
    lapsed = await revealedClaim(ctx, h4, a.listingId);
    await verdict(ctx, lapsed, 'LOW');
    await finalize(ctx, lapsed);
    await increaseTime(ctx, 24 * HOUR + 1);
    const b = await listing(ctx);
    judged = await revealedClaim(ctx, h1, b.listingId);
    await verdict(ctx, judged, 'MEDIUM');
    await finalize(ctx, judged);
    const c = await listing(ctx);
    invalid = await revealedClaim(ctx, h2, c.listingId);
    await verdict(ctx, invalid, 'INVALID');
    await finalize(ctx, invalid);
    const d = await listing(ctx);
    revealed = await revealedClaim(ctx, h3, d.listingId);
    site = siteFor(ctx);
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const challenge = (id) => api.post(`/api/claims/${id}/dispute-statement/challenge`, {});
  async function signed(id, signer) {
    const res = await challenge(id);
    const c = await res.json();
    assert.equal(res.status, 200, JSON.stringify(c));
    return { challenge: c, nonce: c.nonce, signature: await signer.signMessage(c.message) };
  }
  const pin = (id, body) => api.post(`/api/claims/${id}/dispute-statement`, body);

  test('the action is one walletAuth knows, with its own statement', () => {
    assert.match(AUTH_ACTIONS['pin-dispute'], /dispute/);
    assert.doesNotMatch(AUTH_ACTIONS['pin-dispute'], /baseline scan/);
  });

  test('the maker signs the challenge and the statement is pinned, byte for byte, under a CID dispute() takes', async () => {
    const before = api.pinner.pins.length;
    const { challenge: c, nonce, signature } = await signed(judged, ctx.maker);
    assert.equal(c.action, 'pin-dispute');
    assert.equal(c.resource, `claim:${judged}`);
    assert.equal(c.address, ctx.maker.address);
    assert.match(c.message, /This is not a transaction/);
    const res = await pin(judged, { nonce, signature, statement: STATEMENT });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(STATEMENT, 'utf8');
    assert.equal(out.cid, rawCid(bytes));
    assert.equal(out.bytes, bytes.length);
    assert.equal(api.pinner.pins.length, before + 1);
    assert.deepEqual(api.pinner.get(out.cid), bytes);

    // the contract stores it and names it in the request's second line
    const { listingId } = await ctx.sa.getClaim(judged);
    const fee = await ctx.sa.disputeFee(listingId);
    const rc = await (await ctx.sa.connect(ctx.maker).dispute(judged, out.cid, { value: fee, gasLimit: REQUEST_GAS })).wait();
    const e = rc.logs.map((l) => { try { return ctx.sa.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Disputed');
    assert.equal(e.args.statementCid, out.cid);
    const params = await ctx.aggregator.requestParams((await ctx.sa.getClaim(judged)).disputeRequestId);
    assert.equal(params.addendum.split('\n')[1], `verdikta-dispute: ${out.cid}`);
  });

  test('a disputed claim takes no further statement', async () => {
    const res = await challenge(judged);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'CLAIM_NOT_DISPUTABLE');
  });

  test('only while the claim can be disputed: not before judgement, not on INVALID, not after the window', async () => {
    for (const id of [revealed, invalid, lapsed]) {
      const res = await challenge(id);
      assert.equal(res.status, 409, String(id));
      const out = await res.json();
      assert.equal(out.error, 'CLAIM_NOT_DISPUTABLE');
      const p = await pin(id, { nonce: '0'.repeat(32), signature: `0x${'1'.repeat(130)}`, statement: STATEMENT });
      assert.equal(p.status, 409, String(id));
    }
  });
});

describe('POST /api/claims/:id/dispute-statement: refusals', () => {
  let ctx;
  let site;
  let api;
  let claimId;

  before(async () => {
    ctx = await chainContext();
    const l = await listing(ctx);
    claimId = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
    await verdict(ctx, claimId, 'HIGH');
    await finalize(ctx, claimId);
    site = siteFor(ctx);
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const challenge = async (signer) => {
    const c = await (await api.post(`/api/claims/${claimId}/dispute-statement/challenge`, {})).json();
    return { nonce: c.nonce, signature: await signer.signMessage(c.message) };
  };
  const pin = (body) => api.post(`/api/claims/${claimId}/dispute-statement`, body);

  test('another wallet\'s signature is 403 and nothing is pinned', async () => {
    const res = await pin({ ...(await challenge(wallet())), statement: STATEMENT });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'NOT_THE_MAKER');
    assert.equal(api.pinner.pins.length, 0);
  });

  test('a nonce answers once', async () => {
    const auth = await challenge(ctx.maker);
    assert.equal((await pin({ ...auth, statement: STATEMENT })).status, 200);
    const again = await pin({ ...auth, statement: STATEMENT });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, 'CHALLENGE_UNKNOWN');
  });

  test('a challenge for another claim does not pin on this one', async () => {
    const other = await listing(ctx);
    const otherClaim = await revealedClaim(ctx, ctx.hunters[1], other.listingId);
    await verdict(ctx, otherClaim, 'LOW');
    await finalize(ctx, otherClaim);
    const c = await (await api.post(`/api/claims/${otherClaim}/dispute-statement/challenge`, {})).json();
    const res = await pin({ nonce: c.nonce, signature: await ctx.maker.signMessage(c.message), statement: STATEMENT });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'CHALLENGE_MISMATCH');
  });

  test('a statement that is empty, over 4,096 bytes or not well-formed text is refused before the nonce is used', async () => {
    const auth = await challenge(ctx.maker);
    const pins = api.pinner.pins.length;
    for (const [statement, status, code] of [
      ['', 400, 'STATEMENT_INVALID'],
      ['   \n', 400, 'STATEMENT_INVALID'],
      [42, 400, 'STATEMENT_INVALID'],
      ['half a pair \uD83D', 400, 'STATEMENT_INVALID'],
      ['é'.repeat(2049), 413, 'STATEMENT_TOO_LONG'],
    ]) {
      const res = await pin({ ...auth, statement });
      assert.equal(res.status, status, JSON.stringify(statement).slice(0, 30));
      assert.equal((await res.json()).error, code);
    }
    assert.equal(api.pinner.pins.length, pins);
    // the nonce is still good: 4,096 bytes exactly is a statement
    const res = await pin({ ...auth, statement: 'é'.repeat(2048) });
    assert.equal(res.status, 200);
  });

  test('a malformed claim id is 400, an unknown one 404; a body over the limit 413; every answer no-store', async () => {
    for (const bad of ['0', 'abc', '01', '1'.repeat(21)]) {
      const res = await api.post(`/api/claims/${bad}/dispute-statement/challenge`, {});
      assert.equal(res.status, 400, bad);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    const unknown = await api.post('/api/claims/999999/dispute-statement/challenge', {});
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'CLAIM_NOT_FOUND');
    const big = await pin({ nonce: '0'.repeat(32), signature: '0x', statement: 'x'.repeat(40000) });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get('cache-control'), 'no-store');
    const notJson = await api.post(`/api/claims/${claimId}/dispute-statement`, '{');
    assert.equal(notJson.status, 400);
  });

  test('a backend that answers another CID than the statement\'s raw CID is 502: the page could not check it', async () => {
    const odd = { backend: 'odd', pins: [], async pin(bytes) { this.pins.push(bytes); return 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'; } };
    const other = await startApi({ builder: fakeBuilder(), site, pinner: odd });
    try {
      const c = await (await other.post(`/api/claims/${claimId}/dispute-statement/challenge`, {})).json();
      const res = await other.post(`/api/claims/${claimId}/dispute-statement`, { nonce: c.nonce, signature: await ctx.maker.signMessage(c.message), statement: STATEMENT });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error, 'PIN_CID_UNVERIFIED');
    } finally {
      await other.close();
    }
  });

  test('without a deployment the routes answer 503', async () => {
    const bare = await startApi({ builder: fakeBuilder() });
    try {
      const res = await bare.post(`/api/claims/${claimId}/dispute-statement/challenge`, {});
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'CHAIN_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
