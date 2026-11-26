// Node P42: the maker's hold on a listing's own page (StakeAttestation.hold, node P39), through the wallet. A hold
// stops new commits at once, before the fix the listing rolls forward to is public; it leaves every pending claim
// alone; and it has no resume. The page offers it to the listing's maker and to no other wallet, next to roll forward,
// with that warning; asks for confirmation; and reports the transaction. That the listing is on hold, since when, and
// what its maker may do because of it, the page says from its read of the chain alone (one snapshot of one block),
// in its own sentences about taking claims, while roll forward and close stay offered: never from the receipt of
// a transaction it sent. After each of its own transactions, and each time the wallet's read disagrees with it, those
// lines are off the page at once, and back only from a read of that block or a later one (src/lib/pageSays.js). The
// lists (the record, the other listings of a repository on a listing's page and in a feed entry) say the hold from the
// API. Against a contract deployed before the hold, whose heldAt call the node refuses, there is no hold action and
// the page says what it said. Each step is checked against the chain.
import { Interface } from 'ethers';

import { formatEth } from '../src/lib/format.js';
import { STRINGS, fill } from '../src/strings.js';
import { AFTER_TX_READS } from '../src/lib/poll.js';
import { REFUSED_CALL, answerHeldAt, archiveBytes, disclosure, expect, expectCommitOffer, installWallet, interceptRpc, isAcceptsCommitsCall, isHeldAtCall, shot, test } from './support/fixtures.js';
import { field } from './support/listingForm.js';
import { wordingProblems } from './support/wording.js';

const H = STRINGS.hold;
const F = STRINGS.fund;
const RF = STRINGS.roll;
const C = STRINGS.claim;
const O = STRINGS.offer;
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
const useAccount = (page, account, o) => page.evaluate(([a, opts]) => window.__testWallet.setAccount(a, opts), [account, o]);
async function connect(page, account) {
  await page.getByRole('button', { name: STRINGS.wallet.connect }).click();
  await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account }));
}
/** The maker's hold, sent from the test's side; resolves the time the contract's view says. */
async function holdOnChain(chain, stack, listingId, from = stack.accounts.maker) {
  await (await (await chain.as(from)).hold(listingId)).wait();
  const heldAt = await chain.sa.heldAt(listingId);
  expect(heldAt > 0n, `listing ${listingId} is on hold`).toBe(true);
  return heldAt;
}
/** The lines of an element's text as the page has it: one for each block of it, the gaps between blocks left out. */
const lines = async (locator) => (await locator.innerText()).split('\n').filter(Boolean);
/**
 * The site's reader held at the block the chain is at now, as a node that trails the wallet's: resolves what lets it
 * go. Every read of the page is a snapshot of the latest block (src/chain/snapshot.js), so the reader goes on
 * answering "latest" with that block. `seen.reads` counts the calls it made meanwhile that `seen.of` picks out: a read
 * of the listing asks getListing once.
 */
async function freezeReader(page, stack, chain, seen = { reads: 0, of: () => false }) {
  const frozen = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
  return interceptRpc(page, stack, (p) => {
    if (seen.of(p)) seen.reads += 1;
    return p.method === 'eth_getBlockByNumber' && p.params?.[0] === 'latest' ? { result: frozen } : undefined;
  }, { from: 'reader' });
}
/** A block's hash as another chain has it at that height: any other 32 bytes. */
const otherHash = (hash) => `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`;
/** What the node answers for one request, asked directly. */
async function ofNode(stack, p) {
  const res = await fetch(stack.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: p.method, params: p.params }) });
  return (await res.json()).result;
}
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
/** The call getListing(id) as a page sends it, and what the chain answers for it now. */
async function listingCall(chain, listingId) {
  const data = chain.sa.interface.encodeFunctionData('getListing', [listingId]);
  return { data, result: await chain.provider.call({ to: await chain.sa.getAddress(), data }) };
}
const isCallWith = (data) => (p) => p?.method === 'eth_call' && String(p.params?.[0]?.data ?? p.params?.[0]?.input ?? '').toLowerCase() === data.toLowerCase();
const renewButton = (page, stack) => page.getByTestId('renew').getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) });
const api = async (stack, path) => {
  const res = await fetch(`${stack.apiUrl}${path}`);
  return res.ok ? res.json() : null;
};
/** A repository of the test's own: its listing's page then lists no other listing, on hold or not, in its text. */
const ownRepo = (name) => `https://github.com/acme/${name}-${Date.now().toString(36)}`;
/** The maker's hold, sent from the page in its two steps; resolves the line of the page's own transaction once it is mined. */
async function holdFromPage(page, listingId) {
  const section = page.getByTestId('hold');
  await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
  await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
  const mined = section.getByTestId('hold-mined');
  await expect(mined).toBeVisible({ timeout: 30_000 });
  return mined;
}
/**
 * The page knows its read is behind: nothing on it says the listing is on hold, what its maker may do because of it,
 * or that the listing takes claims. Not by a receipt, and not by the read it showed before. `ids` are lines of the
 * page's own transactions, which stay.
 */
async function expectHoldOff(page, ids = []) {
  const OF_THE_READ = ['listing-state', 'listing-held-since', 'listing-held', 'listing-open-until', 'commit-offer', 'hold-since', 'hold-warning', 'hold-late', 'roll-forward', 'roll-hold-first', 'roll-hold-order', 'renew-period', 'renew-held', 'renew-fee', 'top-up-escrow', 'top-up-depleted', 'close-escrow', 'close-blocked'];
  for (const id of OF_THE_READ) await expect(page.getByTestId(id), id).toHaveCount(0);
  const text = await page.locator('main').innerText();
  for (const words of [/on hold/i, /push the fix/i, /is open until/i, /offers it to hunters/i]) expect(text).not.toMatch(words);
  for (const id of ids) await expect(page.getByTestId(id), id).toBeVisible();
  // the stored terms stay: they are fixed when the listing is listed
  await expect(page.getByTestId('listing-summary')).toBeVisible();
}

test.describe('the maker\'s hold', () => {
  let key;
  test.beforeEach(() => {
    key = disclosure.generateDisclosureKeyPair();
  });

  test('offered to the maker only, with the warning; two steps, then the transaction; and the page says on hold once it has read it', async ({ page, stack, chain }) => {
    test.setTimeout(180_000);
    const { listingId, artifactHash } = await chain.openListing({ recipient: key.recipient });
    // a claim committed before the hold: it is pending, and stays as it was
    const before = await chain.claim({ listingId, archive: archiveBytes('before the hold'), recipient: key.recipient });
    const claimBefore = await chain.sa.getClaim(before.claimId);
    const timesBefore = await chain.sa.claimTimes(before.claimId);
    expect(await chain.sa.heldAt(listingId)).toBe(0n);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(true);

    // no wallet connected: the warning is there for anyone to read, and no action
    await installWallet(page, stack, stack.accounts.other);
    await page.goto(`/#/fund/${listingId}`);
    const section = page.getByTestId('hold');
    await expect(section).toBeVisible();
    expect(await lines(section.getByTestId('hold-warning'))).toEqual([H.warning.stops, H.warning.pending, H.warning.oneWay]);
    expect(await section.getByTestId('hold-late').innerText()).toBe(H.late);
    await expect(section.getByTestId('hold-maker-only')).toHaveText(H.makerOnly);
    await expect(section.getByRole('button')).toHaveCount(0);
    // node P47: open and taking commits, so the site offers it
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true, shotAs: 'commit-offer-yes' });
    // another wallet, connected: the same, and no action
    await connect(page, stack.accounts.other);
    await expect(section.getByTestId('hold-maker-only')).toHaveText(H.makerOnly);
    await expect(section.getByRole('button')).toHaveCount(0);

    // the maker's wallet: the action, next to roll forward, whose panel states the order with a hold
    await useAccount(page, stack.accounts.maker);
    await connect(page, stack.accounts.maker);
    const ask = section.getByRole('button', { name: fill(H.ask, { id: listingId }) });
    await expect(ask).toBeVisible();
    await expect(section.getByTestId('hold-maker-only')).toHaveCount(0);
    const roll = page.getByTestId('roll-forward');
    expect(await roll.getByTestId('roll-hold-first').innerText()).toBe(RF.hold.first);
    expect(await lines(roll.getByTestId('roll-hold-order'))).toEqual([RF.hold.order, RF.hold.close]);
    await expect(roll.getByTestId('roll-fix-keep')).toHaveCount(0);
    await expect(roll.getByTestId('roll-fix-order')).toHaveCount(0);
    // the hold's section is the one drawn just before the roll-forward panel
    expect(await page.evaluate(() => document.querySelector('[data-testid="roll-forward"]').previousElementSibling?.getAttribute('data-testid'))).toBe('hold');
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);

    // the first step asks and sends nothing; it can be taken back
    const confirm = section.getByRole('button', { name: fill(H.confirm, { id: listingId }) });
    await ask.click();
    await expect(confirm).toBeVisible();
    await shot(page, 'hold-action', { target: section });
    // on a phone the warning and the two buttons stay inside the page: it never scrolls sideways
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.setViewportSize(size);
    await section.getByRole('button', { name: H.keep }).click();
    await expect(confirm).toHaveCount(0);
    expect(await chain.sa.heldAt(listingId)).toBe(0n);

    // a wallet that changed its account without saying so: asked again at the click, and refused before anything is sent
    await useAccount(page, stack.accounts.other, { announce: false });
    await ask.click();
    await confirm.click();
    await expect(section.getByRole('alert')).toHaveText(fill(C.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
    expect(await chain.sa.heldAt(listingId)).toBe(0n);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(true);
    // the page knows the wallet now, and offers it nothing
    await expect(section.getByRole('button')).toHaveCount(0);

    // the maker: confirmed, sent, and reported as the page's other actions report theirs, by the mined transaction
    await useAccount(page, stack.accounts.maker);
    await connect(page, stack.accounts.maker);
    await ask.click();
    await confirm.click();
    const mined = section.getByTestId('hold-mined');
    await expect(mined).toBeVisible({ timeout: 30_000 });
    const heldAt = await chain.sa.heldAt(listingId);
    expect(heldAt > 0n).toBe(true);
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    expect(event.args.heldAt).toBe(heldAt);
    expect(await mined.innerText()).toBe(fill(H.mined, { id: listingId, tx: event.transactionHash }));
    expect((await chain.provider.getTransaction(event.transactionHash)).from).toBe(stack.accounts.maker);

    // the chain: no commit from now on, the state as it was, and the pending claim untouched
    const held = await chain.sa.getListing(listingId);
    expect(Number(held.state)).toBe(1); // Open
    expect(await chain.sa.acceptsCommits(listingId)).toBe(false);
    expect(await chain.sa.acceptsLateClaims(listingId)).toBe(true);
    expect(held.pendingClaims).toBe(1n);
    expect(held.headClaim).toBe(before.claimId);
    const claimAfter = await chain.sa.getClaim(before.claimId);
    expect(claimAfter.fixWindowEnd).toBe(claimBefore.fixWindowEnd);
    expect(Number(claimAfter.state)).toBe(Number(claimBefore.state));
    expect((await chain.sa.claimTimes(before.claimId)).revealDeadline).toBe(timesBefore.revealDeadline);
    const hunter = await chain.as(stack.accounts.hunter);
    const hash = disclosure.disclosureSha256(archiveBytes('after the hold'));
    await expect(hunter.commit(listingId, hash, hash, { value: await chain.sa.commitPrice(listingId) })).rejects.toThrow(/not accepting commits/);

    // the page, without a reload, once it has read the hold's block: on hold, with the chain's time, under the
    // state, which stays the chain's. The hold's section says since when, and keeps the line of its transaction.
    const summary = page.getByTestId('listing-summary');
    await expect(summary.getByTestId('listing-held-since')).toHaveText(at(heldAt), { timeout: 30_000 });
    await expect(section.getByTestId('hold-since')).toHaveText(fill(H.since, { time: at(heldAt) }));
    await expect(mined).toHaveText(fill(H.mined, { id: listingId, tx: event.transactionHash }));
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(page.getByTestId('listing-reading')).toHaveCount(0);
    await expect(summary).toContainText(F.states.Open);
    await expect(summary.locator('.pill-ok')).toHaveCount(0);
    expect(await page.getByTestId('listing-held').innerText()).toBe(fill(F.held, { id: listingId, time: at(heldAt) }));
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(held.fundedUntil) }))).toHaveCount(0);
    // the hold is taken: no action is left, and the section says since when
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(section.getByTestId('hold-warning')).toHaveCount(0);
    // every sentence about taking claims: the commit offer, the renewal, the order that is left
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false, shotAs: 'commit-offer-held' });
    await expect(page.getByTestId('renew').getByTestId('renew-held')).toHaveText(STRINGS.renew.held);
    expect(await roll.getByTestId('roll-hold-first').innerText()).toBe(fill(RF.hold.held, { time: at(heldAt) }));
    expect(await lines(roll.getByTestId('roll-hold-order'))).toEqual([RF.hold.close]);
    // roll forward and close stay on the page: with a claim pending, the close says what holds it back
    await expect(roll).toBeVisible();
    await expect(page.getByTestId('close').getByTestId('close-blocked')).toHaveText(fill(STRINGS.close.pending, { count: 1 }));
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
    await shot(page, 'held-listing');

    // read again from the chain: the same, and the hold's section says since when
    await page.reload();
    await expect(page.getByTestId('listing-summary').getByTestId('listing-held-since')).toHaveText(at(heldAt));
    expect(await page.getByTestId('listing-held').innerText()).toBe(fill(F.held, { id: listingId, time: at(heldAt) }));
    await expect(page.getByTestId('hold').getByTestId('hold-since')).toHaveText(fill(H.since, { time: at(heldAt) }));
    // (a reload starts the test wallet again, on the account it was installed with)
    await useAccount(page, stack.accounts.maker);
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('hold').getByRole('button')).toHaveCount(0);

    // a renewal is still the maker's to send, and the listing is on hold all the same: lapsed, then renewed
    await chain.increaseTime(Number(held.fundedUntil - BigInt(await chain.now())) + 3600);
    await page.reload();
    await useAccount(page, stack.accounts.maker);
    const renew = page.getByTestId('renew');
    await expect(renew.getByTestId('renew-period')).toHaveText(fill(STRINGS.renew.lapsedHeld, { time: at(held.fundedUntil) }));
    await expect(renew.getByTestId('renew-held')).toHaveText(STRINGS.renew.held);
    await expect(renew).not.toContainText('until it is renewed');
    // its paid period over and on hold: the sentence is the hold's
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });
    await renew.getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) }).click();
    await expect(renew.getByTestId('renewed')).toBeVisible({ timeout: 30_000 });
    expect((await chain.sa.getListing(listingId)).fundedUntil > held.fundedUntil).toBe(true);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(false);
    expect(await chain.sa.heldAt(listingId)).toBe(heldAt);
    await expect(page.getByTestId('listing-held')).toBeVisible({ timeout: 30_000 });
    await expect(renew.getByTestId('renew-held')).toHaveText(STRINGS.renew.held);
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });

    // the site's record says it too, with the same time
    await chain.until(async () => (await api(stack, `/api/records/${artifactHash}`))?.labels.listings[String(listingId)]?.heldAt === Number(heldAt), { what: 'the record\'s heldAt' });
  });

  test('on hold: roll forward to the fixed version, listed after the hold; and close when nothing is pending', async ({ page, stack, chain }) => {
    test.setTimeout(180_000);
    // the order the panel states: hold, then the fixed version is listed and funded, then the roll
    const first = await chain.openListing({ recipient: key.recipient });
    const heldAt = await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient });
    await chain.until(async () => {
      const feed = await api(stack, '/api/feed');
      const ids = (feed?.listings ?? []).map((l) => l.listingId);
      // the successor is offered, and the listing on hold is no entry of the feed
      return ids.includes(String(successor.listingId)) && !ids.includes(String(first.listingId));
    }, { what: 'the feed with the successor and without the listing on hold' });

    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    // nothing is pending: close is offered, with what comes back
    const close = page.getByTestId('close');
    await expect(close.getByTestId('close-escrow')).toHaveText(fill(STRINGS.close.escrow, { eth: formatEth((await chain.sa.getListing(first.listingId)).escrowWei) }));
    await expect(close.getByRole('button', { name: fill(STRINGS.close.ask, { id: first.listingId }) })).toBeVisible();
    // and roll forward offers the successor
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    await page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) }).click();
    await expect(page.getByTestId('rolled')).toBeVisible({ timeout: 30_000 });
    const rolled = await chain.sa.getListing(first.listingId);
    expect(Number(rolled.state)).toBe(3); // Rolled
    expect(rolled.successor).toBe(successor.listingId);
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(first.listingId);
    // the hold has ended in the roll: the view answers 0, and the page no longer says on hold
    expect(await chain.sa.heldAt(first.listingId)).toBe(0n);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Rolled, { timeout: 30_000 });
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held-since')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    // node P47: Rolled, so it takes no commits, and the sentence is no longer the hold's
    await expectCommitOffer(page, chain, first.listingId, { takes: false, text: O.notTaking, offered: false });
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    // the roll's own line stays where the panel was
    await expect(page.getByTestId('rolled')).toContainText(`listing ${successor.listingId}`);
    // the successor takes commits: it was never on hold
    expect(await chain.sa.acceptsCommits(successor.listingId)).toBe(true);

    // a listing on hold with nothing pending closes, in the close's own two steps
    const other = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, other.listingId);
    const escrow = formatEth((await chain.sa.getListing(other.listingId)).escrowWei);
    await page.goto(`/#/fund/${other.listingId}`);
    await expect(page.getByTestId('listing-held')).toBeVisible();
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: other.listingId }) }).click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: other.listingId, eth: escrow }) }).click();
    await expect(close.getByTestId('closed')).toContainText(`${escrow} ETH of escrow went back to ${stack.accounts.maker}.`, { timeout: 30_000 });
    expect(Number((await chain.sa.getListing(other.listingId)).state)).toBe(4); // Closed
    expect(await chain.sa.heldAt(other.listingId)).toBe(0n);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    // node P47: Closed, so it takes no commits, and the sentence is no longer the hold's
    await expectCommitOffer(page, chain, other.listingId, { takes: false, text: O.notTaking, offered: false });
    // the close's own line stays through that read
    await expect(close.getByTestId('closed')).toContainText(`${escrow} ETH of escrow went back to ${stack.accounts.maker}.`);
  });

  // ---------------------------------------------------------------- the rule: only a read says what the listing is
  test('a reader behind the wallet: a mined hold is not said as a hold until the page has read its block', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('behind') } });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    await expect(section.getByRole('button', { name: fill(H.ask, { id: listingId }) })).toBeVisible();
    await expect(page.getByTestId('listing-open-until')).toBeVisible();
    // from here the site's reader answers for this block, while the wallet's node goes on
    const seen = { reads: 0, of: isCallWith((await listingCall(chain, listingId)).data) };
    const letGo = await freezeReader(page, stack, chain, seen);
    const mined = await holdFromPage(page, listingId);
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    expect(await mined.innerText()).toBe(fill(H.mined, { id: listingId, tx: event.transactionHash }));
    expect(await chain.sa.heldAt(listingId)).toBe(event.args.heldAt);
    // Every read the page can take is from before the hold. It says nothing of the listing's hold: not "on hold" by
    // the receipt, and not the listing as it read it before (open, taking claims, the hold still to send).
    await expectHoldOff(page, ['hold-mined']);
    // while it reads for the block it says so; after its reads, which block it has not read, with a way to read again
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: event.blockNumber }), { timeout: 30_000 });
    expect(seen.reads).toBeGreaterThanOrEqual(AFTER_TX_READS);
    await expect(page.getByTestId('listing-reading')).toHaveCount(0);
    await expectHoldOff(page, ['hold-mined']);
    // asked again of a reader that still trails: the same, and still nothing of a hold
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: event.blockNumber }), { timeout: 30_000 });
    await expectHoldOff(page, ['hold-mined']);
    // the reader catches up: on hold, from the read, with the chain's time; and the hold's own line is where it was
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt));
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    expect(await page.getByTestId('listing-held').innerText()).toBe(fill(F.held, { id: listingId, time: at(event.args.heldAt) }));
    await expect(section.getByTestId('hold-since')).toHaveText(fill(H.since, { time: at(event.args.heldAt) }));
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(mined).toHaveText(fill(H.mined, { id: listingId, tx: event.transactionHash }));
    expect(await page.getByTestId('roll-forward').getByTestId('roll-hold-first').innerText()).toBe(fill(RF.hold.held, { time: at(event.args.heldAt) }));
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('a reader behind the wallet after a roll forward: the old hold is off the page at once, and stays off until the roll\'s block is read', async ({ page, stack, chain }) => {
    const repo = ownRepo('rolled');
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const heldAt = await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(page.getByTestId('roll-forward').getByTestId('roll-hold-first')).toContainText('push the fix');
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    const letGo = await freezeReader(page, stack, chain);
    await page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) }).click();
    const rolled = page.getByTestId('rolled');
    await expect(rolled).toBeVisible({ timeout: 30_000 });
    expect(Number((await chain.sa.getListing(first.listingId)).state)).toBe(3); // Rolled
    expect(await chain.sa.heldAt(first.listingId)).toBe(0n);
    // the page's reads are from before the roll, where the listing was on hold: none of that is on the page
    const [event] = await chain.sa.queryFilter(chain.sa.filters.RolledForward(first.listingId));
    await expectHoldOff(page, ['rolled']);
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: event.blockNumber }), { timeout: 30_000 });
    await expectHoldOff(page, ['rolled']);
    // once it reads that block: rolled forward, and not on hold; the roll's own line is where it was
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Rolled);
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(rolled).toHaveText(fill(RF.done, { id: successor.listingId, tx: event.transactionHash }));
  });

  test('a wallet disagreement: the hold\'s lines are off at once, before any read answers, and no read from before it brings them back', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('disagreed') } });
    const heldAt = await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    // on hold, by the page's read: it tells the maker what is left, push the fix
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(page.getByTestId('roll-forward').getByTestId('roll-hold-first')).toContainText('push the fix');
    await expect(renewButton(page, stack)).toBeEnabled();
    // In another tab the maker closes the listing. This page still shows it on hold, with a renewal to send.
    // From here the site's reader is the test's: first it does not answer at all, then it trails at this block.
    const reader = { mode: 'waiting', asked: 0, answered: 0, frozen: await chain.provider.send('eth_getBlockByNumber', ['latest', false]) };
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const stop = await interceptRpc(page, stack, async (p) => {
      reader.asked += 1;
      await released;
      reader.answered += 1;
      return reader.mode !== 'caught up' && p.method === 'eth_getBlockByNumber' && p.params?.[0] === 'latest' ? { result: reader.frozen } : undefined;
    }, { from: 'reader' });
    await (await (await chain.as(stack.accounts.maker)).close(listingId)).wait();
    const closedAt = Number(await chain.provider.send('eth_blockNumber', []));
    // a renewal: the wallet's own read finds the listing closed, sends nothing, and tells the page
    const renew = page.getByTestId('renew');
    await renewButton(page, stack).click();
    await expect(renew.getByRole('alert')).toHaveText(fill(STRINGS.renew.changed, { id: listingId, state: F.states.Closed }), { timeout: 30_000 });
    expect(Number(await chain.provider.send('eth_blockNumber', []))).toBe(closedAt); // nothing was sent
    // At once: the page has asked its reader, and the reader has answered nothing. "On hold" and "push the fix" are
    // off the page all the same, and it says it is reading.
    await expect(page.getByTestId('listing-reading')).toHaveText(F.reading);
    await expect.poll(() => reader.asked).toBeGreaterThan(0);
    expect(reader.answered).toBe(0);
    await expectHoldOff(page);
    await expect(renew.getByRole('alert')).toBeVisible();
    // The reader answers, of the block from before the close, where the listing is on hold: no such read is taken.
    // After its reads the page says the block it has not read, and still nothing of a hold.
    reader.mode = 'trailing';
    release();
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: closedAt }), { timeout: 30_000 });
    expect(Number(reader.frozen.number)).toBeLessThan(closedAt);
    await expectHoldOff(page);
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: closedAt }), { timeout: 30_000 });
    await expectHoldOff(page);
    // once it reads that block: closed, and nothing of the hold
    reader.mode = 'caught up';
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed);
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'roll-forward', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    await stop();
  });

  test('an action\'s own line stays through the page\'s re-reads of its listing, as it was drawn', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('own-line') } });
    const heldAt = await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    // a top-up and a renewal sent from the page, with a reader that trails: each line is there at once, from its own transaction
    const letGo = await freezeReader(page, stack, chain);
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    const toppedUp = topUp.getByTestId('topped-up');
    await expect(toppedUp).toBeVisible({ timeout: 30_000 });
    const [funded] = (await chain.sa.queryFilter(chain.sa.filters.Funded(listingId))).slice(-1);
    const topUpLine = fill(STRINGS.topUp.done, { tx: funded.transactionHash, eth: formatEth(funded.args.escrowWei) });
    await expect(toppedUp).toHaveText(topUpLine);
    // the page knows its read is behind: the line stays, and nothing of the hold or of the form is drawn with it
    await expectHoldOff(page, ['topped-up']);
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: funded.blockNumber }), { timeout: 30_000 });
    await expect(toppedUp).toHaveText(topUpLine);
    // the reader catches up: the listing as read, on hold as before, and the same line under it
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(topUp.getByTestId('top-up-escrow')).toContainText(formatEth(funded.args.escrowWei));
    await expect(toppedUp).toHaveText(topUpLine);
    // a second action, read at once this time: both lines stay, each as it was said
    await renewButton(page, stack).click();
    const renewed = page.getByTestId('renew').getByTestId('renewed');
    await expect(renewed).toBeVisible({ timeout: 30_000 });
    const after = await chain.sa.getListing(listingId);
    const renewedLine = await renewed.innerText();
    expect(renewedLine).toMatch(new RegExp(`^Renewed \\(transaction 0x[0-9a-f]{64}\\)\\. The listing fee is paid until ${at(after.fundedUntil).replace(/[.:+-]/g, '\\$&')}\\.$`));
    await expect(page.getByTestId('renew').getByTestId('renew-period')).toHaveText(fill(STRINGS.renew.until, { time: at(after.fundedUntil) }), { timeout: 30_000 });
    await expect(renewed).toHaveText(renewedLine);
    await expect(toppedUp).toHaveText(topUpLine);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
  });

  test('on hold, and closed from elsewhere: a roll from this page sends nothing, and the page stops saying on hold', async ({ page, stack, chain }) => {
    const first = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    const button = page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await expect(button).toBeVisible();
    await expect(page.getByTestId('listing-held')).toBeVisible();
    // in another tab, the maker closes the listing; this page still shows it on hold, with the roll to send
    await (await (await chain.as(stack.accounts.maker)).close(first.listingId)).wait();
    await button.click();
    // the wallet's own read finds it closed: nothing is sent, and the page reads it from that block
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'roll-forward', 'rolled', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(0n);
    expect((await chain.sa.getListing(first.listingId)).successor).toBe(0n);
  });

  test('roll forward: a successor that went on hold after the picker loaded is refused, and nothing is sent', async ({ page, stack, chain }) => {
    const first = await chain.openListing({ recipient: key.recipient });
    const successor = await chain.openListing({ recipient: key.recipient });
    await chain.until(async () => {
      const ids = ((await api(stack, '/api/feed'))?.listings ?? []).map((l) => l.listingId);
      return ids.includes(String(first.listingId)) && ids.includes(String(successor.listingId));
    }, { what: 'the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const roll = page.getByTestId('roll-forward');
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    // elsewhere, the successor's maker holds it: it is still Open, and the contract would take it as a successor
    await holdOnChain(chain, stack, successor.listingId);
    await page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) }).click();
    await expect(roll.getByRole('alert')).toHaveText(fill(RF.successorOnHold, { id: successor.listingId }));
    const l = await chain.sa.getListing(first.listingId);
    expect(Number(l.state)).toBe(1); // Open: not rolled
    expect(l.successor).toBe(0n);
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(0n);
    // the panel looked again: the listing on hold is no longer among the successors
    await expect.poll(async () => (await roll.locator('option').evaluateAll((os) => os.map((o) => o.value))).includes(String(successor.listingId))).toBe(false);
    await expect(page.getByTestId('rolled')).toHaveCount(0);
  });

  test('on hold: a fixed version listed after the page was opened is found when the panel looks again', async ({ page, stack, chain }) => {
    // a repository of its own: until the fixed version is listed, the maker has nothing to roll to
    const repo = `https://github.com/acme/later-${Date.now().toString(36)}`;
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await holdOnChain(chain, stack, first.listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const roll = page.getByTestId('roll-forward');
    await expect(roll).toContainText(RF.none);
    // the maker's order: with the listing on hold, the fixed version is listed and funded, here from the test's side
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the fixed version in the feed' });
    await expect(roll).toContainText(RF.none);
    await roll.getByRole('button', { name: RF.again }).click();
    const button = roll.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId('rolled')).toBeVisible({ timeout: 30_000 });
    expect((await chain.sa.getListing(first.listingId)).successor).toBe(successor.listingId);
  });

  test('a listing opened from its own page offers the hold once the page has read it open, without a reload', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false, spec: { repo: ownRepo('opened') } });
    expect(Number((await chain.sa.getListing(listingId)).state)).toBe(0); // Listed
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await page.getByRole('button', { name: STRINGS.chain.fund }).click();
    const openedLine = page.getByTestId('opened');
    await expect(openedLine).toBeVisible({ timeout: 30_000 });
    // the page reads the listing from the block it opened in: its state is that read's, and the hold is there, for
    // the wallet that funded it
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    const opened = await chain.sa.getListing(listingId);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    await expect(page.getByTestId('listing-open-until')).toHaveText(fill(F.alreadyOpen, { id: listingId, until: at(opened.fundedUntil) }));
    const section = page.getByTestId('hold');
    await expect(section.getByRole('button', { name: fill(H.ask, { id: listingId }) })).toBeVisible();
    await expect(page.getByTestId('roll-forward')).toBeVisible();
    // the opening's own line is the site's as it was, with its transaction, and stays through that read
    const line = fill(STRINGS.chain.opened, { id: String(listingId), until: at(opened.fundedUntil), tx: funded.transactionHash });
    await expect(openedLine).toHaveText(line);
    await holdFromPage(page, listingId);
    const heldAt = await chain.sa.heldAt(listingId);
    expect(heldAt > 0n).toBe(true);
    // on hold, by the page's read: its own line of the listing no longer says "open until", and the pill is not green
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt), { timeout: 30_000 });
    await expect(page.getByTestId('listing-open-until')).toHaveCount(0);
    await expect(page.getByTestId('listing-summary').locator('.pill-ok')).toHaveCount(0);
    // the opening's line is the receipt's, as on any page of the site: it is not re-worded by what the listing became
    await expect(openedLine).toHaveText(line);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('the wallet\'s node has another of the maker\'s listings under the id: the hold is not sent, for either, and the page reads again', async ({ page, stack, chain }) => {
    const shown = await chain.openListing({ recipient: key.recipient });
    const other = await chain.openListing({ recipient: key.recipient });
    expect(other.artifactHash).not.toBe(shown.artifactHash);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${shown.listingId}`);
    await connect(page, stack.accounts.maker);
    // The wallet's node answers for this id with the other listing: the same maker's, open, of another artifact. The
    // site's reader, and so the page, still has the listing the maker is looking at.
    const mine = await listingCall(chain, shown.listingId);
    const theirs = await listingCall(chain, other.listingId);
    await interceptRpc(page, stack, (p) => (isCallWith(mine.data)(p) ? { result: theirs.result } : undefined), { from: 'wallet' });
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: shown.listingId }) });
    await ask.click();
    await section.getByRole('button', { name: fill(H.confirm, { id: shown.listingId }) }).click();
    await expect(section.getByRole('alert')).toHaveText(fill(H.changed, { id: shown.listingId }), { timeout: 30_000 });
    // nothing was sent: neither listing is on hold
    expect(await chain.sa.heldAt(shown.listingId)).toBe(0n);
    expect(await chain.sa.heldAt(other.listingId)).toBe(0n);
    // the page read the listing again, from the block of the wallet's read: as its own reader has it, not on hold,
    // with the hold to send from its first step, and the refusal still said
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(section.getByTestId('hold-mined')).toHaveCount(0);
    await expect(section.getByRole('alert')).toHaveText(fill(H.changed, { id: shown.listingId }));
  });

  test('the hold\'s first step is for the listing it was taken on: another of the maker\'s listings under the id gets no confirmation without a first step of its own (R1-F3)', async ({ page, stack, chain }) => {
    const shown = await chain.openListing({ recipient: key.recipient });
    const other = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${shown.listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: shown.listingId }) });
    const confirm = section.getByRole('button', { name: fill(H.confirm, { id: shown.listingId }) });
    // the first step, taken for the listing the maker is looking at
    await ask.click();
    await expect(confirm).toBeVisible();
    // From here the site's reader has another of the maker's listings under this id, open and not on hold (the chain's
    // blocks were replaced). Another action of the page has it read the listing again: a top-up, which the wallet's
    // node takes for the listing it has.
    const mine = await listingCall(chain, shown.listingId);
    const theirs = await listingCall(chain, other.listingId);
    await interceptRpc(page, stack, (p) => (isCallWith(mine.data)(p) ? { result: theirs.result } : undefined), { from: 'reader' });
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(topUp.getByTestId('topped-up')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-summary')).toContainText((await chain.sa.getListing(other.listingId)).listingCid, { timeout: 30_000 });
    // The confirmation that was taken for the first listing is not offered for this one: one click would have held a
    // version the maker never took the first step for, and a hold has no way back. The first step is to take again.
    await expect(section.getByTestId('hold-warning')).toBeVisible();
    await expect(confirm).toHaveCount(0);
    await expect(ask).toBeVisible();
    expect(await chain.sa.heldAt(shown.listingId)).toBe(0n);
    expect(await chain.sa.heldAt(other.listingId)).toBe(0n);
    // Taken again, it is for the listing now shown, and the wallet's read is held to that same listing. The wallet's
    // node has the first listing under the id, so nothing is sent, for either.
    await ask.click();
    await confirm.click();
    await expect(section.getByRole('alert')).toHaveText(fill(H.changed, { id: shown.listingId }), { timeout: 30_000 });
    expect(await chain.sa.heldAt(shown.listingId)).toBe(0n);
    expect(await chain.sa.heldAt(other.listingId)).toBe(0n);
    await expect(section.getByTestId('hold-mined')).toHaveCount(0);
  });

  test('a roll that was mined and failed keeps its error on the page while the page reads, and after (R1-F5)', async ({ page, stack, chain }) => {
    const repo = ownRepo('roll-failed');
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    // The wallet's node reports the roll's transaction as mined and reverted: its receipt, with the status of a
    // failure. The page is told the block all the same, and the site's reader trails it.
    const receipts = { failed: 0 };
    await interceptRpc(page, stack, async (p) => {
      if (p.method !== 'eth_getTransactionReceipt') return undefined;
      const receipt = await ofNode(stack, p);
      if (!receipt) return undefined;
      receipts.failed += 1;
      return { result: { ...receipt, status: '0x0' } };
    }, { from: 'wallet' });
    const letGo = await freezeReader(page, stack, chain);
    await page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) }).click();
    // the roll's own error: said at once, while the page reads, and with the block it has not read once its reads are over
    const failure = page.getByRole('alert').filter({ hasText: fill(C.failed, { reason: '' }) });
    await expect(failure).toBeVisible({ timeout: 30_000 });
    expect(receipts.failed).toBeGreaterThan(0);
    const [mined] = await chain.sa.queryFilter(chain.sa.filters.RolledForward(first.listingId));
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: mined.blockNumber }), { timeout: 30_000 });
    await expect(failure).toBeVisible();
    await expect(page.getByTestId('rolled')).toHaveCount(0);
    await expectHoldOff(page);
    // and after: the page reads that block, where the listing is no longer one to roll, and the error is still said
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Rolled);
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(failure).toBeVisible();
    await expect(page.getByTestId('roll-forward')).toHaveCount(0);
    await expect(page.getByTestId('rolled')).toHaveCount(0);
  });

  test('the wallet\'s node has no listing under the id: a renewal, a top-up and a close each send nothing and tell the page, as any other disagreement; a read that fails on the way tells it nothing (R1-F4)', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('missing') } });
    const heldAt = await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(page.getByTestId('roll-forward').getByTestId('roll-hold-first')).toContainText('push the fix');
    await expect(renewButton(page, stack)).toBeEnabled();
    // The wallet's node has a chain that ends before this listing: the contract counts one listing fewer there, and
    // getListing reverts for the id, as the contract does for an id it has not. The site's reader still has the listing.
    const count = chain.sa.interface.encodeFunctionData('listingCount');
    const mine = await listingCall(chain, listingId);
    const badId = new Interface(['error Error(string)']).encodeErrorResult('Error', ['bad listingId']);
    const wallet = { mode: 'missing' };
    await interceptRpc(page, stack, (p) => {
      if (wallet.mode === 'failing' && isCallWith(count)(p)) return { error: { code: -32005, message: 'rate limit exceeded' } };
      if (wallet.mode !== 'missing') return undefined;
      if (isCallWith(count)(p)) return { result: word(BigInt(listingId) - 1n) };
      return isCallWith(mine.data)(p) ? { error: { code: 3, message: 'execution reverted: bad listingId', data: badId } } : undefined;
    }, { from: 'wallet' });
    // the site's reader: counted, and for the first refusal held back, so that what the page does at once shows
    const reader = { reads: 0, hold: true };
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    await interceptRpc(page, stack, async (p) => {
      if (isCallWith(mine.data)(p)) reader.reads += 1;
      if (reader.hold) await released;
      return undefined;
    }, { from: 'reader' });
    const sent = async () => Number(await chain.provider.send('eth_blockNumber', []));
    const before = await sent();

    // a renewal: nothing is sent, and the page is told at once, before its reader answers
    const renew = page.getByTestId('renew');
    await renewButton(page, stack).click();
    await expect(renew.getByRole('alert')).toHaveText(fill(STRINGS.renew.changed, { id: listingId, state: F.missing }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-reading')).toHaveText(F.reading);
    await expectHoldOff(page);
    // its reader has the listing: the page reads it again, and says what that read says
    reader.hold = false;
    release();
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt), { timeout: 30_000 });
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    expect(await sent()).toBe(before);

    // a top-up: the same
    const topUp = page.getByTestId('top-up');
    let reads = reader.reads;
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(topUp.getByRole('alert')).toHaveText(fill(STRINGS.topUp.changed, { id: listingId, state: F.missing }), { timeout: 30_000 });
    await expect.poll(() => reader.reads).toBeGreaterThan(reads);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt), { timeout: 30_000 });
    expect(await sent()).toBe(before);

    // a close, in its two steps: the same, and the confirmation is taken back
    const close = page.getByTestId('close');
    reads = reader.reads;
    const escrow = formatEth((await chain.sa.getListing(listingId)).escrowWei);
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) }).click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: escrow }) }).click();
    await expect(close.getByRole('alert')).toHaveText(fill(STRINGS.close.changed, { id: listingId }), { timeout: 30_000 });
    await expect(close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => reader.reads).toBeGreaterThan(reads);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt), { timeout: 30_000 });
    expect(await sent()).toBe(before);
    expect(Number((await chain.sa.getListing(listingId)).state)).toBe(1); // Open: not closed

    // A read through the wallet that fails on the way (the node, not the contract) is the action's failure, and no
    // disagreement: the page is told nothing, reads nothing, and goes on saying what its read says.
    wallet.mode = 'failing';
    reads = reader.reads;
    await renewButton(page, stack).click();
    await expect(renew.getByRole('alert')).toContainText(fill(C.failed, { reason: '' }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(page.getByTestId('roll-forward').getByTestId('roll-hold-first')).toContainText('push the fix');
    for (const id of ['listing-reading', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(reader.reads).toBe(reads);
    expect(await sent()).toBe(before);
  });

  test('a roll whose read finds this listing closed tells the page, whatever the successor\'s read would have come to (R1-F4)', async ({ page, stack, chain }) => {
    const repo = ownRepo('roll-source');
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const heldAt = await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    const button = page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await expect(button).toBeVisible();
    // In another tab the maker closes this listing. And the wallet's node cannot give the successor: its read fails.
    await (await (await chain.as(stack.accounts.maker)).close(first.listingId)).wait();
    const theirs = await listingCall(chain, successor.listingId);
    await interceptRpc(page, stack, (p) => (isCallWith(theirs.data)(p) ? { error: { code: -32005, message: 'rate limit exceeded' } } : undefined), { from: 'wallet' });
    await button.click();
    // What the wallet has of this listing is not lost to that failure: nothing is sent, the page is told, and it
    // reads the listing from that block. It stops saying on hold and "push the fix" of a listing that is closed.
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'roll-forward', 'rolled', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    await expect(page.getByRole('alert').filter({ hasText: fill(RF.changed, { id: successor.listingId }) })).toBeVisible();
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(0n);
  });

  test('a renewal whose read finds this listing closed tells the page, whatever its fee read would have come to (R1-F4)', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('renew-source') } });
    const heldAt = await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(renewButton(page, stack)).toBeEnabled();
    // In another tab the maker closes this listing. And the wallet's node cannot give the listing fee: that read fails.
    await (await (await chain.as(stack.accounts.maker)).close(listingId)).wait();
    const fee = chain.sa.interface.encodeFunctionData('listingFeeWei');
    const asked = { fee: 0 };
    await interceptRpc(page, stack, (p) => {
      if (!isCallWith(fee)(p)) return undefined;
      asked.fee += 1;
      return { error: { code: -32005, message: 'rate limit exceeded' } };
    }, { from: 'wallet' });
    const sent = Number(await chain.provider.send('eth_blockNumber', []));
    await renewButton(page, stack).click();
    // What the wallet has of this listing rules the renewal out by itself: the fee is not asked, nothing is sent, the
    // page is told, and it reads the listing from that block. It stops saying on hold of a listing that is closed.
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'roll-forward', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    expect(asked.fee, 'the fee was not asked of the wallet\'s node').toBe(0);
    expect(Number(await chain.provider.send('eth_blockNumber', []))).toBe(sent);
  });

  test('an action still out when a read says "no such listing" asks for another read: the page says it is reading, and offers Read again by the floor (R2-F2)', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false, spec: { repo: ownRepo('still-out') } });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    // the listing is opened from this page, so the opening's own line is on it (what becomes of it: R5-F4, at the end)
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    const openingForm = [page.getByLabel(STRINGS.chain.escrow, { exact: true }), page.getByRole('button', { name: STRINGS.chain.fund })];
    for (const part of openingForm) await expect(part).toBeVisible();
    await openingForm[1].click();
    await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.maker }));
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    for (const part of openingForm) await expect(part).toHaveCount(0);
    await expect(renewButton(page, stack)).toBeEnabled();
    const start = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
    // The wallet's node holds back the receipt of the first transaction it is asked about: the renewal, which stays out.
    const wallet = { heldTx: null };
    let releaseReceipt;
    const receiptReleased = new Promise((resolve) => { releaseReceipt = resolve; });
    await interceptRpc(page, stack, async (p) => {
      if (p.method !== 'eth_getTransactionReceipt') return undefined;
      wallet.heldTx ??= p.params[0];
      if (p.params[0] === wallet.heldTx) await receiptReleased;
      return undefined;
    }, { from: 'wallet' });
    await renewButton(page, stack).click();
    await expect.poll(() => wallet.heldTx).not.toBeNull();
    // Meanwhile the site's reader comes to a chain that ends before this listing (its block was replaced): the
    // contract counts one listing fewer there. A top-up from the page is mined, and the page reads again.
    const count = chain.sa.interface.encodeFunctionData('listingCount');
    const reader = { missing: true, trailing: false };
    await interceptRpc(page, stack, (p) => {
      if (reader.missing && isCallWith(count)(p)) return { result: word(BigInt(listingId) - 1n) };
      return reader.trailing && p.method === 'eth_getBlockByNumber' && p.params?.[0] === 'latest' ? { result: start } : undefined;
    }, { from: 'reader' });
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(page.getByText(fill(F.notFound, { id: listingId }))).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-summary')).toHaveCount(0);
    for (const id of ['listing-reading', 'listing-behind', 'listing-read-again']) await expect(page.getByTestId(id)).toHaveCount(0);
    const [toppedUp] = (await chain.sa.queryFilter(chain.sa.filters.Funded(listingId))).slice(-1);
    const [renewed] = (await chain.sa.queryFilter(chain.sa.filters.Renewed(listingId))).slice(-1);
    expect(renewed.blockNumber).toBeLessThan(toppedUp.blockNumber);
    // Now the renewal's receipt arrives: a transaction of the page was mined, and the page is told. Its reader trails.
    // On the "no such listing" page it says it is reading, and then names the block its next read has to reach, which
    // is the floor (the block of the read on display, later than the renewal's), with Read again.
    reader.trailing = true;
    releaseReceipt();
    const behind = page.getByTestId('listing-behind');
    await expect(behind).toBeVisible({ timeout: 30_000 });
    const said = new RegExp(`^${fill(F.behind, { block: '(\\d+)' }).replace(/[.:]/g, '\\$&')}$`).exec(await behind.innerText());
    expect(said, await behind.innerText()).not.toBeNull();
    expect(Number(said[1]), 'the block of the read on display, not the renewal\'s').toBeGreaterThanOrEqual(toppedUp.blockNumber);
    await expect(page.getByText(fill(F.notFound, { id: listingId }))).toBeVisible();
    // asked again of a reader that still trails: reading, then the same
    await page.getByTestId('listing-read-again').click();
    await expect(behind).toBeVisible({ timeout: 30_000 });
    // a reader that has caught up, on a chain that has the listing: Read again takes that read, and the page is the listing's
    reader.trailing = false;
    reader.missing = false;
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    await expect(behind).toHaveCount(0);
    await expect(page.getByText(fill(F.notFound, { id: listingId }))).toHaveCount(0);
    // The opening's own line went with the listing when the page took "no such listing". The listing read again is
    // drawn from that read: it is Open, so nothing on the page offers to open it (R5-F4).
    await expect(page.getByTestId('top-up')).toBeVisible();
    await expect(page.getByTestId('opened')).toHaveCount(0);
    for (const part of openingForm) await expect(part).toHaveCount(0);
  });

  test('an opening whose receipt arrives after a read said "no such listing": the listing read again as open has no opening form (R5-F4)', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false, spec: { repo: ownRepo('late-opening') } });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    const openingForm = [page.getByLabel(STRINGS.chain.escrow, { exact: true }), page.getByRole('button', { name: STRINGS.chain.fund })];
    for (const part of openingForm) await expect(part).toBeVisible();
    // The wallet's node holds back the receipt of the opening, the first transaction it is asked about. Later in the
    // test (`missing`) it is on a chain that ends before this listing: the contract counts one listing fewer there.
    const count = chain.sa.interface.encodeFunctionData('listingCount');
    const fewer = { result: word(BigInt(listingId) - 1n) };
    const wallet = { heldTx: null, missing: false };
    let releaseReceipt;
    const receiptReleased = new Promise((resolve) => { releaseReceipt = resolve; });
    await interceptRpc(page, stack, async (p) => {
      if (wallet.missing && isCallWith(count)(p)) return fewer;
      if (p.method !== 'eth_getTransactionReceipt') return undefined;
      wallet.heldTx ??= p.params[0];
      if (p.params[0] === wallet.heldTx) await receiptReleased;
      return undefined;
    }, { from: 'wallet' });
    await openingForm[1].click();
    await expect.poll(() => wallet.heldTx).not.toBeNull();
    await chain.until(async () => Number((await chain.sa.getListing(listingId)).state) === 1, { what: 'the opening mined' });
    // The page has not been told: it shows the listing it read, Listed. A close from it is refused by its read through
    // the wallet, which has no listing under the id; the page reads again, and its reader has none either.
    const reader = { missing: true };
    await interceptRpc(page, stack, (p) => (reader.missing && isCallWith(count)(p) ? fewer : undefined), { from: 'reader' });
    wallet.missing = true;
    const close = page.getByTestId('close');
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) }).click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: formatEth(0n) }) }).click();
    await expect(page.getByText(fill(F.notFound, { id: listingId }))).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-summary')).toHaveCount(0);
    for (const part of openingForm) await expect(part).toHaveCount(0);
    // Now the opening's receipt arrives, on a page that shows no listing: the page is told of its block and reads, and
    // both nodes have the listing again. It is drawn from that read: open, with nothing that offers to open it. The
    // opening's own line went with the page that had the opening.
    reader.missing = false;
    wallet.missing = false;
    releaseReceipt();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    await expect(page.getByTestId('top-up')).toBeVisible();
    await expect(page.getByTestId('listing-reading')).toHaveCount(0, { timeout: 30_000 });
    for (const part of openingForm) await expect(part).toHaveCount(0);
    await expect(page.getByTestId('opened')).toHaveCount(0);
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    expect(funded.transactionHash).toBe(wallet.heldTx);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('an opening whose receipt arrives after another action had the page read the same listing as open: the receipt\'s line appears, and nothing offers to open it (R7-F1)', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false, spec: { repo: ownRepo('late-receipt') } });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    const openingForm = [page.getByLabel(STRINGS.chain.escrow, { exact: true }), page.getByRole('button', { name: STRINGS.chain.fund })];
    for (const part of openingForm) await expect(part).toBeVisible();
    // the wallet's node holds back the receipt of the opening, the first transaction it is asked about
    const wallet = { heldTx: null };
    let releaseReceipt;
    const receiptReleased = new Promise((resolve) => { releaseReceipt = resolve; });
    await interceptRpc(page, stack, async (p) => {
      if (p.method !== 'eth_getTransactionReceipt') return undefined;
      wallet.heldTx ??= p.params[0];
      if (p.params[0] === wallet.heldTx) await receiptReleased;
      return undefined;
    }, { from: 'wallet' });
    await openingForm[1].click();
    await expect.poll(() => wallet.heldTx).not.toBeNull();
    await chain.until(async () => Number((await chain.sa.getListing(listingId)).state) === 1, { what: 'the opening mined' });
    // The page has not been told: it shows the listing as it read it, Listed. A close from it is refused by its read
    // through the wallet (the escrow is no longer the one the page shows), and the page reads: the listing is open.
    const close = page.getByTestId('close');
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) }).click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: formatEth(0n) }) }).click();
    await expect(close.getByRole('alert')).toHaveText(fill(STRINGS.close.changed, { id: listingId }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    // the same listing, read as open: the form is the read's and is gone, and the opening has no line before its receipt
    for (const part of openingForm) await expect(part).toHaveCount(0);
    await expect(page.getByTestId('opened')).toHaveCount(0);
    // The receipt arrives. The opening's line is on the page, with the transaction the chain has, and stays through
    // the read the receipt asks for; nothing offers to open the listing.
    releaseReceipt();
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    expect(funded.transactionHash).toBe(wallet.heldTx);
    const opened = await chain.sa.getListing(listingId);
    const line = fill(STRINGS.chain.opened, { id: String(listingId), until: at(opened.fundedUntil), tx: funded.transactionHash });
    await expect(page.getByTestId('opened')).toHaveText(line, { timeout: 30_000 });
    await expect(page.getByTestId('listing-reading')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    await expect(page.getByTestId('opened')).toHaveText(line);
    for (const part of openingForm) await expect(part).toHaveCount(0);
    expect(Number((await chain.sa.getListing(listingId)).state)).toBe(1); // Open: the close sent nothing
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('a listing not yet opened, and a close from its page mined ahead of the reader: the opening\'s form is off with the other forms, and its own error stays', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false, spec: { repo: ownRepo('listed-behind') } });
    // another wallet first: the opening is refused for it, and that is the opening's own error on the page
    await installWallet(page, stack, stack.accounts.other);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    const openingForm = [page.getByLabel(STRINGS.chain.escrow, { exact: true }), page.getByRole('button', { name: STRINGS.chain.fund })];
    for (const part of openingForm) await expect(part).toBeVisible();
    await openingForm[1].click();
    const refused = page.getByRole('alert').filter({ hasText: fill(STRINGS.fund.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }) });
    await expect(refused).toBeVisible({ timeout: 30_000 });
    for (const part of openingForm) await expect(part).toBeVisible();
    // from here the site's reader answers for this block; the maker's wallet closes the listing from the page
    const letGo = await freezeReader(page, stack, chain);
    await useAccount(page, stack.accounts.maker);
    const close = page.getByTestId('close');
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) }).click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: formatEth(0n) }) }).click();
    await expect(page.getByTestId('closed')).toBeVisible({ timeout: 30_000 });
    const [closed] = await chain.sa.queryFilter(chain.sa.filters.Closed(listingId));
    // The page knows its read is behind, and says which block it has not read. Beside that notice nothing offers to
    // open the listing: no escrow field, no button, as the forms of top-up, renewal and close are off. What the
    // opening itself said stays, and so does the close's own line.
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: closed.blockNumber }), { timeout: 30_000 });
    for (const part of openingForm) await expect(part).toHaveCount(0);
    await expect(page.getByText(fill(STRINGS.chain.fee, { fee: formatEth(BigInt(stack.listingFeeWei)) }))).toHaveCount(0);
    await expect(refused).toBeVisible();
    await expect(page.getByTestId('closed')).toBeVisible();
    await expect(page.getByTestId('listing-state')).toHaveCount(0);
    // the reader catches up: closed, by the read, and still nothing offers to open it
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    for (const part of openingForm) await expect(part).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  // ---------------------------------------------------------------- one read is one block
  test('a block replaced under the page\'s read: the listing of one chain is never shown with the hold of the other', async ({ page, stack, chain }) => {
    // what the chain has under the id: an open listing of the maker's, not on hold, taking commits
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const shown = await chain.sa.getListing(listingId);
    // The block the page reads first is one the node then replaces: there the listing under the id was on hold, and
    // took no commits. The listing is the chain's from the first call (the node's own answer). Its hold, and what it
    // takes (node P47), are still the replaced block's on the first try, and the chain's from then on.
    let moved = false;
    const replaced = { hold: 0, takes: 0 };
    await installWallet(page, stack);
    await interceptRpc(page, stack, async (p) => {
      if (isHeldAtCall(p) && !moved) {
        replaced.hold += 1;
        return { result: word(1_800_000_000) };
      }
      if (isAcceptsCommitsCall(p) && !moved) {
        replaced.takes += 1;
        return { result: word(0) };
      }
      // the block at that height has another hash when the page asks again after the first try's calls
      if (p.method === 'eth_getBlockByNumber' && p.params?.[0] !== 'latest' && !moved) {
        moved = true;
        const block = await ofNode(stack, p);
        return { result: { ...block, hash: otherHash(block.hash) } };
      }
      return undefined;
    }, { from: 'reader' });
    await page.goto(`/#/fund/${listingId}`);
    // the page shows one block's answers: the chain's listing, open, and nothing of the replaced block's hold
    await expect(page.getByTestId('listing-summary')).toContainText(shown.listingCid);
    expect(moved).toBe(true);
    // (it did read the replaced block's two answers, once each: the read was made again)
    expect(replaced).toEqual({ hold: 1, takes: 1 });
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    for (const id of ['listing-held', 'listing-held-since']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId('listing-open-until')).toBeVisible();
    await expect(page.getByTestId('hold').getByTestId('hold-since')).toHaveCount(0);
    await expect(page.getByTestId('hold').getByTestId('hold-warning')).toBeVisible();
    // nor anything of what the replaced block said the listing takes (node P47): by the node's own answer for this
    // id, and the site's record of this listing, the site offers it
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true });
    expect(await page.getByTestId('roll-forward').getByTestId('roll-hold-first').innerText()).toBe(RF.hold.first);
  });

  test('a block replaced under the page\'s read: a listing on hold is never shown as taking the commits the replaced block said it took (node P47)', async ({ page, stack, chain }) => {
    // the case above, the other way. The chain as it stands: the listing is on hold, and takes no commits
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const heldAt = await holdOnChain(chain, stack, listingId);
    // in the block the page reads first, which the node then replaces, it was not on hold and took commits
    let moved = false;
    const replaced = { hold: 0, takes: 0 };
    await installWallet(page, stack);
    await interceptRpc(page, stack, async (p) => {
      if (isHeldAtCall(p) && !moved) {
        replaced.hold += 1;
        return { result: word(0) };
      }
      if (isAcceptsCommitsCall(p) && !moved) {
        replaced.takes += 1;
        return { result: word(1) };
      }
      if (p.method === 'eth_getBlockByNumber' && p.params?.[0] !== 'latest' && !moved) {
        moved = true;
        const block = await ofNode(stack, p);
        return { result: { ...block, hash: otherHash(block.hash) } };
      }
      return undefined;
    }, { from: 'reader' });
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    expect(moved).toBe(true);
    expect(replaced).toEqual({ hold: 1, takes: 1 });
    // by the node's own answer for this id: on hold, no commit, and nothing on the page says the site offers it
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });
    await expect(page.getByTestId('listing-open-until')).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toMatch(/offers it to hunters/i);
  });

  test('a node that does not have the block the page named refuses the page\'s calls: a failed read, and nothing read by number in its place', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    // The headers come from one node; the calls reach another, which is on another chain at that height. Asked for
    // that block by its hash, it says it does not have it. (Asked by number it would have answered, of its own chain.)
    const calls = [];
    const stop = await interceptRpc(page, stack, (p) => {
      if (p.method !== 'eth_call') return undefined;
      calls.push(p.params[1]);
      return { error: { code: -32000, message: 'header not found' } };
    }, { from: 'reader' });
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByText(F.readFailed.replace('{reason}', ''), { exact: false })).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const block of calls) expect(block, 'each call names the block by its hash, and none is asked by number').toEqual({ blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), requireCanonical: true });
    await stop();
    await page.getByRole('button', { name: F.retry }).click();
    await expect(page.getByTestId('listing-held')).toBeVisible();
  });

  test('a read address that does not take a block hash on a call: a failed read every time, and the listing is never read by number', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    // The site's read address has to take a block's hash on a call (deploy/client.env). One that does not is a
    // misconfiguration, and the page does not work around it: it never learns from the refusal to ask another way.
    const ofTheListing = [isCallWith((await listingCall(chain, listingId)).data), isHeldAtCall, isAcceptsCommitsCall];
    const asked = { byHash: 0, byNumber: 0 };
    const stop = await interceptRpc(page, stack, (p) => {
      if (p.method !== 'eth_call') return undefined;
      if (typeof p.params[1] === 'string') {
        if (ofTheListing.some((is) => is(p))) asked.byNumber += 1;
        return undefined;
      }
      asked.byHash += 1;
      return { error: { code: -32602, message: 'invalid argument 1: cannot unmarshal object into Go value of type string' } };
    }, { from: 'reader' });
    const unread = page.getByText(F.readFailed.replace('{reason}', ''), { exact: false });
    await page.goto(`/#/fund/${listingId}`);
    await expect(unread).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    // asked again, it is asked the same way: by the block's hash
    const first = asked.byHash;
    expect(first).toBeGreaterThan(0);
    await page.getByRole('button', { name: F.retry }).click();
    await expect.poll(() => asked.byHash).toBeGreaterThan(first);
    await expect(unread).toBeVisible();
    await page.reload();
    await expect(unread).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(asked.byNumber, 'the listing and its hold are never read from the read address by a block\'s number').toBe(0);
    // an address that takes the hash: the same page reads
    await stop();
    await page.getByRole('button', { name: F.retry }).click();
    await expect(page.getByTestId('listing-held')).toBeVisible();
  });

  test('through a hold sent from the page: the listing and its hold are read from the read address by the block\'s hash, and from the wallet\'s node by its number alone', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    const isListingCall = isCallWith((await listingCall(chain, listingId)).data);
    const ofTheListing = [isListingCall, isHeldAtCall, isAcceptsCommitsCall];
    const calls = { reader: [], wallet: [] };
    // node P47: the block each read of the listing named, and the block each read of what it takes named
    const blocks = { listing: [], takes: [] };
    await interceptRpc(page, stack, (p) => {
      if (ofTheListing.some((is) => is(p))) calls.reader.push(p.params[1]);
      if (isListingCall(p)) blocks.listing.push(p.params[1].blockHash);
      if (isAcceptsCommitsCall(p)) blocks.takes.push(p.params[1].blockHash);
      return undefined;
    }, { from: 'reader' });
    await interceptRpc(page, stack, (p) => { if (p.method === 'eth_call') calls.wallet.push(p.params[1]); return undefined; }, { from: 'wallet' });
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    await holdFromPage(page, listingId);
    await expect(page.getByTestId('listing-held-since')).toBeVisible({ timeout: 30_000 });
    // the wallet's node read the listing and its hold before the hold was sent (the page checks it is the listing
    // shown), and every one of those calls named its block by number: a wallet's node is never sent the hash form
    expect(calls.wallet.length).toBeGreaterThan(0);
    for (const block of calls.wallet) expect(block, 'a call through the wallet').toEqual(expect.stringMatching(/^0x[0-9a-f]+$/));
    // and every read of the listing and its hold from the read address, before the hold and after it, named its block by hash
    expect(calls.reader.length).toBeGreaterThanOrEqual(4);
    for (const block of calls.reader) expect(block, 'a read of the listing from the read address').toEqual({ blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), requireCanonical: true });
    // and whether the listing takes commits is asked once for each read of the listing, of that read's block (node P47)
    expect(blocks.takes.length).toBeGreaterThanOrEqual(2);
    expect([...blocks.takes].sort()).toEqual([...blocks.listing].sort());
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });
  });

  test('the site\'s record does not have the listing yet: the panel reads it again when asked, and then finds the fixed version', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const repo = `https://github.com/acme/trails-${Date.now().toString(36)}`;
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await holdOnChain(chain, stack, first.listingId);
    // the mirror trails the opening: the first read of the record finds none
    let asked = 0;
    await page.route((url) => url.pathname === `/api/records/${first.artifactHash.toLowerCase()}`, (route) => {
      asked += 1;
      if (asked > 1) return route.continue();
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'RECORD_NOT_FOUND' }) });
    });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const roll = page.getByTestId('roll-forward');
    await expect(roll).toContainText(RF.noIdentity);
    expect(asked).toBe(1);
    // the fixed version is listed and funded meanwhile
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the fixed version in the feed' });
    // looking again reads the record first, which now has this listing, and then the open listings
    await roll.getByRole('button', { name: RF.again }).click();
    const button = roll.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await expect(button).toBeVisible({ timeout: 20_000 });
    expect(asked).toBe(2);
    await expect(roll).not.toContainText(RF.noIdentity);
    await button.click();
    await expect(page.getByTestId('rolled')).toBeVisible({ timeout: 30_000 });
    expect((await chain.sa.getListing(first.listingId)).successor).toBe(successor.listingId);
  });

  test('on hold in the lists: the record, and the other listings of its repository on a listing\'s page and in a feed entry; never a feed entry itself', async ({ page, stack, chain }) => {
    test.setTimeout(180_000);
    const held = await chain.openListing({ recipient: key.recipient });
    const open = await chain.openListing({ recipient: key.recipient });
    // the same version listed by another wallet: it does not count, and is on hold too
    const apart = await chain.replay(held.view, stack.accounts.other);
    await chain.notCounted(held.artifactHash, apart.listingId);
    const heldAt = await holdOnChain(chain, stack, held.listingId);
    const apartAt = await holdOnChain(chain, stack, apart.listingId, stack.accounts.other);
    let record = null;
    let entry = null;
    await chain.until(async () => {
      record = await api(stack, `/api/records/${held.artifactHash}`);
      const feed = await api(stack, '/api/feed');
      entry = feed?.listings.find((l) => l.listingId === String(open.listingId)) ?? null;
      const inFeed = (id) => [...(feed?.listings ?? []), ...(feed?.notCounted ?? [])].some((l) => l.listingId === String(id));
      return record?.labels.listings[String(held.listingId)]?.heldAt === Number(heldAt)
        && record.notCounted.listings.find((l) => l.listingId === String(apart.listingId))?.heldAt === Number(apartAt)
        && entry?.sameRepository.find((x) => x.listingId === String(held.listingId))?.heldAt === Number(heldAt)
        && !inFeed(held.listingId) && !inFeed(apart.listingId);
    }, { timeoutMs: 45_000, what: 'the site\'s answers with the hold' });
    // what the server says of it: the state is the chain's, and it is not live
    expect(record.record.listings.find((l) => l.listingId === String(held.listingId)).state).toBe('Open');
    expect(record.labels.listings[String(held.listingId)].live).toBe(false);
    expect(record.badge.message).toMatch(/^stake on hold since \d{4}-\d{2}-\d{2}$/);
    const commit = held.view.list.params.artifact.baseCommit;
    const line = fill(STRINGS.sameRepository.line, { id: held.listingId, commit, state: F.states.Open });
    const hint = fill(STRINGS.sameRepository.held, { time: at(heldAt) });

    // the record: the state as the chain has it, never drawn as taking claims; the label; and since when
    await page.goto(`/#/record/${held.artifactHash}`);
    const s = (f) => page.getByTestId(`listing-${held.listingId}-${f}`);
    await expect(s('state')).toHaveText(STRINGS.enums.listingStates.Open);
    await expect(s('state').locator('.pill-ok')).toHaveCount(0);
    const labels = (await s('labels').innerText()).split(', ');
    expect(labels).toContain(STRINGS.labels.held);
    expect((await s('labels').innerText()).includes('\n')).toBe(false);
    expect(await s('held').innerText()).toBe(at(heldAt));
    // the listing shown apart says it too
    expect(await page.getByTestId(`not-counted-${apart.listingId}-held`).innerText()).toBe(at(apartAt));
    await expect(page.getByTestId(`not-counted-${apart.listingId}-state`).locator('.pill-ok')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);

    // the feed: no entry for a listing on hold, counted or not; the open listing's entry names it among the others of
    // its repository, with the hold, on one line of the page's text
    await page.goto('/#/feed');
    await expect(page.getByTestId(`feed-${open.listingId}`)).toBeVisible();
    await expect(page.getByTestId(`feed-${held.listingId}`)).toHaveCount(0);
    await expect(page.getByTestId(`feed-apart-${apart.listingId}-artifact`)).toHaveCount(0);
    const inFeed = page.getByTestId(`feed-${open.listingId}-same-repository`).getByTestId(`same-repository-${held.listingId}`);
    expect(await inFeed.innerText()).toBe(`${line} (${hint})`);
    await expect(inFeed.getByRole('link', { name: line })).toHaveAttribute('href', `#/fund/${held.listingId}`);
    await expect(inFeed.locator('.pill')).toHaveText(F.states.Open);
    await expect(inFeed.locator('.pill-ok')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);

    // a listing's own page: the same line in its list of the repository's other listings
    await page.goto(`/#/fund/${open.listingId}`);
    const onPage = page.getByTestId('same-repository').getByTestId(`same-repository-${held.listingId}`);
    expect(await onPage.innerText()).toBe(`${line} (${hint})`);
    await expect(onPage.locator('.pill-ok')).toHaveCount(0);
    // and the open listing itself is drawn as before: it is not on hold
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('listing-summary').locator('.pill-ok')).toHaveCount(1);

    // The held listing's own page, by an address that writes its id with leading zeros (R5-F1). An id is one listing's
    // in one form: the page reads that listing, says its number as the chain has it, and never lists it among the
    // other listings of its own repository. Not the line, and not the hold that line would say.
    await page.goto(`/#/fund/00${held.listingId}`);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    const others = page.getByTestId('same-repository');
    await expect(others.getByTestId(`same-repository-${open.listingId}`)).toBeVisible();
    await expect(others.getByTestId(`same-repository-${held.listingId}`)).toHaveCount(0);
    await expect(others.locator(`a[href="#/fund/${held.listingId}"]`)).toHaveCount(0);
    expect(await others.innerText()).not.toContain(hint);
    await expect(page.getByTestId('listing-summary').getByRole('heading')).toHaveText(fill(F.summary, { id: held.listingId }));
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('on hold: the queue counts late claims with the claims from before the hold, and a claim\'s reveal text still names the roll-forward', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const before = await chain.claim({ listingId, archive: archiveBytes('pending at the hold'), recipient: key.recipient });
    await holdOnChain(chain, stack, listingId);
    // a late claim is taken on the listing on hold, behind the claim from before it, and is never one of pendingClaims
    const late = await chain.claim({ listingId, archive: archiveBytes('late, on hold'), recipient: key.recipient, late: true });
    const l = await chain.sa.getListing(listingId);
    expect(Number(l.state)).toBe(1); // Open
    expect(l.pendingClaims).toBe(1n);
    expect(l.lateClaims).toBe(1n);
    expect(l.headClaim).toBe(before.claimId);
    expect((await chain.sa.getClaim(late.claimId)).late).toBe(true);

    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-queue')).toHaveText(`${fill(STRINGS.claims.openLate, { count: 2, late: 1 })} ${fill(STRINGS.claims.order, { head: before.claimId })}`);
    // the close counts the claim that is pending, and not the late one
    await expect(page.getByTestId('close-blocked')).toHaveText(fill(STRINGS.close.pending, { count: 1 }));

    // the claim from before the hold: first, and its fix window can still end early by a release or a roll-forward
    await page.goto(`/#/claim/${before.claimId}`);
    await expect(page.getByTestId('claim-queue')).toHaveText(C.queueFirst);
    await expect(page.getByTestId('claim-reveal-before')).toHaveText(fill(C.revealLatest, { time: at((await chain.sa.claimTimes(before.claimId)).revealDeadline) }));
    await expect(page.getByTestId('claim-late')).toHaveCount(0);
    // the late claim: said to be one, and it waits for the claim from before the hold
    await page.goto(`/#/claim/${late.claimId}`);
    await expect(page.getByTestId('claim-late')).toHaveText(C.yes);
    await expect(page.getByTestId('claim-queue')).toHaveText(fill(C.queueWaits, { head: before.claimId }));
    await expect(page.getByTestId('claim-reveal-before')).toHaveText(C.revealUnset);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('on hold and depleted: a top-up puts the state back to open, and the listing takes no claims all the same', async ({ page, stack, chain }) => {
    test.setTimeout(240_000);
    // a CRITICAL award takes the whole escrow: the listing is depleted. Its maker then holds it.
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const top = (await chain.sa.getListing(listingId)).awards[3];
    const critical = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'depletes it' });
    await chain.verdict(critical.claimId, 'CRITICAL');
    await chain.judged(critical.claimId);
    await chain.settledAfter(critical.claimId);
    expect(Number((await chain.sa.getListing(listingId)).state)).toBe(2); // Depleted
    const heldAt = await holdOnChain(chain, stack, listingId);

    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Depleted);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });
    const panel = page.getByTestId('top-up');
    // what the page says of a top-up here: the state goes back to open, and the hold stays
    await expect(panel.getByTestId('top-up-depleted')).toHaveText(fill(STRINGS.topUp.depletedHeld, { eth: formatEth(top) }));
    await expect(panel.getByTestId('top-up-amount')).toHaveValue(formatEth(top));
    await expect(panel.getByTestId('top-up-effect')).toHaveText(`${fill(STRINGS.topUp.effectPlain, { after: formatEth(top) })} ${STRINGS.topUp.reopensHeld}`);
    await expect(panel).not.toContainText(STRINGS.topUp.reopens);
    await panel.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: formatEth(top) }) }).click();
    // the top-up's own line is the site's as it was, by its receipt: the escrow, and the state its Reopened event reports
    await expect(panel.getByTestId('topped-up')).toContainText(`The escrow now holds ${formatEth(top)} ETH. ${STRINGS.topUp.reopened}`, { timeout: 30_000 });

    // the chain: Open again, its escrow at the top award, its fee paid, and still no commit
    const after = await chain.sa.getListing(listingId);
    expect(Number(after.state)).toBe(1); // Open
    expect(after.escrowWei).toBe(top);
    expect(await chain.sa.isLapsed(listingId)).toBe(false);
    expect(await chain.sa.heldAt(listingId)).toBe(heldAt);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(false);
    // the page's read says the rest: open, on hold, never "open until", and no commit offered
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open, { timeout: 30_000 });
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.held, offered: false });
    await expect(page.getByTestId('listing-summary').locator('.pill-ok')).toHaveCount(0);
    expect(await page.getByTestId('listing-held').innerText()).toBe(fill(F.held, { id: listingId, time: at(heldAt) }));
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(after.fundedUntil) }))).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('a contract with no hold: no hold action, and the page says what it said', async ({ page, stack, chain }) => {
    // a repository of its own, so the maker has no other listing of it to roll to and the panel's last line is known
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: `https://github.com/acme/older-${Date.now().toString(36)}` } });
    const listing = await chain.sa.getListing(listingId);
    // this page's node refuses heldAt, as it refuses any function the contract does not have
    const refused = await answerHeldAt(page, stack);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Open);
    await connect(page, stack.accounts.maker);
    const roll = page.getByTestId('roll-forward');
    await expect(roll).toBeVisible();
    expect(refused.calls, 'the page asked the contract, and was refused').toBeGreaterThan(0);

    // no hold: no section, no action, nothing on hold
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held-since')).toHaveCount(0);
    await expect(page.getByRole('button', { name: fill(H.ask, { id: listingId }) })).toHaveCount(0);
    // the roll-forward panel, whole, character for character: its title, its intro, P38's three lines, and no successor
    await expect(roll).toContainText(RF.none);
    expect(await lines(roll)).toEqual([RF.title, RF.intro, RF.fix.keep, RF.fix.noClaim, RF.fix.claimPending, RF.none]);
    await expect(roll.getByTestId('roll-hold-first')).toHaveCount(0);
    await expect(roll.getByTestId('roll-hold-order')).toHaveCount(0);
    // and the rest of the page as it was: open until, the commit offer, the renewal, the close
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(listing.fundedUntil) }))).toBeVisible();
    await expect(page.getByTestId('listing-summary').locator('.pill-ok')).toHaveCount(1);
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true });
    await expect(page.getByTestId('renew').getByTestId('renew-period')).toHaveText(fill(STRINGS.renew.until, { time: at(listing.fundedUntil) }));
    await expect(page.getByTestId('renew').getByTestId('renew-held')).toHaveCount(0);
    await expect(page.getByTestId('close').getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) })).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\bon hold\b/i);
    expect(text).not.toMatch(/\bhold\b/i);
    expect(wordingProblems(text)).toEqual([]);
    expect(await chain.sa.heldAt(listingId)).toBe(0n);

    // node P47: such a contract has acceptsCommits, and the page follows it there too. Closed from elsewhere and read
    // again, the listing takes no commits, and the page says so, with no word of a hold
    await (await (await chain.as(stack.accounts.maker)).close(listingId)).wait();
    await page.reload();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed);
    await expectCommitOffer(page, chain, listingId, { takes: false, text: O.notTaking, offered: false });
    await expect(page.getByTestId('hold')).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toMatch(/\bhold\b/i);
  });

  test('a contract with no hold, and a reader behind the wallet: nothing is taken off the page, which says the block it has not read', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('older-behind') } });
    const listing = await chain.sa.getListing(listingId);
    // this page's node refuses heldAt, for the reader and for the wallet; and from the top-up on its reader trails
    const reader = { frozen: null };
    await interceptRpc(page, stack, (p) => {
      if (isHeldAtCall(p)) return { error: REFUSED_CALL };
      return reader.frozen && p.method === 'eth_getBlockByNumber' && p.params?.[0] === 'latest' ? { result: reader.frozen } : undefined;
    }, { from: 'reader' });
    await interceptRpc(page, stack, (p) => (isHeldAtCall(p) ? { error: REFUSED_CALL } : undefined), { from: 'wallet' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    reader.frozen = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(topUp.getByTestId('topped-up')).toBeVisible({ timeout: 30_000 });
    const [funded] = (await chain.sa.queryFilter(chain.sa.filters.Funded(listingId))).slice(-1);
    // the page says which block it has not read; the listing it shows is the one it read, whole, as the site has
    // always shown it after an action: its state, "open until", the offer, the actions
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: funded.blockNumber }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(listing.fundedUntil) }))).toBeVisible();
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true });
    await expect(page.getByTestId('renew').getByTestId('renew-period')).toBeVisible();
    await expect(page.getByTestId('roll-forward').getByTestId('roll-fix-keep')).toHaveText(RF.fix.keep);
    await expect(page.getByTestId('close').getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) })).toBeVisible();
    expect(await page.locator('main').innerText()).not.toMatch(/\bhold\b/i);
    // the reader catches up: read again, the notice goes and the escrow is the chain's
    reader.frozen = null;
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(topUp.getByTestId('top-up-escrow')).toContainText(formatEth(funded.args.escrowWei));
    expect(await page.locator('main').innerText()).not.toMatch(/\bhold\b/i);
  });

  test('a contract with no hold, through a provider that leaves the revert\'s data out: the contract\'s own reason under code 3 is "no hold" all the same (R2-F1)', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, spec: { repo: ownRepo('older-no-data') } });
    const listing = await chain.sa.getListing(listingId);
    // the measured answer of the deployed contract, with only its data left out
    const refused = await answerHeldAt(page, stack, { code: 3, message: 'execution reverted: unknown function' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    // the page reads: the listing as it is, with no hold section and the roll-forward panel as it was before the hold
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    expect(refused.calls, 'the page asked the contract, and was refused').toBeGreaterThan(0);
    const roll = page.getByTestId('roll-forward');
    await expect(roll.getByTestId('roll-fix-keep')).toHaveText(RF.fix.keep);
    await expect(roll.getByTestId('roll-hold-first')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(listing.fundedUntil) }))).toBeVisible();
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true });
    expect(await page.locator('main').innerText()).not.toMatch(/\bhold\b/i);
  });

  // "This contract has no hold" is said only from the contract's own refusal: the revert's data, or its one reason
  // under code 3. Any other failure of that call is a failed read: the node's own (a rate limit), and an error that
  // says "revert" in its words and hands over no revert data, as a wallet does when it passes on a library's wording
  // over a block its node did not have (R1-F9).
  for (const [what, error] of [
    ['the node\'s own failure', { code: -32005, message: 'rate limit exceeded' }],
    ['"missing revert data" over a block the node does not have', { code: -32603, message: 'missing revert data', data: { code: -32000, message: 'header not found' } }],
    ['the contract\'s reason under another code', { code: -32000, message: 'execution reverted: unknown function' }],
  ]) test(`a read of the hold that fails another way is a failed read of the page, never "not on hold": ${what}`, async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const heldAt = await holdOnChain(chain, stack, listingId);
    const failed = await answerHeldAt(page, stack, error);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByText(F.readFailed.replace('{reason}', ''), { exact: false })).toBeVisible();
    expect(failed.calls).toBeGreaterThan(0);
    // nothing of the listing is drawn from half a read: not its state, not an action, not "open until", and least of
    // all a listing on hold shown as one that takes claims
    for (const id of ['listing-summary', 'listing-open-until', 'commit-offer', 'roll-forward', 'hold']) await expect(page.getByTestId(id)).toHaveCount(0);
    // once the node answers, reading again shows the listing as it is: on hold
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: F.retry }).click();
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
  });

  // Node P47: the page reads the contract's acceptsCommits with the listing, and no failure of that call says anything
  // of the listing. The contract's own refusal (which, of heldAt, means "no hold here") and a node's failure are each a
  // failed read of the page: the view is on every contract the site is used against, and nothing stands in for it.
  for (const [what, error] of [
    ['the contract refuses the call', REFUSED_CALL],
    ['the node\'s own failure', { code: -32005, message: 'rate limit exceeded' }],
  ]) test(`a read of acceptsCommits that fails is a failed read of the page, and nothing is offered: ${what}`, async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const failed = { calls: 0 };
    await interceptRpc(page, stack, (p) => {
      if (!isAcceptsCommitsCall(p)) return undefined;
      failed.calls += 1;
      return { error };
    });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByText(F.readFailed.replace('{reason}', ''), { exact: false })).toBeVisible();
    expect(failed.calls).toBeGreaterThan(0);
    // nothing of the listing is drawn from half a read, and least of all that the site offers it
    for (const id of ['listing-summary', 'listing-open-until', 'commit-offer', 'roll-forward', 'hold']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(await page.locator('[data-offered="true"]').count()).toBe(0);
    expect(await page.locator('main').innerText()).not.toMatch(/offers it to hunters/i);
    // once the call answers, reading again shows the listing as it is: open, and taking commits
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: F.retry }).click();
    await expectCommitOffer(page, chain, listingId, { takes: true, text: O.yes, offered: true });
  });
});
