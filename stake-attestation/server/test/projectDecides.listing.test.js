// Node P9 (owner decision Q34, "the project decides"), the server's listing flow: the maker is
// required and signs the request with its wallet; every listing needs the project's proof at the
// listed commit, and a contract listing also the deployer's or owner's signature; a refusal has a
// named code, nothing is built, signed or pinned; refused attempts are counted by reason on
// /api/status, with no address or repository name in the counts, and the counts survive a restart.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import { MAKER, MAKER_WALLET, contractDraft, draftSpec, fakeBuilder, listingRequest } from './helpers/fixtures.js';
import { proofFile } from './helpers/gitRepo.js';
import { startApi } from './helpers/http.js';

const servers = [];
async function api(opts = {}) {
  const s = await startApi({ builder: fakeBuilder(), ...opts });
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

const answer = (text, over = {}) => async () => ({ reachable: true, ref: 'refs/heads/main', file: { blob: 'b'.repeat(40), text, problem: null }, ...over });
const refused = async (s, body, code) => {
  const res = await s.submit(body);
  assert.equal(res.status, 202, await res.clone().text());
  const view = await s.settle((await res.json()).id);
  assert.equal(view.status, 'refused', JSON.stringify(view.error));
  assert.equal(view.refusal.code, code);
  assert.equal(typeof view.refusal.detail, 'string');
  assert.equal(view.archives, null);
  assert.equal(view.list, null);
  assert.equal(s.builder.calls.length, 0, 'nothing was built');
  assert.equal(s.pinner.pins.length, 0, 'nothing was pinned');
  return view;
};
const STRANGER = Wallet.createRandom();

describe('the maker', () => {
  test('is required: no maker is refused with its code, before any build', async () => {
    const s = await api();
    const { maker, ...body } = listingRequest();
    const res = await s.post('/api/listings', body);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.issues.some((i) => i.code === 'MAKER_REQUIRED'), JSON.stringify(json.issues));
    assert.equal(s.builder.calls.length, 0);
  });

  test('must sign the request: unsigned is refused, and so is a signature from another wallet', async () => {
    const s = await api();
    const body = listingRequest();
    const unsigned = await s.post('/api/listings', body);
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).error, 'MAKER_SIGNATURE_REQUIRED');
    const signed = await s.submit(body, { wallet: STRANGER });
    assert.equal(signed.status, 403);
    assert.equal((await signed.json()).error, 'MAKER_SIGNATURE_INVALID');
    assert.equal(s.builder.calls.length, 0);
  });

  test('a stranger cannot get an archive with their own disclosure key by naming the project\'s address', async () => {
    const s = await api({ checkRepository: answer(proofFile(MAKER)) });
    const res = await s.submit(listingRequest({ maker: MAKER }), { wallet: STRANGER });
    assert.equal(res.status, 403);
    assert.equal(s.builder.calls.length, 0);
    assert.equal(s.pinner.pins.length, 0);
  });

  test('the signature is of this request: it does not carry over to another spec', async () => {
    const s = await api();
    const body = listingRequest();
    const c = await (await s.post('/api/listings/challenge', body)).json();
    assert.match(c.resource, /^list-request:[0-9a-f]{64}$/);
    assert.equal(c.address, MAKER);
    const auth = { nonce: c.nonce, signature: await MAKER_WALLET.signMessage(c.message) };
    const other = listingRequest({ spec: draftSpec({ baseCommit: 'c'.repeat(40) }) });
    const res = await s.post('/api/listings', { ...other, auth });
    assert.equal(res.status, 401);
    // and a signature answers once
    const first = await s.post('/api/listings', { ...body, auth });
    assert.ok([401, 202].includes(first.status));
    assert.equal(s.builder.calls.length, 0);
  });

  test('an invalid request is answered at the challenge: nothing to sign', async () => {
    const s = await api();
    const res = await s.post('/api/listings/challenge', { ...listingRequest(), maker: 'nobody' });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).issues.some((i) => i.code === 'MAKER_INVALID'));
  });
});

describe('the project\'s proof', () => {
  test('the project\'s own listing passes, and the builder is given the maker', async () => {
    const s = await api({ checkRepository: answer(proofFile(MAKER)) });
    const res = await s.submit(listingRequest());
    assert.equal(res.status, 202);
    const view = await s.settle((await res.json()).id);
    assert.equal(view.status, 'ready', JSON.stringify(view.error ?? view.refusal));
    assert.equal(s.builder.calls[0].maker, MAKER);
    assert.equal(view.maker, MAKER);
  });

  test('a sponsor the project names passes; the same file refuses anyone else', async () => {
    const sponsor = Wallet.createRandom();
    const s = await api({ checkRepository: answer(proofFile(sponsor.address)) });
    const body = listingRequest({ maker: sponsor.address });
    const res = await s.submit(body, { wallet: sponsor });
    assert.equal((await s.settle((await res.json()).id)).status, 'ready');
    const t = await api({ checkRepository: answer(proofFile(sponsor.address)) });
    await refused(t, listingRequest(), 'PROOF_NAMES_ANOTHER_ADDRESS');
  });

  test('each way of having no proof has its code', async () => {
    const cases = [
      [async () => ({ reachable: false, ref: null, file: null }), 'COMMIT_NOT_ON_OWN_REFS'],
      [async () => ({ reachable: true, ref: 'refs/heads/main', file: null }), 'NO_PROOF_FILE'],
      [answer('not json'), 'PROOF_FILE_INVALID'],
      [answer(JSON.stringify({ version: 1, maker: [MAKER, STRANGER.address] })), 'PROOF_FILE_INVALID'],
      [answer(proofFile(STRANGER.address)), 'PROOF_NAMES_ANOTHER_ADDRESS'],
      [async () => ({ reachable: true, ref: 'refs/heads/main', file: { blob: 'b'.repeat(40), text: null, problem: 'NOT_A_REGULAR_FILE' } }), 'PROOF_FILE_INVALID'],
    ];
    for (const [checkRepository, code] of cases) await refused(await api({ checkRepository }), listingRequest(), code);
  });

  test('a repository the site does not read is refused at the request', async () => {
    const s = await api();
    for (const [repo, code] of [['https://github.com.evil.example/acme/vault', 'REPO_HOST_NOT_CHECKED'], ['https://github.com/acme/vault?x=1', 'REPO_URL_FORM']]) {
      const res = await s.post('/api/listings/challenge', listingRequest({ spec: draftSpec({ repo }) }));
      assert.equal(res.status, 400, repo);
      assert.ok((await res.json()).issues.some((i) => i.code === code), repo);
    }
  });

  test('a git host that cannot be read is an error to retry, not a refusal and not a pass', async () => {
    const { RepositoryCheckError } = await import('../src/control/gitCheck.js');
    const s = await api({ checkRepository: async () => { throw new RepositoryCheckError('REPO_UNAVAILABLE', 'the host answered 503'); } });
    const res = await s.submit(listingRequest());
    const view = await s.settle((await res.json()).id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'REPO_UNAVAILABLE');
    assert.equal(s.builder.calls.length, 0);
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a contract listing needs the signature too: none is refused at the request, a bad one by its code', async () => {
    const s = await api();
    const res = await s.post('/api/listings/challenge', listingRequest({ spec: contractDraft() }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).issues.some((i) => i.code === 'NO_SIGNATURE'));

    const proof = { signer: STRANGER.address, signature: `0x${'11'.repeat(65)}` };
    const { ControlError } = await import('../src/control/index.js');
    const bad = await api({ checkDeployment: async () => { throw new ControlError('SIGNER_NOT_CONTROLLER', 'no', 422); } });
    await refused(bad, listingRequest({ spec: contractDraft(), deploymentProof: proof }), 'SIGNER_NOT_CONTROLLER');

    const good = await api({ checkDeployment: async () => ({ ok: true }) });
    const accepted = await good.submit(listingRequest({ spec: contractDraft(), deploymentProof: proof }));
    const view = await good.settle((await accepted.json()).id);
    assert.equal(view.status, 'ready', JSON.stringify(view.error ?? view.refusal));
    assert.deepEqual(good.builder.calls[0].deploymentProof.signer, STRANGER.address);
  });

  test('a repository listing carries no deployment signature', async () => {
    const s = await api();
    const res = await s.post('/api/listings/challenge', listingRequest({ deploymentProof: { signer: MAKER, signature: '0x11' } }));
    assert.equal(res.status, 400);
  });

  test('a build accepted for another maker is not issued', async () => {
    const s = await api({ builder: fakeBuilder({ tamper: ({ report }) => { report.control.maker = STRANGER.address; } }) });
    const res = await s.submit(listingRequest());
    const view = await s.settle((await res.json()).id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'BUILD_REPORT_INCONSISTENT');
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a build whose report records no proof step is not issued', async () => {
    const s = await api({ builder: fakeBuilder({ tamper: ({ report }) => { report.steps = report.steps.filter((x) => x.name !== 'control'); } }) });
    const view = await s.settle((await (await s.submit(listingRequest())).json()).id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'BUILD_REPORT_INCONSISTENT');
  });
});

describe('refused attempts, counted by reason', () => {
  test('/api/status counts them by reason, with no address or repository name', async () => {
    const { chainContext, siteFor } = await import('./helpers/scenario.js');
    const ctx = await chainContext();
    const site = siteFor(ctx);
    try {
      const s = await api({ site, checkRepository: answer(proofFile(STRANGER.address)) });
      const body = listingRequest();
      await refused(s, body, 'PROOF_NAMES_ANOTHER_ADDRESS');
      await s.post('/api/listings', { ...body, maker: undefined });
      await s.post('/api/listings', body);
      const status = await (await s.get('/api/status')).json();
      assert.equal(status.listings.refused.total, 3);
      assert.equal(status.listings.refused.byReason.PROOF_NAMES_ANOTHER_ADDRESS, 1);
      assert.equal(status.listings.refused.byReason.MAKER_REQUIRED, 1);
      assert.equal(status.listings.refused.byReason.MAKER_SIGNATURE_REQUIRED, 1);
      const counts = JSON.stringify(status.listings);
      assert.equal(/0x[0-9a-fA-F]{40}/.test(counts), false, counts);
      assert.equal(counts.includes('github'), false, counts);
      assert.equal(counts.includes('acme'), false, counts);
    } finally {
      site.close();
    }
  });

  test('the counts survive a restart, as the rest of the site\'s state does', async () => {
    const { chainContext, siteFor, tmpDir } = await import('./helpers/scenario.js');
    const ctx = await chainContext();
    const dir = tmpDir();
    const first = siteFor(ctx, { dir });
    const s = await api({ site: first });
    await s.post('/api/listings', listingRequest());
    await s.close();
    first.close();
    const second = siteFor(ctx, { dir });
    try {
      assert.equal(second.status().listings.refused.byReason.MAKER_SIGNATURE_REQUIRED, 1);
      assert.equal(second.status().listings.refused.total, 1);
    } finally {
      second.close();
    }
  });

  test('without a deployment /api/status still answers 503, and states the counts', async () => {
    const s = await api();
    await s.post('/api/listings', listingRequest());
    const res = await s.get('/api/status');
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'CHAIN_NOT_CONFIGURED');
    assert.equal(json.listings.refused.byReason.MAKER_SIGNATURE_REQUIRED, 1);
  });

  test('a code that is not a plain identifier never reaches the counts', async () => {
    const { RefusalCounter } = await import('../src/listing/refusals.js');
    const c = new RefusalCounter();
    c.count(['NO_PROOF_FILE', 'NO_PROOF_FILE', 'https://github.com/acme/vault', '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4']);
    const view = c.view();
    assert.equal(view.total, 1);
    assert.deepEqual(view.byReason, { NO_PROOF_FILE: 1, OTHER: 2 });
  });
});

test('wording: every refusal text the server writes passes the wording check', async () => {
  const { wordingProblems, PROOF_REFUSALS } = await import('@verdikta/stake-attestation-shared');
  for (const [code, text] of Object.entries(PROOF_REFUSALS)) assert.deepEqual(wordingProblems(text), [], code);
});
