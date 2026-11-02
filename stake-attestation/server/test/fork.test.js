// Node P9: the record labels a fork from the host's API where it has one, in the background and
// bounded, with an optional token from the environment. An unknown answer says unknown, and a plain
// copy is stated as undetectable. No test reaches a host: every fetch here is a stand-in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { wordingProblems } from '@verdikta/stake-attestation-shared';
import { FORK_NOTE, createForkChecker } from '../src/control/forkCheck.js';
import { chainContext, listing, settled, siteFor } from './helpers/scenario.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function checker(answer, { env = {} } = {}) {
  const seen = [];
  const check = createForkChecker({ timeoutMs: 200, env, fetch: async (url, init) => { seen.push({ url: String(url), init }); return answer(String(url), init); } });
  return { check, seen };
}

describe('the host\'s answer', () => {
  test('GitHub: a fork, with its parent, read from the repository\'s fork link', async () => {
    const { check, seen } = checker(() => json({ fork: true, parent: { html_url: 'https://github.com/acme/vault' }, source: { html_url: 'https://github.com/acme/vault' } }));
    const r = await check({ repo: 'https://github.com/stranger/vault' });
    assert.deepEqual(r, { status: 'fork', parent: 'https://github.com/acme/vault', host: 'github.com' });
    assert.equal(seen[0].url, 'https://api.github.com/repos/stranger/vault');
    assert.equal(seen[0].init.headers.authorization, undefined, 'no token unless the environment has one');
  });

  test('GitHub: not a fork', async () => {
    const { check } = checker(() => json({ fork: false }));
    assert.deepEqual(await check({ repo: 'https://github.com/acme/vault.git' }), { status: 'not-fork', parent: null, host: 'github.com' });
  });

  test('the token comes from the environment only, and only ever goes to GitHub', async () => {
    const { check, seen } = checker(() => json({ fork: false }), { env: { SA_GITHUB_TOKEN: 'tok-123' } });
    await check({ repo: 'https://github.com/acme/vault' });
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok-123');
    const other = checker(() => json({ fork: false }), { env: { SA_GITHUB_TOKEN: 'tok-123' } });
    await other.check({ repo: 'https://codeberg.org/acme/vault' });
    assert.equal(other.seen[0].init.headers.authorization, undefined);
  });

  test('rate limited, an error, a hang, a body too large or a shape it does not know: unknown, with when to ask again', async () => {
    const limited = checker(() => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }));
    const a = await limited.check({ repo: 'https://github.com/acme/vault' });
    assert.equal(a.status, 'unknown');
    assert.equal(a.reason, 'RATE_LIMITED');
    assert.ok(a.retryAfterMs > 500_000);

    assert.equal((await checker(() => json({}, { status: 404 })).check({ repo: 'https://github.com/acme/vault' })).status, 'unknown');
    assert.equal((await checker(() => { throw new Error('network'); }).check({ repo: 'https://github.com/acme/vault' })).status, 'unknown');
    assert.equal((await checker(() => new Response('<html>')).check({ repo: 'https://github.com/acme/vault' })).status, 'unknown');
    assert.equal((await checker(() => json({ fork: 'yes' })).check({ repo: 'https://github.com/acme/vault' })).status, 'unknown');

    const hang = createForkChecker({ timeoutMs: 50, env: {}, fetch: (_u, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
    assert.equal((await hang({ repo: 'https://github.com/acme/vault' })).status, 'unknown');

    const huge = createForkChecker({ timeoutMs: 1000, maxBytes: 1024, env: {}, fetch: async () => new Response('x'.repeat(4096)) });
    assert.equal((await huge({ repo: 'https://github.com/acme/vault' })).status, 'unknown');
  });

  test('a parent URL the host gives in another form is not repeated', async () => {
    const { check } = checker(() => json({ fork: true, parent: { html_url: 'javascript:alert(1)' } }));
    assert.deepEqual(await check({ repo: 'https://github.com/stranger/vault' }), { status: 'fork', parent: null, host: 'github.com' });
  });

  test('a host with no API the site knows, or a URL it does not read: unknown, and nothing is fetched', async () => {
    const { check, seen } = checker(() => json({}));
    assert.equal((await check({ repo: 'https://git.example.org/acme/vault' })).status, 'unknown');
    assert.equal((await check({ repo: 'https://github.com/acme/vault/extra' })).status, 'unknown');
    assert.equal(seen.length, 0);
  });

  test('GitLab, Codeberg and Bitbucket, from their own APIs', async () => {
    const gitlab = checker(() => json({ forked_from_project: { web_url: 'https://gitlab.com/acme/vault' } }));
    assert.deepEqual(await gitlab.check({ repo: 'https://gitlab.com/stranger/vault' }), { status: 'fork', parent: 'https://gitlab.com/acme/vault', host: 'gitlab.com' });
    assert.equal(gitlab.seen[0].url, 'https://gitlab.com/api/v4/projects/stranger%2Fvault');
    const codeberg = checker(() => json({ fork: true, parent: { html_url: 'https://codeberg.org/acme/vault' } }));
    assert.deepEqual(await codeberg.check({ repo: 'https://codeberg.org/stranger/vault' }), { status: 'fork', parent: 'https://codeberg.org/acme/vault', host: 'codeberg.org' });
    assert.equal(codeberg.seen[0].url, 'https://codeberg.org/api/v1/repos/stranger/vault');
    const bitbucket = checker(() => json({ parent: { links: { html: { href: 'https://bitbucket.org/acme/vault' } } } }));
    assert.deepEqual(await bitbucket.check({ repo: 'https://bitbucket.org/stranger/vault' }), { status: 'fork', parent: 'https://bitbucket.org/acme/vault', host: 'bitbucket.org' });
    assert.equal(bitbucket.seen[0].url, 'https://api.bitbucket.org/2.0/repositories/stranger/vault');
    const plain = checker(() => json({ name: 'vault' }));
    assert.equal((await plain.check({ repo: 'https://bitbucket.org/acme/vault' })).status, 'not-fork');
  });

  test('the note on plain copies passes the wording rule', () => {
    assert.match(FORK_NOTE, /plain copy/i);
    assert.match(FORK_NOTE, /cannot be detected/);
    assert.deepEqual(wordingProblems(FORK_NOTE), []);
  });
});

describe('on the record', () => {
  test('a fork is labelled, in the background, and nothing waits for it', async () => {
    const ctx = await chainContext();
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const site = siteFor(ctx, { checkFork: async () => { calls += 1; await gate; return { status: 'fork', parent: 'https://github.com/acme/vault', host: 'github.com' }; } });
    try {
      const l = await listing(ctx);
      await site.sync(); // settled or not, the sync does not wait for the host
      await site.archivesIdle();
      const before = await site.record(l.artifactHash);
      assert.equal(before.fork.status, 'unknown');
      assert.match(before.fork.note, /plain copy/i);
      release();
      await settled(site);
      assert.ok(calls >= 1);
      const v = await site.record(l.artifactHash);
      assert.deepEqual([v.fork.status, v.fork.parent], ['fork', 'https://github.com/acme/vault']);
    } finally {
      release();
      site.close();
    }
  });

  test('bounded: a run asks about a few repositories, and an unknown answer is asked again later', async () => {
    const ctx = await chainContext();
    const asked = [];
    let t = 1_900_000_000_000;
    const site = siteFor(ctx, { now: () => t, env: { SA_CONTROL_RETRY_MS: '1000', SA_MAX_STALENESS_SECONDS: '2000000000' }, checkFork: async ({ repo }) => { asked.push(repo); return { status: 'unknown', parent: null, host: 'github.com', reason: 'UNAVAILABLE' }; } });
    try {
      const made = [];
      for (let i = 0; i < 6; i += 1) made.push(await listing(ctx, { spec: { repo: `https://github.com/acme/repo-${i}` } }));
      await site.sync();
      await site.controlIdle();
      assert.ok(asked.length <= 4, `asked ${asked.length} in one run`);
      await settled(site);
      assert.equal(new Set(asked).size, 6);
      const count = asked.length;
      await settled(site);
      assert.equal(asked.length, count, 'not again before its wait is over');
      t += 10_000;
      await settled(site);
      assert.ok(asked.length > count, 'asked again after it');
    } finally {
      site.close();
    }
  });
});
