// Node P42: the maker's hold on a listing's own page (StakeAttestation.hold, node P39), through the wallet. A hold
// stops new commits at once, before the fix the listing rolls forward to is public; it leaves every pending claim
// alone; and it has no resume. The page offers it to the listing's maker and to no other wallet, next to roll forward,
// with that warning; asks for confirmation; reports the transaction; and from then on says the listing is on hold,
// with the time, in every sentence it has about taking claims, while roll forward and close stay offered. The lists
// (the record, the other listings of a repository on a listing's page and in a feed entry) say it from the API. Against
// a contract deployed before the hold, whose heldAt call the node refuses, there is no hold action and the page says
// what it said. Each step is checked against the chain.
import { formatEth } from '../src/lib/format.js';
import { STRINGS, fill } from '../src/strings.js';
import { AFTER_TX_READS } from '../src/lib/poll.js';
import { answerHeldAt, archiveBytes, disclosure, expect, installWallet, interceptRpc, isCallOf, isHeldAtCall, shot, test } from './support/fixtures.js';
import { field } from './support/listingForm.js';
import { wordingProblems } from './support/wording.js';

const H = STRINGS.hold;
const F = STRINGS.fund;
const RF = STRINGS.roll;
const C = STRINGS.claim;
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
/**
 * From now on the site's reader answers getListing(id) with the listing as the chain has it at this moment, whatever
 * is mined after: a chain on which a later transaction of the page is not there (its block was replaced). The test
 * can put another answer in `reader.result` later, for what that chain does next.
 * @returns {Promise<{ result: string }>}
 */
async function readerKeepsListing(page, stack, chain, listingId) {
  const now = await listingCall(chain, listingId);
  const reader = { result: now.result };
  await interceptRpc(page, stack, (p) => (isCallWith(now.data)(p) ? { result: reader.result } : undefined), { from: 'reader' });
  return reader;
}
/** A getListing answer with some of its fields changed, by name. */
function changedListing(chain, result, change) {
  const fields = chain.sa.interface.getFunction('getListing').outputs[0].components.map((c) => c.name);
  const values = chain.sa.interface.decodeFunctionResult('getListing', result)[0].toArray(true);
  for (const [name, value] of Object.entries(change)) {
    expect(fields.includes(name), `the listing has a field ${name}`).toBe(true);
    values[fields.indexOf(name)] = value;
  }
  return chain.sa.interface.encodeFunctionResult('getListing', [values]);
}
const CLOSED = 4n;
const renewButton = (page, stack) => page.getByTestId('renew').getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) });
const api = async (stack, path) => {
  const res = await fetch(`${stack.apiUrl}${path}`);
  return res.ok ? res.json() : null;
};

test.describe('the maker\'s hold', () => {
  let key;
  test.beforeEach(() => {
    key = disclosure.generateDisclosureKeyPair();
  });

  test('offered to the maker only, with the warning; two steps, then the transaction; and the page says on hold from then on', async ({ page, stack, chain }) => {
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

    // the maker: confirmed, sent, and reported with its transaction and the hold's time
    await useAccount(page, stack.accounts.maker);
    await connect(page, stack.accounts.maker);
    await ask.click();
    await confirm.click();
    const done = section.getByTestId('held');
    await expect(done).toBeVisible({ timeout: 30_000 });
    const heldAt = await chain.sa.heldAt(listingId);
    expect(heldAt > 0n).toBe(true);
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    expect(event.args.heldAt).toBe(heldAt);
    expect(await done.innerText()).toBe(fill(H.done, { id: listingId, time: at(heldAt), tx: event.transactionHash }));
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

    // the page, without a reload: on hold, with the time, under the state, which stays the chain's
    const summary = page.getByTestId('listing-summary');
    await expect(summary.getByTestId('listing-held-since')).toHaveText(at(heldAt));
    await expect(summary).toContainText(F.states.Open);
    await expect(summary.locator('.pill-ok')).toHaveCount(0);
    expect(await page.getByTestId('listing-held').innerText()).toBe(fill(F.held, { id: listingId, time: at(heldAt) }));
    await expect(page.getByText(fill(F.alreadyOpen, { id: listingId, until: at(held.fundedUntil) }))).toHaveCount(0);
    // the hold is taken: no action is left, and the section says since when
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(section.getByTestId('hold-warning')).toHaveCount(0);
    // every sentence about taking claims: the commit offer, the renewal, the order that is left
    await expect(page.getByTestId('commit-offer')).toContainText(STRINGS.offer.held);
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
    await renew.getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) }).click();
    await expect(renew.getByTestId('renewed')).toBeVisible({ timeout: 30_000 });
    expect((await chain.sa.getListing(listingId)).fundedUntil > held.fundedUntil).toBe(true);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(false);
    expect(await chain.sa.heldAt(listingId)).toBe(heldAt);
    await expect(page.getByTestId('listing-held')).toBeVisible();
    await expect(renew.getByTestId('renew-held')).toHaveText(STRINGS.renew.held);

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
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Rolled);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held-since')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    // the hold's end does not turn the offer back on: a rolled listing takes no commit, and the page says so
    await expect(page.getByTestId('commit-offer')).toContainText(STRINGS.offer.notTaking);
    await expect(page.getByTestId('commit-offer')).toHaveAttribute('data-offered', 'false');
    await expect(page.getByTestId('commit-offer')).not.toContainText(STRINGS.offer.yes);
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
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
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Closed);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await expect(page.getByTestId('commit-offer')).toContainText(STRINGS.offer.notTaking);
    await expect(page.getByTestId('commit-offer')).toHaveAttribute('data-offered', 'false');
  });

  test('a reader behind the wallet: the hold stands by its receipt, the page says what it has not read, and reading again settles it', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    await expect(section.getByRole('button', { name: fill(H.ask, { id: listingId }) })).toBeVisible();
    // from here the site's reader answers for this block, while the wallet's node goes on
    const letGo = await freezeReader(page, stack, chain);
    await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    await expect(section.getByTestId('held')).toBeVisible({ timeout: 30_000 });
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    // every read the page has is from before the hold: it does not go back to offering it, and says the hold by its receipt
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt));
    await expect(section.getByRole('button')).toHaveCount(0);
    // after its reads it says which block it has not reached, and offers to read again
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: event.blockNumber }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt));
    // the reader catches up: the chain's own answer, and the notice goes
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt));
    await expect(section.getByTestId('held')).toBeVisible();
  });

  test('a reader behind the wallet after a roll forward: the page says what it has not read, and stops saying on hold once it has', async ({ page, stack, chain }) => {
    const first = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, first.listingId);
    const successor = await chain.openListing({ recipient: key.recipient });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    const seen = { reads: 0, of: isCallWith((await listingCall(chain, first.listingId)).data) };
    const letGo = await freezeReader(page, stack, chain, seen);
    await page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) }).click();
    await expect(page.getByTestId('rolled')).toBeVisible({ timeout: 30_000 });
    expect(Number((await chain.sa.getListing(first.listingId)).state)).toBe(3); // Rolled
    // the page's reads are from before the roll: it says so, by the block, beside what it still shows
    const [event] = await chain.sa.queryFilter(chain.sa.filters.RolledForward(first.listingId));
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: event.blockNumber }), { timeout: 30_000 });
    await expect(page.getByTestId('listing-held')).toBeVisible();
    // Another action on the panels it still shows, before the reader has caught up: a renewal, which the wallet's own
    // read refuses (the listing rolled forward) and which sends nothing. The read it asks for is no reason to take one
    // from before the roll: the page goes on waiting for the roll's block, and goes on saying so.
    const renew = page.getByTestId('renew');
    const readsBefore = seen.reads;
    const chainBefore = Number(await chain.provider.send('eth_blockNumber', []));
    await renew.getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) }).click();
    await expect(renew.getByRole('alert')).toHaveText(fill(STRINGS.renew.changed, { id: first.listingId, state: F.states.Rolled }), { timeout: 30_000 });
    expect(Number(await chain.provider.send('eth_blockNumber', []))).toBe(chainBefore); // nothing was sent
    // every read that refresh makes is still from before the roll; once it has made them all the notice is there,
    // for the newest block the page was told of, with the way to read again
    await expect.poll(() => seen.reads - readsBefore, { timeout: 30_000 }).toBeGreaterThanOrEqual(AFTER_TX_READS);
    await expect(page.getByTestId('listing-behind')).toHaveText(fill(F.behind, { block: chainBefore }));
    expect(chainBefore >= event.blockNumber).toBe(true);
    await expect(page.getByTestId('listing-held')).toBeVisible();
    await expect(page.getByTestId('listing-read-again')).toBeVisible();
    // once it reads that block: rolled forward, and not on hold
    await letGo();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Rolled);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    await expect(page.getByTestId('rolled')).toBeVisible();
  });

  test('a hold that is no longer on the chain when the page reads again: said plainly, never drawn as a hold, and offered again', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: listingId }) });
    await ask.click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    const done = section.getByTestId('held');
    await expect(done).toBeVisible({ timeout: 30_000 });
    const tx = /0x[0-9a-f]{64}/.exec(await done.innerText())[0];
    await expect(page.getByTestId('listing-held')).toBeVisible();
    // the chain as the site's reader then has it holds no hold of this listing (its block was dropped): the view answers 0
    await interceptRpc(page, stack, (p) => (isHeldAtCall(p) ? { result: `0x${'0'.repeat(64)}` } : undefined), { from: 'reader' });
    // the page reads the listing again after its next transaction, a top-up
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(topUp.getByTestId('topped-up')).toBeVisible({ timeout: 30_000 });
    // it stops saying on hold, everywhere it said it, and says in an alert that the hold it saw mined is not there
    await expect(section.getByTestId('hold-dropped')).toHaveText(fill(H.dropped, { tx }));
    await expect(section.getByTestId('held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held-since')).toHaveCount(0);
    await expect(page.getByTestId('commit-offer')).not.toContainText(STRINGS.offer.held);
    expect(await page.getByTestId('roll-forward').getByTestId('roll-hold-first').innerText()).toBe(RF.hold.first);
    // and the hold is offered again, with its warning
    await expect(section.getByTestId('hold-warning')).toBeVisible();
    await expect(ask).toBeVisible();
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
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

  test('a listing opened from its own page offers the hold without a reload', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false });
    expect(Number((await chain.sa.getListing(listingId)).state)).toBe(0); // Listed
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Listed);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await page.getByRole('button', { name: STRINGS.chain.fund }).click();
    await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
    // the page follows the listing from the block it opened in: the hold is there, for the wallet that funded it
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: listingId }) });
    await expect(ask).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('roll-forward')).toBeVisible();
    // The opening's own line stays, with its transaction, and says what this page did. That the listing is open, and
    // until when, is the page's line of the listing as last read: one line, and the only one that says it.
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    const openedLine = fill(STRINGS.chain.openedHere, { id: listingId, tx: funded.transactionHash });
    await expect(page.getByTestId('opened')).toHaveText(openedLine);
    const opened = await chain.sa.getListing(listingId);
    await expect(page.getByTestId('listing-open-until')).toHaveText(fill(F.alreadyOpen, { id: listingId, until: at(opened.fundedUntil) }));
    await expect(page.getByText(/is open until /)).toHaveCount(1);
    await ask.click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    await expect(section.getByTestId('held')).toBeVisible({ timeout: 30_000 });
    expect(await chain.sa.heldAt(listingId) > 0n).toBe(true);
    // on hold: the opening's transaction is still on the page, and nothing on it says the listing is open until a time
    await expect(page.getByTestId('opened')).toHaveText(openedLine);
    await expect(page.getByTestId('listing-held')).toBeVisible();
    await expect(page.getByText(/is open until /)).toHaveCount(0);
    await expect(page.getByTestId('listing-open-until')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('a listing that is gone when the page reads again: said as gone, with no hold and no order left on the page', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    await expect(section.getByTestId('held')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-held')).toBeVisible();
    // the chain as the site's reader then has it ends before this listing (the block it was created in was dropped,
    // and its hold with it): the contract counts one listing fewer
    await interceptRpc(page, stack, (p) => (isCallOf('listingCount()')(p) ? { result: word(BigInt(listingId) - 1n) } : undefined), { from: 'reader' });
    // the page reads the listing again after its next transaction, a top-up
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    // no listing, said as one that was here; and nothing of the hold or of what to do after it
    await expect(page.getByTestId('listing-gone')).toHaveText(fill(F.gone, { id: listingId }), { timeout: 30_000 });
    await expect(page.getByText(fill(F.notFound, { id: listingId }))).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'listing-held-since', 'hold', 'roll-forward', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('on hold since');
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('the page\'s reader and the wallet\'s node have both lost the listing: an action sends nothing, and the page says the listing is gone', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-held')).toBeVisible();
    // on hold, the page tells the maker what is left: push the fix
    await expect(page.getByTestId('roll-forward').getByTestId('roll-hold-first')).toContainText('push the fix');
    // both nodes' chain ends before this listing: the contract counts one listing fewer, for the reader and for the wallet
    await interceptRpc(page, stack, (p) => (isCallOf('listingCount()')(p) ? { result: word(BigInt(listingId) - 1n) } : undefined));
    const chainBefore = Number(await chain.provider.send('eth_blockNumber', []));
    // an action of the page: the wallet's own read finds no such listing, nothing is sent, and the page reads again
    await page.getByTestId('renew').getByRole('button', { name: fill(STRINGS.renew.button, { fee: formatEth(BigInt(stack.listingFeeWei)) }) }).click();
    await expect(page.getByTestId('listing-gone')).toHaveText(fill(F.gone, { id: listingId }), { timeout: 30_000 });
    expect(Number(await chain.provider.send('eth_blockNumber', []))).toBe(chainBefore);
    // nothing of the hold, and nothing that tells the maker to publish
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward', 'renew']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    await expect(page.locator('main')).not.toContainText('on hold since');
  });

  test('the wallet\'s node has another of the maker\'s listings under the id: the hold is not sent, for either', async ({ page, stack, chain }) => {
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
    await expect(section.getByRole('alert')).toHaveText(fill(F.replaced, { id: shown.listingId }), { timeout: 30_000 });
    // nothing was sent: neither listing is on hold, and the confirmation is taken back
    expect(await chain.sa.heldAt(shown.listingId)).toBe(0n);
    expect(await chain.sa.heldAt(other.listingId)).toBe(0n);
    await expect(ask).toBeVisible();
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(section.getByTestId('held')).toHaveCount(0);
  });

  test('an opening that is not on the chain when the page reads again: the listing reads listed, and the funding form is back', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    // the chain as the site's reader has it from here keeps the listing listed and not funded, at every later block
    const reader = await readerKeepsListing(page, stack, chain, listingId);
    await page.getByRole('button', { name: STRINGS.chain.fund }).click();
    const dropped = page.getByTestId('opening-dropped');
    await expect(dropped).toBeVisible({ timeout: 30_000 });
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    await expect(dropped).toHaveText(fill(STRINGS.chain.openingDropped, { id: listingId, tx: funded.transactionHash }));
    // the state is the read's, no line says the listing is open, and it can be funded from here
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    await expect(page.getByTestId('opened')).toHaveCount(0);
    await expect(page.getByTestId('listing-open-until')).toHaveCount(0);
    await expect(page.getByText(/is open/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toBeVisible();
    await expect(page.getByTestId('hold')).toHaveCount(0);
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
    // On that chain the maker then closes the listing, which never opened. The page reads closed (here after a close
    // from this page that the wallet's own read refuses), and nothing on it says this page opened the listing.
    reader.result = changedListing(chain, reader.result, { state: CLOSED });
    const close = page.getByTestId('close');
    await close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) }).click();
    await close.getByRole('button', { name: new RegExp(`^Close listing ${listingId} and take back `) }).click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    await expect(page.getByTestId('opened')).toHaveCount(0);
    await expect(page.getByTestId('opening-dropped')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(funded.transactionHash);
    await expect(page.locator('main')).not.toContainText('This page opened');
    await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
  });

  test('a roll forward that is not on the chain when the page reads again: said plainly, and the panel is offered again', async ({ page, stack, chain }) => {
    const first = await chain.openListing({ recipient: key.recipient });
    const successor = await chain.openListing({ recipient: key.recipient });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const pick = field(page, RF.pick);
    await expect(pick).toBeVisible();
    await pick.selectOption(String(successor.listingId));
    const reader = await readerKeepsListing(page, stack, chain, first.listingId);
    const button = page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await button.click();
    const panel = page.getByTestId('roll-forward');
    const dropped = panel.getByTestId('roll-dropped');
    await expect(dropped).toBeVisible({ timeout: 30_000 });
    const [event] = await chain.sa.queryFilter(chain.sa.filters.RolledForward(first.listingId));
    await expect(dropped).toHaveText(fill(RF.dropped, { tx: event.transactionHash }));
    // no line of a roll, the state the read's, and the panel with its lines and its action
    await expect(page.getByTestId('rolled')).toHaveCount(0);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    expect(await panel.getByTestId('roll-hold-first').innerText()).toBe(RF.hold.first);
    await expect(button).toBeVisible();
    // On that chain the listing is then closed, with no successor. The page reads closed (here after a renewal the
    // wallet's own read refuses): it is not a roll, and the dropped roll's line does not come back for it.
    reader.result = changedListing(chain, reader.result, { state: CLOSED, escrowWei: 0n });
    await renewButton(page, stack).click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    await expect(page.getByTestId('rolled')).toHaveCount(0);
    await expect(page.getByTestId('roll-forward')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(event.transactionHash);
    await expect(page.locator('main')).not.toContainText('Rolled forward to listing');
  });

  test('a close that is not on the chain when the page reads again: said plainly, and the close is offered again from its first step', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const escrow = formatEth((await chain.sa.getListing(listingId)).escrowWei);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    const close = page.getByTestId('close');
    const ask = close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) });
    await expect(ask).toBeVisible();
    const reader = await readerKeepsListing(page, stack, chain, listingId);
    await ask.click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: escrow }) }).click();
    const dropped = close.getByTestId('close-dropped');
    await expect(dropped).toBeVisible({ timeout: 30_000 });
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Closed(listingId));
    await expect(dropped).toHaveText(fill(STRINGS.close.dropped, { id: listingId, tx: event.transactionHash }));
    await expect(close.getByTestId('closed')).toHaveCount(0);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    await expect(ask).toBeVisible();
    // On that chain the listing is closed later by another transaction, after its escrow changed. The page reads closed
    // (here after a renewal the wallet's own read refuses) and says nothing of what the dropped close reported: not
    // its hash, not the amount it said came back.
    reader.result = changedListing(chain, reader.result, { state: CLOSED, escrowWei: 0n });
    await renewButton(page, stack).click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    await expect(page.getByTestId('closed')).toHaveCount(0);
    await expect(page.getByTestId('close')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(event.transactionHash);
    await expect(page.locator('main')).not.toContainText('of escrow went back');
  });

  test('the feed describes one version under a successor\'s id and the chain has another: it is not offered', async ({ page, stack, chain }) => {
    const repo = `https://github.com/acme/moved-${Date.now().toString(36)}`;
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const other = await chain.openListing({ recipient: key.recipient });
    expect(other.artifactHash).not.toBe(successor.artifactHash);
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the fixed version in the feed' });
    // Before the picker first loads: the chain as the site's reader has it holds another of the maker's open listings
    // under the successor's id (open, the maker's, no predecessor: one the contract would take), while the feed still
    // describes the fixed version there.
    const theirs = await listingCall(chain, other.listingId);
    const fixed = await listingCall(chain, successor.listingId);
    await installWallet(page, stack);
    await interceptRpc(page, stack, (p) => (isCallWith(fixed.data)(p) ? { result: theirs.result } : undefined), { from: 'reader' });
    await page.goto(`/#/fund/${first.listingId}`);
    const roll = page.getByTestId('roll-forward');
    // the option would show the fixed version's commit and be sent for the other listing: there is none
    await expect(roll).toContainText(RF.none);
    await expect(roll.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) })).toHaveCount(0);
  });

  test('another listing under the page\'s id: while its record is read, nothing found for the first listing can be sent', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const repo = `https://github.com/acme/first-${Date.now().toString(36)}`;
    const first = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const successor = await chain.openListing({ recipient: key.recipient, spec: { repo } });
    const other = await chain.openListing({ recipient: key.recipient, spec: { repo: `https://github.com/acme/second-${Date.now().toString(36)}` } });
    await chain.until(async () => ((await api(stack, '/api/feed'))?.listings ?? []).some((l) => l.listingId === String(successor.listingId)), { what: 'the successor in the feed' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const roll = page.getByTestId('roll-forward');
    const button = page.getByRole('button', { name: fill(RF.button, { id: successor.listingId }) });
    await expect(button).toBeVisible();
    // From here the chain as the site's reader has it holds another of the maker's listings under this id, of another
    // repository, and the site's record of that one is slow to answer.
    const mine = await listingCall(chain, first.listingId);
    const theirs = await listingCall(chain, other.listingId);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let asked = 0;
    await page.route((url) => url.pathname === `/api/records/${other.artifactHash.toLowerCase()}`, async (route) => {
      asked += 1;
      await held;
      await route.continue();
    });
    await interceptRpc(page, stack, (p) => (isCallWith(mine.data)(p) ? { result: theirs.result } : undefined), { from: 'reader' });
    // the page reads the listing again after its next transaction, a renewal
    await renewButton(page, stack).click();
    // it now shows the other listing, and is reading that listing's record
    const shown = await chain.sa.getListing(other.listingId);
    await expect(page.getByTestId('listing-summary')).toContainText(shown.listingCid, { timeout: 30_000 });
    await expect.poll(() => asked).toBe(1);
    // nothing kept from the first listing: no successor of its repository to send, and no line of its renewal
    await expect(roll).toContainText(RF.loading);
    await expect(button).toHaveCount(0);
    await expect(roll.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByTestId('renewed')).toHaveCount(0);
    release();
    // and none once the record is there: it is the other listing's
    await expect(roll).not.toContainText(RF.loading);
    await expect(button).toHaveCount(0);
    expect((await chain.sa.getListing(first.listingId)).successor).toBe(0n);
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
    for (const id of ['listing-held', 'listing-held-since', 'hold', 'roll-forward', 'rolled']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('push the fix');
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(0n);
    expect((await chain.sa.getListing(first.listingId)).successor).toBe(0n);
  });

  test('a renewal that is mined is said as mined, whatever read fails after it: no second payment is invited', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    const renew = page.getByTestId('renew');
    await expect(renewButton(page, stack)).toBeEnabled();
    // every read through the wallet fails once the renewal is sent
    await page.evaluate(() => window.__testWallet.failCallsAfterNextSend(8));
    await renewButton(page, stack).click();
    const renewed = renew.getByTestId('renewed');
    await expect(renewed).toBeVisible({ timeout: 30_000 });
    const events = await chain.sa.queryFilter(chain.sa.filters.Renewed(listingId));
    expect(events.length).toBe(1);
    // the line is the receipt's: its transaction, and the end of the period its Renewed event carries
    await expect(renewed).toHaveText(fill(STRINGS.renew.done, { tx: events[0].transactionHash, until: at(events[0].args.fundedUntil) }));
    await expect(renew.getByRole('alert')).toHaveCount(0);
    await expect(renew.getByTestId('renew-period')).toHaveText(fill(STRINGS.renew.until, { time: at(events[0].args.fundedUntil) }), { timeout: 20_000 });
  });

  test('a close whose block is not the chain\'s when the page catches up, on a chain where the listing is closed all the same: nothing of that receipt is said', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const escrow = formatEth((await chain.sa.getListing(listingId)).escrowWei);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    const close = page.getByTestId('close');
    const ask = close.getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) });
    await expect(ask).toBeVisible();
    // From here the chain as the site's reader has it is another one: every block mined from now on has another hash
    // there. The wallet's node reports the close in its own block; on the reader's chain the listing is closed too
    // (by that call mined again, or by another close), in a block that is not the receipt's.
    const head = Number(await chain.provider.send('eth_blockNumber', []));
    const theirs = new Map(); // that chain's hash of a block -> the hash the test's node has for it
    await interceptRpc(page, stack, async (p) => {
      if (p.method === 'eth_getBlockByNumber') {
        const block = await ofNode(stack, p);
        if (!block || Number(block.number) <= head) return { result: block };
        theirs.set(otherHash(block.hash), block.hash);
        return { result: { ...block, hash: otherHash(block.hash) } };
      }
      // a call at one of that chain's blocks is answered with what the test's node has at that height
      const at = p.method === 'eth_call' ? p.params?.[1]?.blockHash : undefined;
      if (at && theirs.has(at)) return { result: await ofNode(stack, { method: 'eth_call', params: [p.params[0], { blockHash: theirs.get(at) }] }) };
      return undefined;
    }, { from: 'reader' });
    await ask.click();
    await close.getByRole('button', { name: fill(STRINGS.close.confirm, { id: listingId, eth: escrow }) }).click();
    // the first read that has caught up already says closed: the state is said, and nothing the receipt reported
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Closed, { timeout: 30_000 });
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Closed(listingId));
    await expect(page.getByTestId('closed')).toHaveCount(0);
    await expect(page.getByTestId('close')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(event.transactionHash);
    await expect(page.locator('main')).not.toContainText('of escrow went back');
    await expect(page.getByTestId('listing-behind')).toHaveCount(0);
  });

  test('a block replaced under the page\'s read: the listing of one chain is never shown with the hold of the other', async ({ page, stack, chain }) => {
    const held = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, held.listingId);
    // what the replacing chain has under that id: another of the maker's listings, open and not on hold
    const other = await chain.openListing({ recipient: key.recipient });
    const mine = await listingCall(chain, held.listingId);
    const theirs = await listingCall(chain, other.listingId);
    const takes = chain.sa.interface.encodeFunctionData('acceptsCommits', [held.listingId]);
    let moved = false;
    await installWallet(page, stack);
    await interceptRpc(page, stack, async (p) => {
      // the listing under the id is the replacing chain's from the first call
      if (isCallWith(mine.data)(p)) return { result: theirs.result };
      // its hold and whether it takes commits are still the old block's on the first try (on hold, taking none), and
      // the replacing chain's from then on
      if (isHeldAtCall(p) || isCallWith(takes)(p)) return moved ? { result: word(isHeldAtCall(p) ? 0 : 1) } : undefined;
      // the block at that height has another hash when the page asks again after the first try's calls
      if (p.method === 'eth_getBlockByNumber' && p.params?.[0] !== 'latest' && !moved) {
        moved = true;
        const block = await ofNode(stack, p);
        return { result: { ...block, hash: otherHash(block.hash) } };
      }
      return undefined;
    }, { from: 'reader' });
    await page.goto(`/#/fund/${held.listingId}`);
    // the page shows one block's answers: the replacing chain's listing, open, and nothing of the old block's hold
    const shown = await chain.sa.getListing(other.listingId);
    await expect(page.getByTestId('listing-summary')).toContainText(shown.listingCid);
    expect(moved).toBe(true);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    for (const id of ['listing-held', 'listing-held-since']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId('listing-open-until')).toBeVisible();
    // (the site's list of the repository's other listings still names the held one, truly: it is another listing)
    await expect(page.getByTestId('hold').getByTestId('hold-since')).toHaveCount(0);
    await expect(page.getByTestId('hold').getByTestId('hold-warning')).toBeVisible();
    await expect(page.getByTestId('commit-offer')).not.toContainText(STRINGS.offer.held);
    expect(await page.getByTestId('roll-forward').getByTestId('roll-hold-first').innerText()).toBe(RF.hold.first);
  });

  test('one block that says both "on hold" and "takes commits" is a failed read of the page, never guidance', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    expect(await chain.sa.acceptsCommits(listingId)).toBe(true);
    await installWallet(page, stack);
    // the node answers the hold's view with a time for a listing it says takes commits, at one block
    const stop = await interceptRpc(page, stack, (p) => (isHeldAtCall(p) ? { result: word(1_800_000_000) } : undefined), { from: 'reader' });
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByText(fill(F.readFailed, { reason: F.contradictory }))).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('on hold since');
    await expect(page.locator('main')).not.toContainText('push the fix');
    // read again, once the node answers of one block
    await stop();
    await page.getByRole('button', { name: F.retry }).click();
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Open);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
  });

  test('the same contradiction after a hold sent from the page: the hold\'s receipt is no reason to go on saying "push the fix"', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: listingId }) });
    await expect(ask).toBeVisible();
    // from here the site's reader says of every block that this listing takes commits, also of the ones in which it
    // is on hold: at the block of the hold it answers both, which the contract never does
    const takes = chain.sa.interface.encodeFunctionData('acceptsCommits', [listingId]);
    const stop = await interceptRpc(page, stack, (p) => (isCallWith(takes)(p) ? { result: word(1) } : undefined), { from: 'reader' });
    await ask.click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    // The hold is mined (the wallet's node has it), and the page's read of its block cannot be taken. The page says
    // that read failed, and shows nothing of the listing: not the hold by its receipt, not the order that is left.
    await expect(page.getByTestId('listing-unread')).toHaveText(fill(F.readFailed, { reason: F.contradictory }), { timeout: 30_000 });
    expect(await chain.sa.heldAt(listingId) > 0n).toBe(true);
    for (const id of ['listing-summary', 'hold', 'roll-forward', 'close']) await expect(page.getByTestId(id)).toBeHidden();
    // the page's text is the failed read and the way to read again, and nothing a maker could act on
    for (const words of ['push the fix', 'on hold since', 'takes no new']) expect(await page.locator('main').innerText()).not.toContain(words);
    // Reading again, once the node answers of one block: the hold, from the chain, at or after its own block. The
    // page kept the hold's receipt through the failed read: it is that hold's, and is said with its transaction.
    await stop();
    await page.getByTestId('listing-read-again').click();
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt), { timeout: 20_000 });
    await expect(page.getByTestId('listing-unread')).toHaveCount(0);
    await expect(page.getByTestId('hold').getByTestId('held')).toHaveText(fill(H.done, { id: listingId, time: at(event.args.heldAt), tx: event.transactionHash }));
  });

  test('after that failed read, a chain on which the listing is not on hold: the hold this page sent is said as not there, with its transaction', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    const ask = section.getByRole('button', { name: fill(H.ask, { id: listingId }) });
    await expect(ask).toBeVisible();
    // the reader says of every block that the listing takes commits; whether it says "on hold" too is the test's to change
    const takes = chain.sa.interface.encodeFunctionData('acceptsCommits', [listingId]);
    let onHold = true;
    await interceptRpc(page, stack, (p) => {
      if (isCallWith(takes)(p)) return { result: word(1) };
      if (isHeldAtCall(p) && !onHold) return { result: word(0) };
      return undefined;
    }, { from: 'reader' });
    await ask.click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    await expect(page.getByTestId('listing-unread')).toHaveText(fill(F.readFailed, { reason: F.contradictory }), { timeout: 30_000 });
    await expect(section).toBeHidden();
    // the chain as the reader then has it: no hold of this listing, and it takes commits
    onHold = false;
    await page.getByTestId('listing-read-again').click();
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    await expect(section.getByTestId('hold-dropped')).toHaveText(fill(H.dropped, { tx: event.transactionHash }), { timeout: 20_000 });
    await expect(page.getByTestId('listing-unread')).toHaveCount(0);
    await expect(page.getByTestId('listing-held')).toHaveCount(0);
    await expect(section.getByTestId('held')).toHaveCount(0);
    await expect(ask).toBeVisible();
  });

  test('a read that could not check the opening\'s block: nothing is said of the opening, the page says what it could not check, and reading again settles it', async ({ page, stack, chain }) => {
    test.setTimeout(120_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, fund: false });
    const listed = await listingCall(chain, listingId);
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed);
    // the reader trails the wallet while the opening is mined, so the page reads nothing of its block yet
    const letGo = await freezeReader(page, stack, chain);
    await page.getByRole('button', { name: STRINGS.chain.fund }).click();
    await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
    const [funded] = await chain.sa.queryFilter(chain.sa.filters.Opened(listingId));
    // Two blocks later the reader is on a chain where the listing is still listed, and it does not give the header of
    // the opening's block (asked by number: it is not the latest block's parent).
    await chain.provider.send('hardhat_mine', ['0x2']);
    let gives = false;
    const opening = `0x${funded.blockNumber.toString(16)}`;
    await interceptRpc(page, stack, (p) => {
      if (isCallWith(listed.data)(p)) return { result: listed.result };
      if (p.method === 'eth_getBlockByNumber' && p.params?.[0] === opening && !gives) return { result: null };
      return undefined;
    }, { from: 'reader' });
    await letGo();
    // the listing is shown as that read has it, at once; of the opening nothing is said, neither that it stands nor
    // that it is gone, and the funding form is not offered on the strength of a block the page could not check
    await expect(page.getByTestId('listing-state')).toHaveText(F.states.Listed, { timeout: 30_000 });
    await expect(page.getByTestId('listing-unchecked')).toHaveText(F.unchecked, { timeout: 30_000 });
    for (const id of ['opened', 'opening-dropped', 'listing-behind']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
    // once the node gives that header: the opening's block is the chain's, the listing never opened on it, and the
    // funding form is back with the alert
    gives = true;
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('opening-dropped')).toHaveText(fill(STRINGS.chain.openingDropped, { id: listingId, tx: funded.transactionHash }), { timeout: 20_000 });
    await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toBeVisible();
    await expect(page.getByTestId('listing-unchecked')).toHaveCount(0);
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
    await expect(page.getByTestId('listing-unread')).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const block of calls) expect(block, 'each call names the block by its hash, and none is asked by number').toEqual({ blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), requireCanonical: true });
    await stop();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-held')).toBeVisible();
  });

  test('a read address that does not take a block hash on a call: a failed read every time, and it is never asked by number', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await holdOnChain(chain, stack, listingId);
    await installWallet(page, stack);
    // The site's read address has to take a block's hash on a call (deploy/client.env). One that does not is a
    // misconfiguration, and the page does not work around it: it never learns from the refusal to ask another way.
    const asked = { byHash: 0, byNumber: 0 };
    const stop = await interceptRpc(page, stack, (p) => {
      if (p.method !== 'eth_call') return undefined;
      if (typeof p.params[1] === 'string') {
        asked.byNumber += 1;
        return undefined;
      }
      asked.byHash += 1;
      return { error: { code: -32602, message: 'invalid argument 1: cannot unmarshal object into Go value of type string' } };
    }, { from: 'reader' });
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-unread')).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    // asked again, it is asked the same way: by the block's hash
    const first = asked.byHash;
    expect(first).toBeGreaterThan(0);
    await page.getByTestId('listing-read-again').click();
    await expect.poll(() => asked.byHash).toBeGreaterThan(first);
    await expect(page.getByTestId('listing-unread')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('listing-unread')).toBeVisible();
    for (const id of ['listing-summary', 'listing-held', 'hold', 'roll-forward']) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(asked.byNumber, 'no call of the read address names its block by number').toBe(0);
    // an address that takes the hash: the same page reads
    await stop();
    await page.getByTestId('listing-read-again').click();
    await expect(page.getByTestId('listing-held')).toBeVisible();
  });

  test('through a hold sent from the page: the read address is asked by the block\'s hash, and the wallet\'s node by its number alone', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    const calls = { reader: [], wallet: [] };
    await interceptRpc(page, stack, (p) => { if (p.method === 'eth_call') calls.reader.push(p.params[1]); return undefined; }, { from: 'reader' });
    await interceptRpc(page, stack, (p) => { if (p.method === 'eth_call') calls.wallet.push(p.params[1]); return undefined; }, { from: 'wallet' });
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    await expect(section.getByTestId('held')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('listing-held-since')).toBeVisible();
    // the wallet's node read the listing before the hold was sent (the page checks it is the listing shown), and
    // every one of those calls named its block by number: a wallet's node is never sent the hash form
    expect(calls.wallet.length).toBeGreaterThan(0);
    for (const block of calls.wallet) expect(block, 'a call through the wallet').toEqual(expect.stringMatching(/^0x[0-9a-f]+$/));
    // and every call of the read address, before the hold and after it, named its block by hash
    expect(calls.reader.length).toBeGreaterThan(0);
    for (const block of calls.reader) expect(block, 'a call of the read address').toEqual({ blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), requireCanonical: true });
  });

  test('a hold the chain dates otherwise than the receipt did: one time on the page, the chain\'s, and no transaction named for it', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    const section = page.getByTestId('hold');
    await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    const done = section.getByTestId('held');
    await expect(done).toBeVisible({ timeout: 30_000 });
    const receiptTime = await chain.sa.heldAt(listingId);
    await expect(done).toContainText(at(receiptTime));
    // the chain as the site's reader then has it holds the hold from another block (the call was mined again later)
    const chainTime = receiptTime + 12n;
    await interceptRpc(page, stack, (p) => (isHeldAtCall(p) ? { result: word(chainTime) } : undefined), { from: 'reader' });
    const topUp = page.getByTestId('top-up');
    await topUp.getByTestId('top-up-amount').fill('0.01');
    await topUp.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: '0.01' }) }).click();
    await expect(topUp.getByTestId('topped-up')).toBeVisible({ timeout: 30_000 });
    // every place that says when the hold began says the chain's time, and the receipt's is nowhere on the page
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(chainTime));
    await expect(section.getByTestId('hold-since')).toHaveText(fill(H.since, { time: at(chainTime) }));
    await expect(section.getByTestId('held')).toHaveCount(0);
    await expect(page.getByTestId('listing-held')).toHaveText(fill(F.held, { id: listingId, time: at(chainTime) }));
    expect(await page.getByTestId('roll-forward').getByTestId('roll-hold-first').innerText()).toBe(fill(RF.hold.held, { time: at(chainTime) }));
    await expect(page.locator('main')).not.toContainText(at(receiptTime));
  });

  test('a hold() that is mined with no Held event in its receipt: the page names the transaction, claims no hold by it, and reads the listing', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, stack.accounts.maker);
    // the wallet's node hands back the receipt without its logs
    await interceptRpc(page, stack, async (p) => {
      if (p.method !== 'eth_getTransactionReceipt') return undefined;
      const res = await fetch(stack.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
      const { result } = await res.json();
      return { result: result ? { ...result, logs: [], logsBloom: `0x${'0'.repeat(512)}` } : result };
    }, { from: 'wallet' });
    const section = page.getByTestId('hold');
    await section.getByRole('button', { name: fill(H.ask, { id: listingId }) }).click();
    await section.getByRole('button', { name: fill(H.confirm, { id: listingId }) }).click();
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 30_000 });
    const [event] = await chain.sa.queryFilter(chain.sa.filters.Held(listingId));
    await expect(alert).toHaveText(fill(H.notConfirmed, { id: listingId, tx: event.transactionHash }));
    await expect(alert).not.toContainText('Nothing was sent');
    // no line of a hold this page saw mined; the listing is read from the transaction's block, and that read is the
    // chain's, where the hold is: said by the read, with its time
    await expect(section.getByTestId('held')).toHaveCount(0);
    await expect(section.getByTestId('hold-since')).toHaveText(fill(H.since, { time: at(event.args.heldAt) }), { timeout: 20_000 });
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(event.args.heldAt));
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

  test('a withdrawal says what was paid, by its receipt, and not the balance read before it was sent', async ({ page, stack, chain }) => {
    // every opening pays the listing fee into the fee recipient's balance in the contract
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const recipient = stack.accounts.feeRecipient;
    const held = await chain.sa.withdrawable(recipient);
    expect(held > 1n).toBe(true);
    await installWallet(page, stack, recipient);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, recipient);
    const panel = page.getByTestId('withdraw');
    const button = panel.getByRole('button', { name: fill(STRINGS.withdraw.button, { eth: formatEth(held) }) });
    await expect(button).toBeVisible();
    // the wallet's read just before sending sees half of it: the rest is credited before the call is mined
    const balance = chain.sa.interface.encodeFunctionData('withdrawable', [recipient]);
    await interceptRpc(page, stack, (p) => (isCallWith(balance)(p) ? { result: word(held / 2n) } : undefined), { from: 'wallet' });
    // this withdrawal's own event: the fee recipient is every test's, so only what is mined from here on is looked at
    const before = Number(await chain.provider.send('eth_blockNumber', []));
    await button.click();
    const done = panel.getByTestId('withdrawn');
    await expect(done).toBeVisible({ timeout: 30_000 });
    const events = await chain.sa.queryFilter(chain.sa.filters.Withdrawn(recipient), before + 1);
    expect(events.length).toBe(1);
    const [event] = events;
    expect(event.args.amount).toBe(held);
    await expect(done).toHaveText(fill(STRINGS.withdraw.done, { tx: event.transactionHash, eth: formatEth(held), account: recipient }));
    await expect(panel).not.toContainText(`${formatEth(held / 2n)} ETH to`);
  });

  test('the balance to withdraw follows the page\'s read: once the reader has caught up with a withdrawal, nothing is offered again', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const recipient = stack.accounts.feeRecipient;
    const held = await chain.sa.withdrawable(recipient);
    await installWallet(page, stack, recipient);
    await page.goto(`/#/fund/${listingId}`);
    await connect(page, recipient);
    const panel = page.getByTestId('withdraw');
    const button = panel.getByRole('button', { name: fill(STRINGS.withdraw.button, { eth: formatEth(held) }) });
    await expect(button).toBeVisible();
    // the site's reader trails the wallet's node while the withdrawal is mined, and catches up while the page is
    // still reading for its block
    const seen = { reads: 0, of: isCallWith((await listingCall(chain, listingId)).data) };
    const letGo = await freezeReader(page, stack, chain, seen);
    await button.click();
    await expect(panel.getByTestId('withdrawn')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => seen.reads, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await letGo();
    // the page's read reaches the withdrawal's block, and the balance is read again from there: nothing is held
    await expect(panel.getByTestId('withdraw-held')).toHaveCount(0, { timeout: 20_000 });
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(panel.getByTestId('withdrawn')).toBeVisible();
    expect(await chain.sa.withdrawable(recipient)).toBe(0n);
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
    const panel = page.getByTestId('top-up');
    // what the page says of a top-up here: the state goes back to open, and the hold stays
    await expect(panel.getByTestId('top-up-depleted')).toHaveText(fill(STRINGS.topUp.depletedHeld, { eth: formatEth(top) }));
    await expect(panel.getByTestId('top-up-amount')).toHaveValue(formatEth(top));
    await expect(panel.getByTestId('top-up-effect')).toHaveText(`${fill(STRINGS.topUp.effectPlain, { after: formatEth(top) })} ${STRINGS.topUp.reopensHeld}`);
    await expect(panel).not.toContainText(STRINGS.topUp.reopens);
    await panel.getByRole('button', { name: fill(STRINGS.topUp.button, { eth: formatEth(top) }) }).click();
    await expect(panel.getByTestId('topped-up')).toContainText(`The escrow now holds ${formatEth(top)} ETH. ${STRINGS.topUp.reopenedHeld}`, { timeout: 30_000 });
    await expect(panel.getByTestId('topped-up')).not.toContainText(STRINGS.topUp.reopened);

    // the chain: Open again, its escrow at the top award, its fee paid, and still no commit
    const after = await chain.sa.getListing(listingId);
    expect(Number(after.state)).toBe(1); // Open
    expect(after.escrowWei).toBe(top);
    expect(await chain.sa.isLapsed(listingId)).toBe(false);
    expect(await chain.sa.heldAt(listingId)).toBe(heldAt);
    expect(await chain.sa.acceptsCommits(listingId)).toBe(false);
    // the page follows: open, on hold, and never "open until"
    await expect(page.getByTestId('listing-summary')).toContainText(F.states.Open);
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
    await expect(page.getByTestId('commit-offer')).toContainText(STRINGS.offer.yes);
    await expect(page.getByTestId('renew').getByTestId('renew-period')).toHaveText(fill(STRINGS.renew.until, { time: at(listing.fundedUntil) }));
    await expect(page.getByTestId('renew').getByTestId('renew-held')).toHaveCount(0);
    await expect(page.getByTestId('close').getByRole('button', { name: fill(STRINGS.close.ask, { id: listingId }) })).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\bon hold\b/i);
    expect(text).not.toMatch(/\bhold\b/i);
    expect(wordingProblems(text)).toEqual([]);
    expect(await chain.sa.heldAt(listingId)).toBe(0n);
  });

  test('a read of the hold that fails another way is a failed read of the page, never "not on hold"', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const heldAt = await holdOnChain(chain, stack, listingId);
    // the node's own failure on that call: no revert, so no word of the contract
    const failed = await answerHeldAt(page, stack, { code: -32005, message: 'rate limit exceeded' });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByText(F.readFailed.replace('{reason}', ''), { exact: false })).toBeVisible();
    expect(failed.calls).toBeGreaterThan(0);
    // nothing of the listing is drawn from half a read: not its state, not an action, not "open until"
    await expect(page.getByTestId('listing-summary')).toHaveCount(0);
    await expect(page.getByTestId('roll-forward')).toHaveCount(0);
    await expect(page.getByTestId('hold')).toHaveCount(0);
    // once the node answers, reading again shows the listing as it is: on hold
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: F.retry }).click();
    await expect(page.getByTestId('listing-held-since')).toHaveText(at(heldAt));
  });
});
