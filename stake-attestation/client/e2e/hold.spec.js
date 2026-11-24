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
import { answerHeldAt, archiveBytes, disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
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
const lines = async (locator) => (await locator.innerText()).split('\n');
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
    await connect(page, stack.accounts.maker);
    await expect(page.getByTestId('hold').getByRole('button')).toHaveCount(0);

    // a renewal is still the maker's to send, and the listing is on hold all the same: lapsed, then renewed
    await chain.increaseTime(Number(held.fundedUntil - BigInt(await chain.now())) + 3600);
    await page.reload();
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
