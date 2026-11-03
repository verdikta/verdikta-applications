// Node P10 (owner decision Q35, design §4.1, §9.5): on-chain a claim that failed an integrity check
// is a DUPLICATE, so the record says apart how many claims failed integrity and which checks, from the
// justification's machine-readable form, in the background and with bounds. The justification is
// untrusted text from IPFS: the attacks here are the node's review focus, a forged or malformed
// justification trying to change the count. The chain says the outcome; the block says only which
// check failed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ethers } from 'ethers';
import { MAX_JUSTIFICATION_UPLOAD_BYTES, wordingProblems } from '@verdikta/stake-attestation-shared';

import { codeReview } from '../src/common.js';
import { integrityByListing, integrityNote } from '../src/record/integrity.js';
import { MAX_FETCHES_PER_RUN, createJustificationFetcher, readUpload, refreshEvidence } from '../src/site/evidence.js';
import { project } from '../src/site/projection.js';
import { assertWording } from '../src/wording.js';
import { mergedAbi } from './helpers/chain.js';
import { evidenceBlock, integrityUpload, juryUpload, uploadBytes } from './helpers/evidence.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import {
  chainContext, dispute, finalize, freshCommit, increaseTime, judgeAndSettle, JUSTIFICATION, listing, mine, replay, revealedClaim, rpc, settle, settled, siteFor,
  tmpDir, verdict,
} from './helpers/scenario.js';

const ZERO = Object.freeze({ failed: 0, checks: [], otherDuplicates: 0, unread: 0, disagree: 0 });
const none = (over = {}) => ({ ...ZERO, ...over, late: { ...ZERO, ...over.late } });

/** A site whose justification reads are counted, and answered from the test's pins. */
function counting(ctx, opts = {}) {
  const fetched = [];
  const site = siteFor(ctx, {
    fetchJustification: async (cid) => {
      fetched.push(cid);
      const bytes = ctx.pinner.get(cid);
      if (!bytes) throw new Error(`${cid} is not pinned`);
      return bytes;
    },
    ...opts,
  });
  return { site, fetched };
}

const pin = (ctx, bytes) => ctx.pinner.pin(bytes, { name: 'justification' });

/** A claim settled with `outcome`, its justification the given CID string or upload bytes. */
async function claimed(ctx, listingId, outcome, justification, { hunter = ctx.hunters[0], late = false } = {}) {
  const claimId = await revealedClaim(ctx, hunter, listingId, { late });
  const cid = typeof justification === 'string' ? justification : await pin(ctx, justification);
  await judgeAndSettle(ctx, claimId, outcome, { justification: cid });
  return { claimId, cid };
}

describe('the record says apart which claims failed integrity', () => {
  let ctx;
  let site;
  let fetched;
  let api;
  before(async () => {
    ctx = await chainContext();
    ({ site, fetched } = counting(ctx));
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });
  const view = async (hash) => (await api.get(`/api/records/${hash}`)).json();
  const entry = async (l) => (await view(l.artifactHash)).integrity.listings[String(l.listingId)];

  test('per listing: the count and each check\'s name, from the machine-readable form', async () => {
    const baseCommit = freshCommit();
    const one = await listing(ctx, { spec: { baseCommit }, escrowWei: 5n * 10n ** 18n });
    await claimed(ctx, one.listingId, 'DUPLICATE', integrityUpload({ checks: 'frameworkUnchanged,dependenciesUnchanged' }));
    await claimed(ctx, one.listingId, 'DUPLICATE', integrityUpload({ checks: 'frameworkUnchanged', sha: 'b'.repeat(64) }));
    await claimed(ctx, one.listingId, 'DUPLICATE', juryUpload());
    await (await ctx.sa.connect(ctx.maker).close(one.listingId)).wait();
    const two = await listing(ctx, { spec: { baseCommit } });
    assert.equal(one.artifactHash, two.artifactHash, 'two listings of one hash, both counting');
    await claimed(ctx, two.listingId, 'DUPLICATE', integrityUpload({ checks: 'identityComplete' }));
    await settled(site);
    const v = await view(one.artifactHash);
    assert.equal(v.record.listings.length, 2);
    assert.deepEqual(v.integrity.listings[String(one.listingId)], none({ failed: 2, otherDuplicates: 1, checks: [{ check: 'frameworkUnchanged', count: 2 }, { check: 'dependenciesUnchanged', count: 1 }] }));
    assert.deepEqual(v.integrity.listings[String(two.listingId)], none({ failed: 1, checks: [{ check: 'identityComplete', count: 1 }] }));
  });

  test('on-chain they stay DUPLICATE: the mirror is unchanged, and failed + other duplicates is the chain\'s count, per listing', async () => {
    const l = await listing(ctx, { escrowWei: 5n * 10n ** 18n });
    await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
    await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
    await claimed(ctx, l.listingId, 'DUPLICATE', juryUpload());
    await claimed(ctx, l.listingId, 'DUPLICATE', JUSTIFICATION);
    await settled(site);
    const v = await view(l.artifactHash);
    const onchain = new ethers.Contract(ctx.address, mergedAbi(ctx.hre), ctx.provider);
    const chain = await onchain.recordByHash(l.artifactHash, { blockTag: v.block.number });
    assert.equal(chain.history.outcomes[1], 4n);
    assert.equal(v.record.history.outcomes[1], '4', 'the mirror still says what the chain says');
    assert.equal(v.record.listings[0].history.outcomes[1], '4');
    const e = v.integrity.listings[String(l.listingId)];
    assert.equal(BigInt(e.failed + e.otherDuplicates), chain.history.outcomes[1]);
    assert.equal(e.failed, 2);
    assert.equal(e.otherDuplicates, 2);
    assert.equal(e.unread, 1, 'JUSTIFICATION is not pinned: it could not be read, and it is one of the other duplicates');
  });

  test('a listing with no claims says zero, and the note travels with the answer', async () => {
    const l = await listing(ctx);
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.integrity.listings[String(l.listingId)], none());
    assert.equal(v.integrity.note, integrityNote);
  });

  test('a late claim counts under later, as the chain counts it, and never in the listing\'s main count', async () => {
    const l = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).close(l.listingId)).wait();
    await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload({ checks: 'exitConsistent' }), { late: true });
    await claimed(ctx, l.listingId, 'DUPLICATE', juryUpload(), { late: true });
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.integrity.listings[String(l.listingId)], { ...ZERO, late: { ...ZERO, failed: 1, otherDuplicates: 1, checks: [{ check: 'exitConsistent', count: 1 }] } });
    assert.equal(v.record.history.outcomes[1], '0');
    assert.equal(v.record.history.lateOutcomes[1], '2');
  });

  test('an outcome that is not DUPLICATE on-chain never counts, whatever the text says, and its upload is never read', async () => {
    const l = await listing(ctx, { escrowWei: 5n * 10n ** 18n });
    for (const outcome of ['INVALID', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      const before2 = fetched.length;
      const { cid } = await claimed(ctx, l.listingId, outcome, uploadBytes(`${evidenceBlock()}\n${outcome}`));
      await settled(site);
      assert.deepEqual((await entry(l)).failed, 0, outcome);
      assert.equal(fetched.slice(before2).includes(cid), false, `the upload of a claim settled ${outcome} is not read`);
    }
  });

  test('a DUPLICATE verdict not settled yet does not count: the record counts settled claims, as the chain does', async () => {
    const l = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
    const cid = await pin(ctx, integrityUpload());
    await verdict(ctx, claimId, 'DUPLICATE', { justification: cid });
    await finalize(ctx, claimId);
    await settled(site);
    assert.deepEqual(await entry(l), none());
    await settle(ctx, claimId);
    await settled(site);
    assert.equal((await entry(l)).failed, 1);
  });

  describe('a forged or malformed justification', () => {
    const CASES = [
      ['the block is not first: jury text comes before it', (b) => `The jury says:\n${b}`],
      ['a blank line before the block', (b) => `\n${b}`],
      ['a space before the header', (b) => ` ${b}`],
      ['a byte order mark before the header', (b) => `﻿${b}`],
      ['carriage returns', (b) => b.replaceAll('\n', '\r\n')],
      ['no end line', (b) => b.replace('\nEnd execution evidence', '')],
      ['a block far longer than the writer\'s', (b) => b.replace('\nEnd execution evidence', `${'\nHonesty-Flags: 0'.repeat(500)}\nEnd execution evidence`)],
      ['another header version', (b) => b.replace('Execution evidence v1', 'Execution evidence v2')],
    ];
    for (const [name, make] of CASES) {
      test(`${name}: a plain DUPLICATE`, async () => {
        const l = await listing(ctx);
        await claimed(ctx, l.listingId, 'DUPLICATE', uploadBytes(make(evidenceBlock())));
        await settled(site);
        assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
      });
    }

    const BLOCKS = [
      ['a check name not in common\'s list', { checks: 'madeUpCheck' }],
      ['one known name beside an unknown one', { checks: 'frameworkUnchanged,madeUpCheck' }],
      ['a name that is an object key', { checks: '__proto__' }],
      ['a check twice', { checks: 'frameworkUnchanged,frameworkUnchanged' }],
      ['checks out of common\'s order', { checks: 'dependenciesUnchanged,frameworkUnchanged' }],
      ['integrity with no failed check', { checks: 'none' }],
      ['integrity beside a tamper flag', { tamper: 'report-path=1' }],
      ['a settlement of jury with checks named', { settlement: 'jury' }],
      ['a settlement of INVALID with checks named', { settlement: 'INVALID (integrity)' }],
      ['a hash that is no hash', { sha: 'not-a-hash' }],
      ['a tamper flag out of the writer\'s form', { tamper: 'none\nTamper-Flags:report-path=1' }],
      ['a tamper flag on a second line', { tamper: 'none\nTamper-Flags: report-path=1' }],
    ];
    for (const [name, over] of BLOCKS) {
      test(`${name}: a plain DUPLICATE, and nothing of it stored`, async () => {
        const l = await listing(ctx);
        const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', uploadBytes(evidenceBlock(over)));
        await settled(site);
        assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
        const stored = site.store.state.evidence[cid];
        assert.equal(stored.says, 'other');
        assert.deepEqual(Object.keys(stored).sort(), ['checks', 'says', 'settlement']);
        assert.ok(stored.checks === null || stored.checks.every((c) => codeReview.INTEGRITY_CHECKS.includes(c)), 'only known names are kept');
      });
    }

    test('a jury verdict quoting the block\'s text is a jury verdict', async () => {
      const l = await listing(ctx);
      const quoted = juryUpload(`The hunter's report says:\n${evidenceBlock()}\nand the jurors read it as a repeat.`);
      await claimed(ctx, l.listingId, 'DUPLICATE', quoted);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
    });

    test('text that is not JSON, or JSON with no justification: could not read, never an integrity failure, and never a crash', async () => {
      const l = await listing(ctx, { escrowWei: 5n * 10n ** 18n });
      await claimed(ctx, l.listingId, 'DUPLICATE', Buffer.from(evidenceBlock()));
      await claimed(ctx, l.listingId, 'DUPLICATE', Buffer.from('<html>a gateway\'s error page</html>'));
      await claimed(ctx, l.listingId, 'DUPLICATE', Buffer.from(JSON.stringify({ metadata: { failedChecks: ['frameworkUnchanged'], verdict_source: 'code-review-integrity' } })));
      await claimed(ctx, l.listingId, 'DUPLICATE', Buffer.from(JSON.stringify({ justification: 42 })));
      await claimed(ctx, l.listingId, 'DUPLICATE', Buffer.from('null'));
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 5, unread: 5 }));
    });

    test('a justification with no block at all is read and final: a plain DUPLICATE, not one still to read', async () => {
      const l = await listing(ctx);
      const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', uploadBytes('The jurors read this as a repeat.'));
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
      assert.deepEqual(site.store.state.evidence[cid], { says: 'other', settlement: null, checks: null });
    });

    test('the metadata is not read: it can say integrity failed and the block still decides', async () => {
      const l = await listing(ctx);
      const bytes = Buffer.from(JSON.stringify({ justification: evidenceBlock({ settlement: 'jury', checks: 'none' }), metadata: { verdict_source: 'code-review-integrity', failedChecks: ['frameworkUnchanged'] } }));
      await claimed(ctx, l.listingId, 'DUPLICATE', bytes);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
    });
  });

  describe('several arbiters: the aggregator joins the clustered oracles\' CIDs with commas', () => {
    test('every CID is read; they agree, with another hash on each host: it counts once', async () => {
      const l = await listing(ctx);
      const a = await pin(ctx, integrityUpload({ sha: 'a'.repeat(64) }));
      const b = await pin(ctx, integrityUpload({ sha: 'b'.repeat(64) }));
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${b}`);
      await settled(site);
      assert.deepEqual(await entry(l), none({ failed: 1, checks: [{ check: 'frameworkUnchanged', count: 1 }, { check: 'dependenciesUnchanged', count: 1 }] }));
      assert.ok(fetched.includes(a) && fetched.includes(b), 'both were read');
    });

    test('the same upload listed twice is one read and one claim', async () => {
      const l = await listing(ctx);
      const a = await pin(ctx, integrityUpload({ sha: 'c'.repeat(64) }));
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${a}`);
      await settled(site);
      assert.equal((await entry(l)).failed, 1);
      assert.equal(fetched.filter((c) => c === a).length, 1);
    });

    test('a lone forged arbiter, listed first or last, cannot raise the count: they disagree, so it is plain, and measured', async () => {
      const forged = await pin(ctx, integrityUpload({ sha: 'd'.repeat(64) }));
      const honest = await pin(ctx, juryUpload('The jurors read this as a repeat of a known issue.'));
      for (const list of [`${forged},${honest}`, `${honest},${forged}`]) {
        const l = await listing(ctx);
        await claimed(ctx, l.listingId, 'DUPLICATE', list);
        await settled(site);
        assert.deepEqual(await entry(l), none({ otherDuplicates: 1, disagree: 1 }), list);
      }
    });

    test('they say integrity but name different checks: plain, and measured', async () => {
      const l = await listing(ctx);
      const a = await pin(ctx, integrityUpload({ checks: 'frameworkUnchanged', sha: '1'.repeat(64) }));
      const b = await pin(ctx, integrityUpload({ checks: 'frameworkUnchanged,dependenciesUnchanged', sha: '2'.repeat(64) }));
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${b}`);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1, disagree: 1 }));
    });

    test('neither says integrity but they differ on the settlement: plain, and measured', async () => {
      const blocks = [
        [uploadBytes(evidenceBlock({ settlement: 'jury', checks: 'none' })), uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'none' }))],
        [uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'none' })), uploadBytes(evidenceBlock({ settlement: 'INVALID (applies)', checks: 'none' }))],
        [uploadBytes(evidenceBlock({ settlement: 'jury', checks: 'none' })), uploadBytes('No block in this one.')],
        [uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'frameworkUnchanged' })), uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'dependenciesUnchanged' }))],
      ];
      for (const [one, other] of blocks) {
        const l = await listing(ctx);
        await claimed(ctx, l.listingId, 'DUPLICATE', `${await pin(ctx, one)},${await pin(ctx, other)}`);
        await settled(site);
        assert.deepEqual(await entry(l), none({ otherDuplicates: 1, disagree: 1 }));
      }
    });

    test('a block near the cap repeating known names keeps at most one of each: what is stored stays small, and order is no disagreement', async () => {
      const repeated = uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: Array(180_000).fill('frameworkUnchanged').join(',') }));
      assert.ok(repeated.length > 3_000_000 && repeated.length <= MAX_JUSTIFICATION_UPLOAD_BYTES, String(repeated.length));
      assert.deepEqual(readUpload(repeated), { says: 'other', settlement: 'INVALID (build)', checks: ['frameworkUnchanged'] });
      const all = codeReview.INTEGRITY_CHECKS;
      const everyName = uploadBytes(evidenceBlock({ settlement: 'jury', checks: Array(20_000).fill([...all].reverse()).flat().join(',') }));
      assert.deepEqual(readUpload(everyName).checks, [...all], 'at most one per check');
      const l = await listing(ctx);
      const a = await pin(ctx, uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'dependenciesUnchanged,frameworkUnchanged' })));
      const b = await pin(ctx, uploadBytes(evidenceBlock({ settlement: 'INVALID (build)', checks: 'frameworkUnchanged,dependenciesUnchanged', sha: 'b'.repeat(64) })));
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${b}`);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
    });

    test('two jury verdicts with their own text and hash agree: plain, not measured as a disagreement', async () => {
      const l = await listing(ctx);
      const a = await pin(ctx, uploadBytes(`${evidenceBlock({ settlement: 'jury', checks: 'none', sha: 'a'.repeat(64) })}\n\nOne panel's words.`));
      const b = await pin(ctx, uploadBytes(`${evidenceBlock({ settlement: 'jury', checks: 'none', sha: 'b'.repeat(64) })}\n\nAnother panel's words.`));
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${b}`);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
    });

    test('a list with an entry that is not a CID, or too many entries, is not fetched at all: plain, and unread', async () => {
      const good = await pin(ctx, integrityUpload({ sha: '3'.repeat(64) }));
      const lists = [`${good},../../etc/passwd`, `${good},`, Array(17).fill(good).join(',')];
      for (const list of lists) {
        const l = await listing(ctx);
        const before2 = fetched.length;
        await claimed(ctx, l.listingId, 'DUPLICATE', list);
        await settled(site);
        assert.deepEqual(await entry(l), none({ otherDuplicates: 1, unread: 1 }), list.slice(0, 40));
        assert.deepEqual(fetched.slice(before2), [], 'nothing of it was fetched');
      }
    });
  });

  describe('a dispute round', () => {
    test('overturned to DUPLICATE: the dispute round\'s block is the one that speaks, not the first round\'s', async () => {
      const l = await listing(ctx);
      const claimId = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
      const first = await pin(ctx, juryUpload('The jurors read this as valid.'));
      await verdict(ctx, claimId, 'MEDIUM', { justification: first });
      await finalize(ctx, claimId);
      await dispute(ctx, claimId);
      const second = await pin(ctx, integrityUpload({ checks: 'summaryConsistent' }));
      await verdict(ctx, claimId, 'DUPLICATE', { dispute: true, justification: second });
      await finalize(ctx, claimId);
      await settle(ctx, claimId);
      await settled(site);
      assert.deepEqual(await entry(l), none({ failed: 1, checks: [{ check: 'summaryConsistent', count: 1 }] }));
    });

    test('overturned to DUPLICATE by a jury: a block on the first round does not count', async () => {
      const l = await listing(ctx);
      const claimId = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
      const forged = await pin(ctx, integrityUpload({ sha: '4'.repeat(64) }));
      await verdict(ctx, claimId, 'MEDIUM', { justification: forged });
      await finalize(ctx, claimId);
      await dispute(ctx, claimId);
      await verdict(ctx, claimId, 'DUPLICATE', { dispute: true, justification: await pin(ctx, juryUpload('The panel read this as a repeat.')) });
      await finalize(ctx, claimId);
      await settle(ctx, claimId);
      await settled(site);
      assert.deepEqual(await entry(l), none({ otherDuplicates: 1 }));
    });
  });

  test('a listing that does not count keeps its claims apart: none of it reaches the record\'s count', async () => {
    const l = await listing(ctx, { escrowWei: 5n * 10n ** 18n });
    const r = await replay(ctx, l, { from: ctx.other });
    await claimed(ctx, r.listingId, 'DUPLICATE', integrityUpload());
    await settled(site);
    const v = await view(l.artifactHash);
    assert.deepEqual(v.integrity.listings[String(l.listingId)], none());
    assert.equal(v.integrity.listings[String(r.listingId)], undefined);
  });

  test('what is stored is the outcome of the read: known check names and no text of the upload', async () => {
    const l = await listing(ctx);
    const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', uploadBytes(`${evidenceBlock({ checks: 'exitConsistent' })}\n\nMARKER-FROM-THE-UPLOAD`));
    await settled(site);
    assert.deepEqual(site.store.state.evidence[cid], { says: 'integrity', checks: ['exitConsistent'] });
    assert.equal(JSON.stringify(site.store.state.evidence).includes('MARKER-FROM-THE-UPLOAD'), false);
    assert.equal(JSON.stringify(await view(l.artifactHash)).includes('MARKER-FROM-THE-UPLOAD'), false);
  });

  test('the note says what the count means, in neutral words', () => {
    assert.equal(assertWording(integrityNote), integrityNote);
    assert.deepEqual(wordingProblems(integrityNote), []);
    assert.match(integrityNote, /a hunter's own failed run also raises/i);
    assert.match(integrityNote, /does not say who or what caused/i);
    assert.match(integrityNote, /DUPLICATE/);
    assert.equal(/\b(trap|cheat|fault|blame|malicious|attack|grief|caught)/i.test(integrityNote), false);
  });
});

describe('reading in the background, with bounds', () => {
  let ctx;
  before(async () => { ctx = await chainContext(); });

  test('a fetch that fails counts as a plain DUPLICATE, says so, and is tried again; the record never fails for it', async () => {
    let t = Date.now();
    let down = true;
    const asked = [];
    const site = siteFor(ctx, {
      now: () => t,
      env: { SA_MAX_STALENESS_SECONDS: '100000000', SA_ARCHIVE_RETRY_MS: '1000' },
      fetchJustification: async (cid) => {
        asked.push(cid);
        if (down) throw new Error('every gateway is down');
        return ctx.pinner.get(cid);
      },
    });
    try {
      const l = await listing(ctx);
      const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      await settled(site);
      const during = (await site.record(l.artifactHash)).integrity.listings[String(l.listingId)];
      assert.deepEqual(during, none({ otherDuplicates: 1, unread: 1 }));
      assert.equal(asked.length, 1, 'one try, then it waits');
      assert.deepEqual(Object.keys(site.store.state.evidence[cid]).sort(), ['attempts', 'nextAt', 'unread']);

      t += 999;
      await settled(site);
      assert.equal(asked.length, 1, 'not before its wait is over');

      t += 1;
      await settled(site);
      assert.equal(asked.length, 2, 'it is tried again');
      assert.equal(site.store.state.evidence[cid].attempts, 2);
      assert.equal(site.store.state.evidence[cid].nextAt, t + 2000, 'the wait doubles');

      t += 2000;
      down = false;
      await settled(site);
      assert.deepEqual((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)], none({ failed: 1, checks: [{ check: 'frameworkUnchanged', count: 1 }, { check: 'dependenciesUnchanged', count: 1 }] }));
      const reads = asked.length;
      t += 100_000_000;
      await settled(site);
      assert.equal(asked.length, reads, 'an answer is final: a CID is its content');
    } finally {
      site.close();
    }
  });

  test('a gateway\'s answer with no justification in it is tried again, and the real upload then counts', async () => {
    let t = Date.now();
    const answers = [Buffer.from(JSON.stringify({ error: 'rate limited' })), Buffer.from('null'), Buffer.from(JSON.stringify({ justification: null })), Buffer.from('<html></html>')];
    let target = null;
    const site = siteFor(ctx, {
      now: () => t,
      env: { SA_MAX_STALENESS_SECONDS: '100000000', SA_ARCHIVE_RETRY_MS: '1000' },
      fetchJustification: async (cid) => (cid === target ? answers.shift() : null) ?? ctx.pinner.get(cid),
    });
    try {
      const l = await listing(ctx);
      const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload({ sha: '0'.repeat(64) }));
      target = cid;
      await settled(site);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        assert.deepEqual((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)], none({ otherDuplicates: 1, unread: 1 }), `attempt ${attempt}`);
        assert.equal(site.store.state.evidence[cid].attempts, attempt);
        t += 1000 * 2 ** (attempt - 1);
        await settled(site);
      }
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      site.close();
    }
  });

  test('one of two arbiters\' uploads missing: plain and unread until it can be read, and then the answer', async () => {
    let t = Date.now();
    const site = siteFor(ctx, { now: () => t, env: { SA_MAX_STALENESS_SECONDS: '100000000', SA_ARCHIVE_RETRY_MS: '1000' } });
    try {
      const l = await listing(ctx);
      const a = await pin(ctx, integrityUpload({ sha: '5'.repeat(64) }));
      const later = integrityUpload({ sha: '6'.repeat(64) });
      const { rawCid } = await import('../src/pinning/cid.js');
      const b = rawCid(later);
      await claimed(ctx, l.listingId, 'DUPLICATE', `${a},${b}`);
      await settled(site);
      assert.deepEqual((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)], none({ otherDuplicates: 1, unread: 1 }));
      await pin(ctx, later);
      t += 1000;
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      site.close();
    }
  });

  test('a page request fetches nothing, and a read that hangs holds up neither the sync nor the record', async () => {
    const asked = [];
    let release;
    const hung = new Promise((r) => { release = r; });
    const site = siteFor(ctx, { settle: false, fetchJustification: async (cid) => { asked.push(cid); await hung; return ctx.pinner.get(cid); } });
    const api = await startApi({ builder: fakeBuilder(), site });
    try {
      const l = await listing(ctx);
      const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      await site.sync();
      await site.archivesIdle();
      await site.controlIdle();
      await site.sync();
      await site.archivesIdle();
      await site.controlIdle();
      assert.deepEqual(asked, [cid], 'one run at a time, and the sync returned while it hangs');
      const cursor = site.store.state.cursor.number;
      await mine(ctx, 2);
      await site.sync();
      assert.ok(site.store.state.cursor.number > cursor, 'the indexer moved on');
      const res = await api.get(`/api/records/${l.artifactHash}`);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).integrity.listings[String(l.listingId)], none({ otherDuplicates: 1, unread: 1 }));
      assert.deepEqual(asked, [cid], 'the request read nothing');

      release();
      await site.evidenceIdle();
      const asked2 = asked.length;
      for (let i = 0; i < 5; i += 1) assert.equal((await api.get(`/api/records/${l.artifactHash}`)).status, 200);
      assert.equal(asked.length, asked2, 'nor do later requests');
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1, 'the answer shows once it is in');
    } finally {
      await api.close();
      site.close();
    }
  });

  test('a run reads at most its limit, and uploads that keep failing do not starve the rest', async () => {
    const cids = Array.from({ length: MAX_FETCHES_PER_RUN * 2 + 1 }, (_, i) => `bafkrei${String(i).padStart(52, 'a')}`);
    const claims = cids.map((justificationCid, i) => ({ claimId: String(i + 1), listingId: '1', state: 'Settled', outcome: 'DUPLICATE', justificationCid }));
    const asked = [];
    const store = { locked: true, state: { evidence: {} }, transact(fn) { return fn(this.state); } };
    let t = 1000;
    const args = { store, claims, now: () => t, retryMs: 1000, logger: { warn() {} }, fetchJustification: async (cid) => { asked.push(cid); throw new Error('down'); } };
    await refreshEvidence(args);
    assert.deepEqual(asked, cids.slice(0, MAX_FETCHES_PER_RUN));
    await refreshEvidence(args);
    assert.deepEqual(asked, cids.slice(0, MAX_FETCHES_PER_RUN * 2), 'the next run takes the next ones, while the failed ones wait');
    t += 1000;
    asked.length = 0;
    await refreshEvidence(args);
    assert.equal(asked.length, MAX_FETCHES_PER_RUN);
    assert.equal(asked[0], cids.at(-1), 'the one never asked goes first');
    assert.deepEqual(asked.slice(1), cids.slice(0, MAX_FETCHES_PER_RUN - 1), 'then the ones waiting longest');
  });

  test('a closed site stores nothing from a read still running', async () => {
    let release;
    const hung = new Promise((r) => { release = r; });
    const site = siteFor(ctx, { settle: false, fetchJustification: async () => { await hung; return integrityUpload(); } });
    const l = await listing(ctx);
    await claimed(ctx, l.listingId, 'DUPLICATE', await pin(ctx, integrityUpload({ sha: '7'.repeat(64) })));
    await site.sync();
    await site.archivesIdle();
    await site.controlIdle();
    site.close();
    release();
    await site.evidenceIdle();
    assert.deepEqual(site.store.state.evidence ?? {}, {});
  });

  test('a huge file: the download stops at the limit, and it reads as "could not read"', async () => {
    assert.equal(MAX_JUSTIFICATION_UPLOAD_BYTES, 4 * 1024 * 1024);
    let pulled = 0;
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const endless = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { async* [Symbol.asyncIterator]() { for (let i = 0; i < 1000; i += 1) { pulled += chunk.length; yield chunk; } } },
    };
    const gateways = [];
    const fetcher = createJustificationFetcher({ gateways: ['https://gw.example'], timeoutMs: 1000 }, undefined, {
      fetch: async (url) => {
        gateways.push(new URL(url).host);
        return endless;
      },
    });
    await assert.rejects(fetcher(`bafybei${'a'.repeat(52)}`), /larger than/);
    assert.ok(pulled <= MAX_JUSTIFICATION_UPLOAD_BYTES + chunk.length, `it read ${pulled} bytes`);
    assert.deepEqual(gateways, ['gw.example'], 'no other gateway is asked for it');

    // a fetcher that answers anyway: the reader holds the same limit, and never parses it
    const big = Buffer.alloc(MAX_JUSTIFICATION_UPLOAD_BYTES + 1, 0x20);
    assert.equal(readUpload(big), null);
    assert.deepEqual(readUpload(integrityUpload({ checks: 'exitConsistent' })), { says: 'integrity', checks: ['exitConsistent'] });
    const site = siteFor(ctx, { fetchJustification: async () => big });
    try {
      const l = await listing(ctx);
      await claimed(ctx, l.listingId, 'DUPLICATE', await pin(ctx, integrityUpload({ sha: '8'.repeat(64) })));
      await settled(site);
      assert.deepEqual((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)], none({ otherDuplicates: 1, unread: 1 }));
    } finally {
      site.close();
    }
  });

  test('declared larger than the limit: refused before any byte is read', async () => {
    let read = false;
    const fetcher = createJustificationFetcher({ gateways: ['https://gw.example'], timeoutMs: 1000 }, undefined, {
      fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(MAX_JUSTIFICATION_UPLOAD_BYTES + 1) }), body: { async* [Symbol.asyncIterator]() { read = true; yield Buffer.alloc(1); } } }),
    });
    await assert.rejects(fetcher(`bafybei${'a'.repeat(52)}`), /larger than/);
    assert.equal(read, false);
  });

  test('a failed run is caught: a reader that throws something odd or a store error stops neither the sync nor the record', async () => {
    const warnings = [];
    const site = siteFor(ctx, {
      logger: { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(String(m)) },
      fetchJustification: async () => { throw Object.assign(new Error('x'.repeat(5000)), { code: 'ODD' }); },
    });
    try {
      const l = await listing(ctx);
      await claimed(ctx, l.listingId, 'DUPLICATE', await pin(ctx, integrityUpload({ sha: '9'.repeat(64) })));
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].unread, 1);
      assert.ok(warnings.some((w) => /justification/.test(w)));
      assert.ok(warnings.every((w) => w.length < 1000), 'a long error is cut');
    } finally {
      site.close();
    }
  });
});

describe('the count follows the chain and the store', () => {
  test('a reorg that drops the settlement drops the claim from the count', async () => {
    const ctx = await chainContext();
    const { site, fetched } = counting(ctx);
    try {
      const l = await listing(ctx);
      await mine(ctx, 3);
      await settled(site);
      const snapshot = await rpc(ctx, 'evm_snapshot');
      const { cid } = await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
      assert.equal(fetched.includes(cid), true);

      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      await mine(ctx, 40);
      await settled(site);
      const v = await site.record(l.artifactHash);
      assert.deepEqual(v.integrity.listings[String(l.listingId)], none());
      assert.equal(v.record.history.outcomes[1], '0');
    } finally {
      site.close();
    }
  });

  test('a record at an earlier block counts what had settled by then', async () => {
    const ctx = await chainContext();
    const { site } = counting(ctx);
    try {
      const l = await listing(ctx, { escrowWei: 5n * 10n ** 18n });
      await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      const block = await ctx.hre.ethers.provider.getBlockNumber();
      await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload({ sha: 'e'.repeat(64) }));
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 2);
      assert.equal((await site.record(l.artifactHash, { blockTag: block })).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      site.close();
    }
  });

  test('a record cached for its block still states the latest reads', async () => {
    const ctx = await chainContext();
    let t = Date.now();
    let down = true;
    const site = siteFor(ctx, { now: () => t, env: { SA_MAX_STALENESS_SECONDS: '100000000', SA_ARCHIVE_RETRY_MS: '1000' }, fetchJustification: async (cid) => { if (down) throw new Error('down'); return ctx.pinner.get(cid); } });
    try {
      const l = await listing(ctx);
      await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].unread, 1);
      down = false;
      t += 2000;
      await settled(site);
      assert.equal((await site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      site.close();
    }
  });

  test('the reads survive a restart, and a state file from before this node has none and works', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    const one = counting(ctx, { dir });
    let l;
    try {
      l = await listing(ctx);
      await claimed(ctx, l.listingId, 'DUPLICATE', integrityUpload());
      await settled(one.site);
    } finally {
      one.site.close();
    }
    const two = counting(ctx, { dir });
    try {
      await settled(two.site);
      assert.deepEqual(two.fetched, [], 'nothing is read twice');
      assert.equal((await two.site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      two.site.close();
    }

    const file = path.join(dir, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete state.evidence;
    fs.writeFileSync(file, JSON.stringify(state));
    const three = counting(ctx, { dir });
    try {
      assert.deepEqual((await three.site.record(l.artifactHash)).integrity.listings[String(l.listingId)], none({ otherDuplicates: 1, unread: 1 }), 'an answer before the read: plain');
      await settled(three.site);
      assert.equal(three.fetched.length, 1);
      assert.equal((await three.site.record(l.artifactHash)).integrity.listings[String(l.listingId)].failed, 1);
    } finally {
      three.site.close();
    }
  });
});

describe('the fold on its own', () => {
  const claim = (over = {}) => ({ claimId: '1', listingId: '7', late: false, state: 'Settled', outcome: 'DUPLICATE', justificationCid: 'a'.repeat(46), ...over });
  const A = 'a'.repeat(46);
  const B = 'b'.repeat(46);

  test('only a settled DUPLICATE of a listing asked for', () => {
    const reading = { [A]: { says: 'integrity', checks: ['exitConsistent'] } };
    const out = (c) => integrityByListing({ claims: [claim(c)], readings: reading, listingIds: ['7'] })['7'];
    assert.equal(out({}).failed, 1);
    for (const outcome of ['INVALID', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', null]) assert.deepEqual(out({ outcome }), none(), String(outcome));
    for (const state of ['Committed', 'Revealed', 'Judged', 'Disputed', 'Expired', 'RoundFailed']) assert.deepEqual(out({ state }), none(), state);
    assert.deepEqual(integrityByListing({ claims: [claim({ listingId: '8' })], readings: reading, listingIds: ['7'] }), { 7: none() });
  });

  test('no reading, or none of this kind: plain', () => {
    const out = (readings, justificationCid = A) => integrityByListing({ claims: [claim({ justificationCid })], readings, listingIds: ['7'] })['7'];
    assert.deepEqual(out({}), none({ otherDuplicates: 1, unread: 1 }));
    assert.deepEqual(out(undefined), none({ otherDuplicates: 1, unread: 1 }), 'a state file from before this node');
    assert.deepEqual(out({ [A]: { unread: true, attempts: 3, nextAt: 9 } }), none({ otherDuplicates: 1, unread: 1 }));
    assert.deepEqual(out({ [A]: { says: 'other', settlement: 'jury' } }), none({ otherDuplicates: 1 }));
    assert.deepEqual(out({}, undefined), none({ otherDuplicates: 1, unread: 1 }), 'a Settled with no verdict event seen');
    const jury = { says: 'other', settlement: 'jury' };
    assert.deepEqual(out({ [A]: jury, [B]: jury }, `${A},${B}`), none({ otherDuplicates: 1 }));
    assert.deepEqual(out({ [A]: jury, [B]: { says: 'other', settlement: 'INVALID (build)' } }, `${A},${B}`), none({ otherDuplicates: 1, disagree: 1 }));
    assert.deepEqual(out({ [A]: jury, [B]: { says: 'other', settlement: null } }, `${A},${B}`), none({ otherDuplicates: 1, disagree: 1 }));
    const invalid = (checks) => ({ says: 'other', settlement: 'INVALID (build)', checks });
    assert.deepEqual(out({ [A]: invalid(['identityComplete']), [B]: invalid(['identityComplete']) }, `${A},${B}`), none({ otherDuplicates: 1 }));
    assert.deepEqual(out({ [A]: invalid(['identityComplete']), [B]: invalid(['exitConsistent']) }, `${A},${B}`), none({ otherDuplicates: 1, disagree: 1 }));
    assert.deepEqual(out({ [A]: invalid([]), [B]: invalid(null) }, `${A},${B}`), none({ otherDuplicates: 1, disagree: 1 }));
    assert.deepEqual(out({ [A]: jury }, `${A},${B}`), none({ otherDuplicates: 1, unread: 1 }));
  });

  test('checks come out in common\'s order, and a claim can name several', () => {
    const readings = { [A]: { says: 'integrity', checks: ['dependenciesUnchanged'] }, [B]: { says: 'integrity', checks: ['identityComplete', 'dependenciesUnchanged'] } };
    const out = integrityByListing({ claims: [claim(), claim({ claimId: '2', justificationCid: B })], readings, listingIds: ['7'] })['7'];
    assert.equal(out.failed, 2);
    assert.deepEqual(out.checks, [{ check: 'identityComplete', count: 1 }, { check: 'dependenciesUnchanged', count: 2 }]);
    assert.deepEqual(codeReview.INTEGRITY_CHECKS.filter((c) => out.checks.some((x) => x.check === c)), out.checks.map((x) => x.check));
  });

  test('the projection keeps the last verdict\'s CID: a failed dispute round leaves the first', () => {
    const events = [
      { name: 'Committed', args: { claimId: '1', listingId: '7' } },
      { name: 'Judged', args: { claimId: '1', listingId: '7', outcome: 'HIGH', justificationCid: A } },
      { name: 'DisputeFailed', args: { claimId: '1', listingId: '7' } },
      { name: 'Settled', args: { claimId: '1', listingId: '7', outcome: 'HIGH' } },
      { name: 'Committed', args: { claimId: '2', listingId: '7' } },
      { name: 'Judged', args: { claimId: '2', listingId: '7', outcome: 'HIGH', justificationCid: A } },
      { name: 'DisputeJudged', args: { claimId: '2', listingId: '7', outcome: 'DUPLICATE', justificationCid: B } },
      { name: 'Settled', args: { claimId: '2', listingId: '7', outcome: 'DUPLICATE' } },
    ];
    const { claims } = project(events);
    assert.equal(claims.get('1').justificationCid, A);
    assert.equal(claims.get('2').justificationCid, B);
  });
});
