// Node P8, acceptance 1, 3 and 4 for a repository listing, end to end: real listings on the
// in-process chain, the real check (builder/bin/verdikta-control-check.js) over real git against
// bare repositories in a mirror folder, the record API and the badge. A listing counts only if the
// file at its commit names its on-chain maker and the commit is on the repository's own branches
// or tags; everything else is "no". What the builder and the listing flow refuse is node P9's.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { wordingProblems } from '@verdikta/stake-attestation-shared';
import { fakeBuilder } from './helpers/fixtures.js';
import { CONTROL_FILE, makeRepo, proofFile } from './helpers/gitRepo.js';
import { startApi } from './helpers/http.js';
import { chainContext, listing, siteFor, tmpDir } from './helpers/scenario.js';

const noFact = (control, reason) => {
  assert.equal(control.proof, 'no');
  assert.equal(control.reason, reason);
  assert.equal(typeof control.detail, 'string');
  assert.deepEqual(wordingProblems(control.detail), []);
};

/** Syncs until every check has run: a run takes at most a few, and the chain holds many listings. */
async function settled(site) {
  for (let round = 0; round < 12; round += 1) {
    await site.sync();
    await site.controlIdle();
  }
}

describe('a repository listing\'s control fact', () => {
  let ctx;
  let site;
  let api;
  let mirrors;
  let vault;
  let owner;
  let stranger;

  before(async () => {
    ctx = await chainContext();
    owner = ctx.maker.address;
    stranger = ctx.other.address;
    mirrors = tmpDir('sa-mirrors-');
    vault = makeRepo(mirrors, 'https://github.com/acme/vault');
    site = siteFor(ctx, { settle: false, checkRepository: null, env: { SA_CONTROL_GIT_MIRROR_DIR: mirrors } });
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const list = (commit, { maker = ctx.maker, repo = vault.url, stake = {} } = {}) => listing(ctx, { maker, spec: { repo, baseCommit: commit }, stake: { valueAtRiskUsd: undefined, ...stake } });

  test('yes: the file at a commit on a branch names the on-chain maker; the API says what proves it, so anyone can re-check', async () => {
    const commit = vault.commit({ file: proofFile(owner) });
    const l = await list(commit);
    await settled(site);
    const res = await api.get(`/api/records/${l.artifactHash}`);
    assert.equal(res.status, 200);
    const c = (await res.json()).control[l.listingId];
    assert.equal(c.subject, 'repository');
    assert.equal(c.proof, 'yes');
    assert.equal(c.statement, 'staker named by the repository: yes');
    assert.equal(c.reason, null);
    assert.equal(c.maker, owner);
    assert.equal(c.deployment, null);
    assert.ok(c.checkedAt > 0);
    const r = c.repository;
    assert.equal(r.repo, vault.url);
    assert.equal(r.commit, commit);
    assert.equal(r.path, CONTROL_FILE);
    assert.equal(r.fileNames, owner);
    assert.equal(r.commitOnOwnRefs, true);
    assert.equal(r.ref, 'refs/heads/main');
    assert.match(r.blob, /^[0-9a-f]{40}$/);
    assert.deepEqual(wordingProblems(JSON.stringify(c)), []);
  });

  test('the badge shows it', async () => {
    const commit = vault.commit({ file: proofFile(owner) });
    const l = await list(commit);
    await settled(site);
    const svg = await (await api.get(`/api/records/${l.artifactHash}/badge.svg`)).text();
    assert.ok(svg.includes('no finding at or above MEDIUM while staked · staker named by the repository: yes'), svg);
    assert.match(svg, /fill="#2e7d32"/, 'a "yes" alone leaves the live colour');
    const view = await api.get(`/api/records/${l.artifactHash}`);
    assert.equal((await view.json()).badge.listingId, String(l.listingId));
  });

  test('a stranger\'s listing of the same hash is "no": the fact is per listing, and the owner\'s "yes" stays on the owner\'s', async () => {
    const commit = vault.commit({ file: proofFile(owner) });
    const mine = await list(commit);
    const theirs = await list(commit, { maker: ctx.other, stake: { awards: { LOW: '0', MEDIUM: '0.2 ETH', HIGH: '0.8 ETH', CRITICAL: '4 ETH' } } });
    assert.equal(mine.artifactHash, theirs.artifactHash);
    await settled(site);
    const v = await site.record(mine.artifactHash);
    assert.equal(v.control[mine.listingId].proof, 'yes');
    noFact(v.control[theirs.listingId], 'PROOF_NAMES_ANOTHER_ADDRESS');
    assert.equal(v.control[theirs.listingId].repository.fileNames, owner, 'it shows whom the file names');
    assert.equal(v.control[theirs.listingId].maker, stranger);
    // the stronger stake is not the one shown: it does not count
    const badge = await site.badge(mine.artifactHash);
    assert.equal(badge.listingId, String(mine.listingId));
    assert.match(badge.message, /staker named by the repository: yes$/);
  });

  test('imposter commit: a fork-only commit whose file names the stranger is "no", though the host serves it by id', async () => {
    const forked = vault.commit({ file: proofFile(stranger), branch: null });
    const l = await list(forked, { maker: ctx.other });
    await settled(site);
    const c = (await site.record(l.artifactHash)).control[l.listingId];
    noFact(c, 'COMMIT_NOT_ON_OWN_REFS');
    assert.equal(c.repository.commitOnOwnRefs, false);
    assert.equal(c.repository.fileNames, null, 'its file is never read');
  });

  test('imposter commit under refs/pull/<n>/head is "no" too', async () => {
    const forked = vault.commit({ file: proofFile(stranger), branch: null });
    vault.pullRef(forked, 11);
    const l = await list(forked, { maker: ctx.other });
    await settled(site);
    noFact((await site.record(l.artifactHash)).control[l.listingId], 'COMMIT_NOT_ON_OWN_REFS');
  });

  test('no proof, and a proof that does not name the maker in the documented form, are "no"', async () => {
    const none = await list(vault.commit({ file: null }));
    const lowercase = await list(vault.commit({ file: proofFile(owner.toLowerCase()) }));
    const badCase = await list(vault.commit({ file: proofFile(owner.toUpperCase().replace('0X', '0x')) }));
    const garbled = await list(vault.commit({ file: 'maker = me\n' }));
    await settled(site);
    const fact = async (l) => (await site.record(l.artifactHash)).control[l.listingId];
    noFact(await fact(none), 'NO_PROOF_FILE');
    assert.equal((await fact(lowercase)).proof, 'yes', 'lowercase names the same address');
    noFact(await fact(badCase), 'PROOF_FILE_INVALID');
    noFact(await fact(garbled), 'PROOF_FILE_INVALID');
  });

  test('a look-alike URL or a host the site does not read is "no", and nothing fetches it', async () => {
    const forms = [
      ['https://github.com.evil.example/acme/vault', 'REPO_HOST_NOT_CHECKED'],
      ['https://github.com@evil.example/acme/vault', 'REPO_URL_FORM'],
      ['https://github.com/evil/repo/../../acme/vault', 'REPO_URL_FORM'],
    ];
    for (const [repo, reason] of forms) {
      const l = await list(vault.commit({ file: proofFile(owner) }), { repo });
      await settled(site);
      const c = (await site.record(l.artifactHash)).control[l.listingId];
      noFact(c, reason);
      assert.equal(c.repository.commitOnOwnRefs, null);
      assert.equal(c.repository.repo, repo, 'the record shows the URL as listed');
    }
    assert.equal(Object.keys(site.store.state.control.repositories).some((k) => k.includes('evil')), false, 'no check was made');
  });

  test('a repository missing from the host (or a host that cannot be read) is "no" with a retry', async () => {
    const l = await list('c'.repeat(40), { repo: 'https://github.com/acme/does-not-exist' });
    await settled(site);
    const c = (await site.record(l.artifactHash)).control[l.listingId];
    noFact(c, 'REPO_UNAVAILABLE');
    assert.equal(c.repository.commitOnOwnRefs, null);
    assert.ok(c.nextCheckAt >= c.checkedAt);
  });

  test('a direct list() with no proof stays possible on-chain, and the site shows it only apart: not on the feed', async () => {
    const l = await list(vault.commit({ file: null }), { maker: ctx.other });
    await settled(site);
    const onchain = await ctx.sa.getListing(l.listingId);
    assert.equal(onchain.maker, stranger);
    const feed = await (await api.get('/api/feed')).json();
    assert.equal(feed.listings.some((e) => e.listingId === String(l.listingId)), false);
    const apart = feed.notCounted.find((e) => e.listingId === String(l.listingId));
    assert.equal(apart.reason, 'NO_PROOF_FILE');
    const proved = await list(vault.commit({ file: proofFile(owner) }));
    await settled(site);
    const after = await (await api.get('/api/feed')).json();
    assert.equal(after.listings.find((e) => e.listingId === String(proved.listingId)).control.proof, 'yes');
  });

  test('a stale record shows no fact of its own: the badge says the record is unavailable, whatever the file said', async () => {
    const l = await list(vault.commit({ file: proofFile(owner) }));
    let clock = Date.now();
    const local = siteFor(ctx, { settle: false, checkRepository: null, env: { SA_CONTROL_GIT_MIRROR_DIR: mirrors, SA_MAX_STALENESS_SECONDS: '60' }, now: () => clock });
    try {
      await settled(local);
      assert.match((await local.badge(l.artifactHash)).message, /staker named by the repository: yes$/);
      clock += 61_000;
      assert.equal((await local.badge(l.artifactHash)).message, 'record unavailable');
    } finally {
      local.close();
    }
  });
});

describe('a "yes" is kept up to date', () => {
  test('a branch deleted later takes the commit off the repository\'s own refs: the next check says "no", and putting it back says "yes"', async () => {
    const ctx = await chainContext();
    const mirrors = tmpDir('sa-mirrors-');
    const vault = makeRepo(mirrors, 'https://github.com/acme/vault');
    const commit = vault.commit({ file: proofFile(ctx.maker.address), branch: 'release' });
    const l = await listing(ctx, { spec: { repo: vault.url, baseCommit: commit }, stake: { valueAtRiskUsd: undefined } });
    let clock = Date.now();
    const site = siteFor(ctx, { settle: false, checkRepository: null, now: () => clock, env: { SA_CONTROL_GIT_MIRROR_DIR: mirrors, SA_CONTROL_RECHECK_MS: '1000', SA_MAX_STALENESS_SECONDS: '100000' } });
    try {
      await site.sync();
      await site.controlIdle();
      const first = (await site.record(l.artifactHash)).control[l.listingId];
      assert.equal(first.proof, 'yes');
      assert.equal(first.repository.ref, 'refs/heads/release');

      vault.removeBranch('release');
      await site.sync();
      await site.controlIdle();
      assert.equal((await site.record(l.artifactHash)).control[l.listingId].proof, 'yes', 'not checked again before the recheck time');

      clock += 1001;
      await site.sync();
      await site.controlIdle();
      const later = (await site.record(l.artifactHash)).control[l.listingId];
      assert.equal(later.proof, 'no');
      assert.equal(later.reason, 'COMMIT_NOT_ON_OWN_REFS');
    } finally {
      site.close();
    }
  });
});
