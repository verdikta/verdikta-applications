// Acceptance 1, the indexer (node P4b1): every event the contract emits, Disclosed included, is
// indexed field for field; only blocks with SA_CONFIRMATIONS blocks on top are read; the cursor
// is persisted, so a new process resumes from it; and the data folder belongs to one deployment
// and one writer. Reorgs: indexer.reorg.test.js; a restart mid-sync: indexer.restart.test.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { expectedJson, solidityEnums } from './helpers/abiJson.js';
import { mergedAbi } from './helpers/chain.js';
import {
  chainContext, commit, disclose, dispute, finalize, HOUR, increaseTime, judgeAndSettle, listing, mine,
  reveal, revealedClaim, settle, siteFor, tmpDir, verdict,
} from './helpers/scenario.js';

describe('the indexer stores every event the contract emitted, field for field', () => {
  let ctx;
  let site;
  before(async () => {
    ctx = await chainContext();
    const [h1, h2, h3] = ctx.hunters;
    // listings: open, renew, a depleting payout and a top-up, a release and a flag, a roll-forward,
    // a late claim, a close, a dispute, an expiry, a failed round and its re-trigger
    const a = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).renew(a.listingId, { value: await ctx.sa.listingFeeWei() })).wait();
    const valid = await revealedClaim(ctx, h1, a.listingId);
    await judgeAndSettle(ctx, valid, 'HIGH');
    await (await ctx.sa.connect(ctx.maker).fund(a.listingId, 0, { value: 10n ** 18n })).wait();
    const disputed = await revealedClaim(ctx, h2, a.listingId);
    await verdict(ctx, disputed, 'MEDIUM');
    await finalize(ctx, disputed);
    await dispute(ctx, disputed);
    await verdict(ctx, disputed, 'MEDIUM', { dispute: true });
    await finalize(ctx, disputed);
    await settle(ctx, disputed);
    const undisclosed = await commit(ctx, h3, a.listingId);
    await increaseTime(ctx, HOUR + 1);
    await (await ctx.sa.connect(ctx.other).expire(undisclosed)).wait();
    const failed = await revealedClaim(ctx, h1, a.listingId);
    await increaseTime(ctx, 301);
    await finalize(ctx, failed);
    await (await ctx.sa.connect(h1).retrigger(failed, { value: await ctx.sa.retriggerTopUp(failed), gasLimit: 12_000_000 })).wait();
    await verdict(ctx, failed, 'INVALID');
    await finalize(ctx, failed);
    await settle(ctx, failed);

    const windowed = await listing(ctx, { stake: { fixWindowDays: 1, disclosureGraceHours: 24 } });
    const flagged = await commit(ctx, h2, windowed.listingId);
    await disclose(ctx, h2, flagged);
    await (await ctx.sa.connect(ctx.maker).flagBadDisclosure(flagged)).wait();
    await (await ctx.sa.connect(ctx.maker).release(flagged)).wait();
    await reveal(ctx, h2, flagged);

    const successor = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).rollForward(a.listingId, successor.listingId)).wait();
    const late = await commit(ctx, h3, a.listingId, { late: true });
    await disclose(ctx, h3, late);
    const closing = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).close(closing.listingId)).wait();
    await (await ctx.sa.connect(ctx.owner).setListingFee(2n * 10n ** 16n)).wait();
    await mine(ctx, 2);

    site = siteFor(ctx);
    await site.sync();
  });
  after(() => site?.close());

  test('the stored events are the contract\'s logs: same order, block, transaction and arguments', async () => {
    const abi = mergedAbi(ctx.hre);
    const enums = solidityEnums();
    const raw = await ctx.hre.ethers.provider.getLogs({ address: ctx.address, fromBlock: ctx.fromBlock, toBlock: 'latest' });
    const expected = raw.map((log) => {
      const parsed = ctx.sa.interface.parseLog(log);
      const fragment = abi.find((f) => f.type === 'event' && f.name === parsed.name && f.inputs.length === parsed.fragment.inputs.length);
      return {
        name: parsed.name,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.index,
        txHash: log.transactionHash,
        args: Object.fromEntries(fragment.inputs.map((input, i) => [input.name, expectedJson(parsed.args[i], input, enums)])),
      };
    });
    const stored = site.store.state.events.map(({ name, blockNumber, blockHash, logIndex, txHash, args }) => ({ name, blockNumber, blockHash, logIndex, txHash, args }));
    assert.equal(stored.length, expected.length);
    assert.deepEqual(stored, expected);
  });

  test('Disclosed is among them, with the ciphertext CID and the fix window\'s end', () => {
    const disclosed = site.store.state.events.filter((e) => e.name === 'Disclosed');
    assert.ok(disclosed.length >= 3);
    for (const e of disclosed) {
      assert.match(e.args.ciphertextCid, /^bafkrei[a-z2-7]{52}$/);
      assert.match(e.args.fixWindowEnd, /^[0-9]+$/);
    }
  });

  test('the scenario emitted (and the store holds) every kind of state change', () => {
    const names = new Set(site.store.state.events.map((e) => e.name));
    for (const n of [
      'Listed', 'Funded', 'Opened', 'Renewed', 'ListingFeeAccrued', 'Committed', 'Disclosed', 'Flagged', 'Released',
      'Revealed', 'EvaluationRequested', 'Judged', 'EvaluationFailed', 'Retriggered', 'Disputed', 'DisputeJudged',
      'Settled', 'Depleted', 'Reopened', 'Expired', 'RolledForward', 'LateClaim', 'Closed', 'ListingFeeSet', 'LeftoverRefunded',
    ]) assert.ok(names.has(n), n);
  });

  test('every event carries its block\'s timestamp', async () => {
    for (const e of site.store.state.events.slice(0, 5)) {
      const b = await ctx.hre.ethers.provider.getBlock(e.blockNumber);
      assert.equal(e.timestamp, b.timestamp);
    }
  });

  test('a second sync with no new block adds nothing', async () => {
    const before = site.store.state.events.length;
    const r = await site.sync();
    assert.equal(r.added, 0);
    assert.equal(site.store.state.events.length, before);
  });
});

describe('confirmations: a block is read only once SA_CONFIRMATIONS blocks are on top of it', () => {
  test('an event stays out of the store until its block has 3 confirmations', async () => {
    const ctx = await chainContext();
    const site = siteFor(ctx, { env: { SA_CONFIRMATIONS: '3' } });
    try {
      const { listingId } = await listing(ctx, { fund: false });
      const head = await ctx.hre.ethers.provider.getBlockNumber();
      await site.sync();
      assert.equal(site.store.state.cursor.number, head - 3);
      assert.equal(site.store.state.events.some((e) => e.name === 'Listed' && e.args.listingId === String(listingId)), false);
      await mine(ctx, 2);
      await site.sync();
      assert.equal(site.store.state.events.some((e) => e.name === 'Listed'), false, 'two confirmations are not enough');
      await mine(ctx, 1);
      await site.sync();
      assert.equal(site.store.state.events.filter((e) => e.name === 'Listed').length, 1);
      assert.equal(site.store.state.cursor.number, head);
      assert.equal(site.store.state.cursor.hash, (await ctx.hre.ethers.provider.getBlock(head)).hash);
    } finally {
      site.close();
    }
  });
});

describe('the cursor', () => {
  test('is persisted with the events, and a new process resumes from it', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    await listing(ctx);
    const first = siteFor(ctx, { dir });
    await first.sync();
    const cursor = first.store.state.cursor;
    const count = first.store.state.events.length;
    first.close();

    await listing(ctx);
    const second = siteFor(ctx, { dir });
    try {
      assert.deepEqual(second.store.state.cursor, cursor);
      assert.equal(second.store.state.events.length, count);
      const r = await second.sync();
      assert.equal(r.from, cursor.number + 1, 'reading resumes after the cursor');
      assert.ok(r.added > 0);
      const keys = second.store.state.events.map((e) => `${e.blockHash}:${e.logIndex}`);
      assert.equal(new Set(keys).size, keys.length, 'no event twice');
    } finally {
      second.close();
    }
  });

  test('starts at SA_FROM_BLOCK and never reads before it', async () => {
    const ctx = await chainContext();
    await listing(ctx);
    const from = await ctx.hre.ethers.provider.getBlockNumber();
    await listing(ctx);
    const site = siteFor(ctx, { env: { SA_FROM_BLOCK: String(from + 1) } });
    try {
      await site.sync();
      assert.ok(site.store.state.events.length > 0);
      assert.ok(site.store.state.events.every((e) => e.blockNumber > from));
    } finally {
      site.close();
    }
  });
});

describe('the data folder', () => {
  test('belongs to one deployment: another address, chain or start block is refused', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    siteFor(ctx, { dir }).close();
    const other = await chainContext();
    assert.throws(() => siteFor(other, { dir }), (e) => e.code === 'STATE_IDENTITY_MISMATCH');
    assert.throws(() => siteFor(ctx, { dir, env: { SA_FROM_BLOCK: String(ctx.fromBlock + 1) } }), (e) => e.code === 'STATE_IDENTITY_MISMATCH');
  });

  test('has one writer: a second site on it is refused while the first runs', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    const first = siteFor(ctx, { dir });
    try {
      assert.throws(() => siteFor(ctx, { dir }), (e) => e.code === 'WRITER_ACTIVE');
    } finally {
      first.close();
    }
    siteFor(ctx, { dir }).close();
  });

  test('a provider on another chain is refused before anything is read', async () => {
    const ctx = await chainContext();
    const site = siteFor(ctx, { env: { SA_CHAIN_ID: '84532' } });
    try {
      await assert.rejects(site.sync(), (e) => e.code === 'WRONG_CHAIN');
      assert.equal(site.store.state.cursor, null);
    } finally {
      site.close();
    }
  });

  test('an address with no contract code is refused', async () => {
    const ctx = await chainContext();
    const site = siteFor(ctx, { env: { SA_CONTRACT_ADDRESS: '0x000000000000000000000000000000000000dEaD' } });
    try {
      await assert.rejects(site.sync(), (e) => e.code === 'NO_CONTRACT');
    } finally {
      site.close();
    }
  });
});
