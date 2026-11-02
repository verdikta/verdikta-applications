// Node P9: the site counts a listing only with a valid builder signature and the project's proof.
// The record, the feed, the badge and the labels read those only; any other listing of the hash
// shows apart, as not counted, and never adds to the stake shown. The attacks here are the node's
// review focus: a signed archive replayed from another wallet; a listing the builder never signed;
// an unsigned listing's stake reaching the badge, feed or labels.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import { bareListing, chainContext, listing, replay, revealedClaim, judgeAndSettle, settled, siteFor } from './helpers/scenario.js';

const ids = (list) => list.map((l) => String(l.listingId));

describe('what counts', () => {
  let ctx;
  let site;
  let api;
  before(async () => {
    ctx = await chainContext();
    site = siteFor(ctx);
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const view = async (hash) => (await api.get(`/api/records/${hash}`)).json();
  const badge = async (hash) => (await api.get(`/api/records/${hash}/badge.svg`)).text();
  const feed = async () => (await api.get('/api/feed')).json();

  test('the project\'s own listing counts: record, feed, badge and labels; wording names the repository', async () => {
    const l = await listing(ctx);
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(ids(v.record.listings), [String(l.listingId)]);
    assert.deepEqual(v.notCounted.listings, []);
    assert.equal(v.control[String(l.listingId)].proof, 'yes');
    assert.equal(v.control[String(l.listingId)].statement, 'staker named by the repository: yes');
    assert.ok(v.labels.listings[String(l.listingId)].stake);
    assert.match(await badge(l.artifactHash), /no finding at or above MEDIUM while staked/);
    assert.match(await badge(l.artifactHash), /staker named by the repository/);
    const f = await feed();
    assert.ok(ids(f.listings).includes(String(l.listingId)));
    assert.equal(f.notCounted.some((e) => e.listingId === String(l.listingId)), false);
    // what a contract read says too: this is recordByHash's answer when every listing counts
    const onchain = await ctx.hre.ethers.getContractAt(ctx.mergedAbi, ctx.address);
    assert.equal(String((await onchain.recordByHash(l.artifactHash)).listingCount), v.record.listingCount);
  });

  test('a signed archive replayed from another wallet: not counted; it never adds to the stake, badge, feed or labels', async () => {
    const l = await listing(ctx);
    const r = await replay(ctx, l, { from: ctx.other, escrowMultiple: 50n });
    await settled(site);
    const v = await view(l.artifactHash);
    const replayId = String(r.listingId);
    assert.deepEqual(ids(v.record.listings), [String(l.listingId)], 'the record lists only the project\'s');
    assert.equal(v.record.listingCount, '1');
    assert.equal(v.labels.listings[replayId], undefined);
    assert.deepEqual(v.record.active, [String(l.listingId)]);
    const shown = v.notCounted.listings.find((x) => x.listingId === replayId);
    assert.ok(shown, 'it shows apart');
    assert.equal(shown.maker, ctx.other.address);
    assert.equal(shown.reason, 'PROOF_NAMES_ANOTHER_ADDRESS');
    assert.equal(typeof shown.detail, 'string');
    assert.equal(shown.escrowWei, undefined, 'no amount of it is shown');
    assert.equal(shown.awards, undefined);
    const f = await feed();
    assert.equal(ids(f.listings).includes(replayId), false, 'the site offers no commit on it');
    assert.ok(f.notCounted.some((e) => e.listingId === replayId && e.reason === 'PROOF_NAMES_ANOTHER_ADDRESS'));
  });

  test('a replay alone gives a project\'s hash no stake: the badge says so', async () => {
    const l = await listing(ctx, { list: false });
    const r = await replay(ctx, l, { from: ctx.other });
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.record.listings, []);
    assert.equal(v.record.listingCount, '0');
    assert.ok(v.notCounted.listings.some((x) => x.listingId === String(r.listingId)));
    assert.equal(v.badge.state, 'none');
    assert.equal(v.badge.message, 'no counted stake');
    assert.match(await badge(l.artifactHash), /no counted stake/);
    assert.equal(/while staked/.test(await badge(l.artifactHash)), false);
    assert.equal(v.artifact.repo, l.spec.repo, 'the record still names what it is the record of');
  });

  test('an archive the builder did not sign is not counted, even when the file names its maker', async () => {
    const l = await bareListing(ctx, { signWith: fakeBuilder() });
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.record.listings, []);
    assert.equal(v.notCounted.listings[0].reason, 'NOT_SIGNED_BY_BUILDER');
    assert.equal(v.badge.state, 'none');
    assert.equal(ids((await feed()).listings).includes(String(l.listingId)), false);
  });

  test('a listing whose archive cannot be read is not counted', async () => {
    const l = await bareListing(ctx, { junkCid: true });
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.record.listings, []);
    assert.ok(['ARCHIVE_UNAVAILABLE', 'ARCHIVE_INVALID'].includes(v.notCounted.listings[0].reason));
  });

  test('a signed archive with other terms on-chain is not what the builder signed', async () => {
    for (const change of [{ disclosureKey: `0x${'77'.repeat(32)}` }, { awards: ['0', '1', '2', '3'] }, { bondWei: '1' }, { fixWindow: 1 }]) {
      const l = await listing(ctx, { paramsOver: change });
      await settled(site);
      const v = await view(l.artifactHash);
      assert.deepEqual(v.record.listings, [], JSON.stringify(change));
      assert.equal(v.notCounted.listings[0].reason, 'ARCHIVE_MISMATCH');
    }
  });

  test('a valid finding under a listing that does not count stays off the project\'s badge and shows apart', async () => {
    const l = await listing(ctx);
    const r = await replay(ctx, l, { from: ctx.other, fixWindow: 0 });
    const claim = await revealedClaim(ctx, ctx.hunters[0], r.listingId);
    await judgeAndSettle(ctx, claim, 'HIGH');
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.record.findings, []);
    assert.equal(v.record.findingCount, '0');
    assert.equal(v.record.history.claims, '0', 'its claims are not in the history');
    assert.equal(v.history.daysSinceLastValidFinding, null);
    assert.match(await badge(l.artifactHash), /no finding at or above MEDIUM while staked/);
    assert.equal(v.notCounted.findings.length, 1);
    assert.equal(v.notCounted.findings[0].listingId, String(r.listingId));
    assert.ok(v.notCounted.events.some((e) => e.listingId === String(r.listingId) && e.name === 'Listed'));
    assert.equal(v.history.events.some((e) => e.listingId === String(r.listingId)), false);
  });

  test('the events feed says which listings count', async () => {
    const l = await listing(ctx);
    const r = await replay(ctx, l, { from: ctx.other });
    await settled(site);
    const events = (await (await api.get('/api/feed/events?limit=1000')).json()).events;
    assert.equal(events.find((e) => e.name === 'Listed' && e.listingId === String(l.listingId)).counted, true);
    assert.equal(events.find((e) => e.name === 'Listed' && e.listingId === String(r.listingId)).counted, false);
  });
});

describe('it stays counted only while the proof stands', () => {
  test('a git host down for a while keeps the honest listing; the commit leaving the refs drops it', async () => {
    const ctx = await chainContext();
    let mode = 'ok';
    const proofs = ctx.proofs;
    const site = siteFor(ctx, {
      env: { SA_CONTROL_RECHECK_MS: '1', SA_CONTROL_RETRY_MS: '1' },
      checkRepository: async ({ repo, commit }) => {
        if (mode === 'down') throw Object.assign(new Error('503'), { code: 'REPO_UNAVAILABLE' });
        if (mode === 'gone') return { reachable: false, ref: null, file: null };
        return ctx.answerFor({ repo, commit });
      },
    });
    try {
      const l = await listing(ctx);
      assert.ok(proofs.size > 0);
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).record.listings.length, 1);
      mode = 'down';
      await settled(site);
      const during = await site.record(l.artifactHash);
      assert.equal(during.record.listings.length, 1, 'a transient failure does not drop an honest listing');
      assert.equal(during.control[String(l.listingId)].repository.lastCheckFailed, 'REPO_UNAVAILABLE');
      mode = 'gone';
      await settled(site);
      const after2 = await site.record(l.artifactHash);
      assert.equal(after2.record.listings.length, 0);
      assert.equal(after2.notCounted.listings[0].reason, 'COMMIT_NOT_ON_OWN_REFS');
    } finally {
      site.close();
    }
  });
});

describe('a contract listing', () => {
  test('counts with the file and the signature, and says both', async () => {
    const ctx = await chainContext();
    const site = siteFor(ctx, { chainProviderFor: (id) => (id === 31337 ? ctx.provider : null) });
    try {
      const owned = await (await ctx.hre.ethers.getContractFactory('MockOwned')).deploy(ctx.other.address);
      await owned.waitForDeployment();
      const address = await owned.getAddress();
      const artifact = { kind: 'contract', address, chainId: 31337 };
      const l = await listing(ctx, { spec: { artifact } });
      await settled(site);
      let v = await site.record(l.artifactHash);
      assert.deepEqual(v.record.listings, [], 'the file alone is not enough');
      assert.equal(v.notCounted.listings[0].reason, 'NO_SIGNATURE');

      const message = v.control[String(l.listingId)].deployment.message;
      await site.submitControlProof(l.artifactHash, String(l.listingId), { signer: ctx.other.address, signature: await ctx.other.signMessage(message) });
      v = await site.record(l.artifactHash);
      assert.equal(v.record.listings.length, 1);
      assert.equal(v.control[String(l.listingId)].statement, 'staker named by the repository: yes · staker controls the deployment: yes');
      assert.match((await site.badge(l.artifactHash)).svg, /staker controls the deployment/);

      // the signature alone is not enough either
      const noFile = await listing(ctx, { spec: { artifact }, proof: null });
      await settled(site);
      const m2 = (await site.record(noFile.artifactHash)).control[String(noFile.listingId)].deployment.message;
      await site.submitControlProof(noFile.artifactHash, String(noFile.listingId), { signer: ctx.other.address, signature: await ctx.other.signMessage(m2) });
      const w = await site.record(noFile.artifactHash);
      assert.deepEqual(w.record.listings, []);
      assert.ok(['NO_PROOF_FILE', 'COMMIT_NOT_ON_OWN_REFS'].includes(w.notCounted.listings[0].reason));
    } finally {
      site.close();
    }
  });
});
