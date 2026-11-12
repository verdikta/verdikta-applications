// Node P8, acceptance 5: verification runs beside the indexer and the keeper, never inside them. A
// git host that hangs or fails leaves the fact "no" with a retry; a check is bounded in time and
// its output in size; and the facts survive a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRepositoryChecker } from '../src/control/gitCheck.js';
import { CONTROL_FILE, proofFile } from './helpers/gitRepo.js';
import { chainContext, freshCommit, listing, revealedClaim, siteFor, tmpDir, verdict } from './helpers/scenario.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-control-check.js', import.meta.url));

const answer = (maker, commit) => ({
  version: 1,
  repo: 'https://github.com/acme/vault',
  commit,
  reachable: true,
  ref: 'refs/heads/main',
  file: { path: CONTROL_FILE, mode: '100644', blob: 'a'.repeat(40), size: 60, text: proofFile(maker), problem: null },
});

const listedCommit = async (ctx, over = {}) => {
  const baseCommit = freshCommit();
  const l = await listing(ctx, { spec: { baseCommit }, stake: { valueAtRiskUsd: undefined }, ...over });
  return { ...l, baseCommit };
};

test('a check that hangs blocks neither the indexer nor the keeper, and the fact stays "no" meanwhile', async () => {
  const ctx = await chainContext();
  const l = await listedCommit(ctx);
  let started = 0;
  let release;
  const hung = new Promise((r) => { release = r; });
  const site = siteFor(ctx, { settle: false,
    checkRepository: async () => {
      started += 1;
      await hung;
      return answer(ctx.maker.address, l.baseCommit);
    },
  });
  try {
    await site.sync();
    const cursor = site.store.state.cursor.number;
    assert.equal(started, 1);

    // the record answers while the check hangs
    const during = (await site.record(l.artifactHash)).control[l.listingId];
    assert.equal(during.proof, 'no');
    assert.equal(during.reason, 'NOT_CHECKED_YET');
    assert.equal(during.checkedAt, null);

    // the chain moves on and the keeper works: a claim judged is finalized
    const claim = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
    await verdict(ctx, claim, 'INVALID');
    await site.sync();
    assert.ok(site.store.state.cursor.number > cursor, 'the cursor moved on while the check hung');
    const kept = await site.keep();
    assert.ok(kept.sent.length >= 1, 'the keeper acted while the check hung');
    assert.equal(started, 1, 'one run at a time: no second check started beside the hung one');

    release();
    await site.controlIdle();
    assert.equal((await site.record(l.artifactHash)).control[l.listingId].proof, 'yes');
  } finally {
    site.close();
  }
});

test('a git host that fails leaves "no" with a retry that backs off, and a later answer stands', async () => {
  const ctx = await chainContext();
  const l = await listedCommit(ctx);
  let clock = Date.now();
  const calls = [];
  let answerNow = null;
  const site = siteFor(ctx, { settle: false,
    now: () => clock,
    env: { SA_CONTROL_RETRY_MS: '1000', SA_MAX_STALENESS_SECONDS: '100000' },
    checkRepository: async ({ repo, commit }) => {
      calls.push({ repo, commit });
      if (answerNow) return answerNow;
      throw Object.assign(new Error('git host down'), { code: 'REPO_UNAVAILABLE' });
    },
  });
  const round = async () => {
    await site.sync();
    await site.controlIdle();
  };
  const fact = async () => (await site.record(l.artifactHash)).control[l.listingId];
  try {
    await round();
    assert.deepEqual(calls, [{ repo: 'https://github.com/acme/vault', commit: l.baseCommit }]);
    let c = await fact();
    assert.equal(c.proof, 'no');
    assert.equal(c.reason, 'REPO_UNAVAILABLE');
    assert.equal(c.repository.commitOnOwnRefs, null);
    assert.equal(c.nextCheckAt, Math.floor((clock + 1000) / 1000));

    await round();
    assert.equal(calls.length, 1, 'not before its retry time');

    clock += 1001;
    await round();
    assert.equal(calls.length, 2);
    c = await fact();
    assert.equal(c.nextCheckAt, Math.floor((clock + 2000) / 1000), 'the wait doubles');

    clock += 2001;
    answerNow = answer(ctx.maker.address, l.baseCommit);
    await round();
    assert.equal((await fact()).proof, 'yes');
  } finally {
    site.close();
  }
});

test('a failed re-check keeps the answer on file for a while, and says so: a host down for an hour drops no honest listing; down for a week it does', async () => {
  const ctx = await chainContext();
  const l = await listedCommit(ctx);
  let clock = Date.now();
  let down = false;
  const site = siteFor(ctx, { settle: false,
    now: () => clock,
    env: { SA_CONTROL_RECHECK_MS: '1000', SA_MAX_STALENESS_SECONDS: '100000' },
    checkRepository: async () => {
      if (down) throw Object.assign(new Error('down'), { code: 'REPO_UNAVAILABLE' });
      return answer(ctx.maker.address, l.baseCommit);
    },
  });
  try {
    await site.sync();
    await site.controlIdle();
    assert.equal((await site.record(l.artifactHash)).control[l.listingId].proof, 'yes');
    down = true;
    clock += 1001;
    await site.sync();
    await site.controlIdle();
    const c = (await site.record(l.artifactHash)).control[l.listingId];
    assert.equal(c.proof, 'yes');
    assert.equal(c.repository.lastCheckFailed, 'REPO_UNAVAILABLE');
    // the limit holds between checks too: no run has to fail after it for the answer to stop counting
    clock += 8 * 86400_000;
    const later = (await site.record(l.artifactHash)).control[l.listingId];
    assert.equal(later.proof, 'no');
    assert.equal(later.reason, 'REPO_UNAVAILABLE');
    assert.equal(later.repository.commitOnOwnRefs, null, 'nothing is shown from the answer it outlived');
    await site.sync();
    await site.controlIdle();
    assert.equal((await site.record(l.artifactHash)).control[l.listingId].reason, 'REPO_UNAVAILABLE');
  } finally {
    site.close();
  }
});

test('one repository at a commit is checked once, however many listings name it; a run is bounded and the next one carries on', async () => {
  const ctx = await chainContext();
  const baseCommit = freshCommit();
  await listing(ctx, { spec: { baseCommit }, stake: { valueAtRiskUsd: undefined } });
  await listing(ctx, { maker: ctx.other, spec: { baseCommit }, stake: { valueAtRiskUsd: undefined } });
  for (let i = 0; i < 6; i += 1) await listing(ctx, { spec: { baseCommit: freshCommit() }, stake: { valueAtRiskUsd: undefined } });
  const seen = [];
  const site = siteFor(ctx, { settle: false,
    checkRepository: async ({ commit }) => {
      seen.push(commit);
      return { ...answer(ctx.maker.address, commit), file: null };
    },
  });
  try {
    await site.sync();
    await site.controlIdle();
    assert.equal(seen.length, 4, 'at most four checks a run');
    await site.sync();
    await site.controlIdle();
    assert.equal(seen.length, 7, 'the rest in the next: seven distinct commits, one check each');
    assert.equal(new Set(seen).size, 7);
    assert.equal(seen.filter((c) => c === baseCommit).length, 1);
  } finally {
    site.close();
  }
});

test('facts survive a restart, and a state file from before this node loads', async () => {
  const ctx = await chainContext();
  const l = await listedCommit(ctx);
  const dir = tmpDir();
  const first = siteFor(ctx, { settle: false, dir, checkRepository: async () => answer(ctx.maker.address, l.baseCommit) });
  await first.sync();
  await first.controlIdle();
  first.close();

  const second = siteFor(ctx, { settle: false, dir, checkRepository: async () => assert.fail('checked again') });
  await second.sync();
  assert.equal((await second.record(l.artifactHash)).control[l.listingId].proof, 'yes');
  await second.controlIdle();
  second.close();

  // the same folder as P4b1 wrote it: no control key
  const file = path.join(dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.control;
  fs.writeFileSync(file, JSON.stringify(state));
  const third = siteFor(ctx, { settle: false, dir, checkRepository: async () => { throw Object.assign(new Error('down'), { code: 'REPO_UNAVAILABLE' }); } });
  try {
    await third.sync();
    assert.equal((await third.record(l.artifactHash)).control[l.listingId].proof, 'no');
    await third.controlIdle();
  } finally {
    third.close();
  }
});

test('a check that throws something unexpected leaves "no" and logs the code, and the loop goes on', async () => {
  const ctx = await chainContext();
  const l = await listedCommit(ctx);
  const site = siteFor(ctx, { settle: false, checkRepository: async () => { throw new Error('boom with https://secret@example'); } });
  try {
    await site.sync();
    await site.controlIdle();
    const c = (await site.record(l.artifactHash)).control[l.listingId];
    assert.equal(c.proof, 'no');
    assert.equal(c.reason, 'REPO_UNAVAILABLE');
    assert.equal(site.logger.lines.some((line) => line.includes('secret')), false);
    await site.sync();
    await site.controlIdle();
  } finally {
    site.close();
  }
});

// the real process the site runs: time and size are bounded, and what it prints is checked

function checker(dir, mode, over = {}) {
  fs.writeFileSync(path.join(dir, 'mode'), mode);
  return createRepositoryChecker({
    bin: FAKE,
    workDir: dir,
    mirrorDir: null,
    timeoutMs: 300,
    maxBytes: 1024,
    ...over,
  }, { mirrorFor: () => path.join(dir, 'mode') });
}

const ARGS = { repo: 'https://github.com/acme/vault', commit: 'a'.repeat(40) };

test('the check\'s process is stopped at its time limit, even one ignoring SIGTERM, and leaves no folder behind', async () => {
  for (const mode of ['hang', 'hang-ignoring-sigterm']) {
    const dir = tmpDir('sa-control-');
    const started = Date.now();
    await assert.rejects(checker(dir, mode, { graceMs: 100 })(ARGS), (err) => err.code === 'REPO_UNAVAILABLE');
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('sa-control-')), []);
  }
});

test('what the process prints must be an answer about this commit', async () => {
  const dir = tmpDir('sa-control-');
  for (const mode of ['not-json', 'wrong-shape', 'other-commit', 'fails']) {
    await assert.rejects(checker(dir, mode, { timeoutMs: 20000 })(ARGS), (err) => err.code === 'REPO_UNAVAILABLE', mode);
  }
  await assert.rejects(checker(dir, 'too-large', { timeoutMs: 20000 })(ARGS), (err) => err.code === 'REPO_TOO_LARGE');
});
