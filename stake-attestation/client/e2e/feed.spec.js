// Acceptance 1 (node P6b): the feed page (design §15) lists every listing that takes claims, from
// GET /api/feed, with what a hunter chooses by: hash, image, scope, award table, bond, windows,
// days open, claims so far and escrow remaining, the labels, and links to the record and the
// listing; the diligence text is on it, and nothing it renders is a judgement of the code.
import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, shot, test } from './support/fixtures.js';
import { wordingProblems } from './support/wording.js';

const F = STRINGS.feed;
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

async function feedEntry(stack, listingId) {
  const res = await fetch(`${stack.apiUrl}/api/feed`);
  if (!res.ok) return null;
  return (await res.json()).listings.find((l) => l.listingId === String(listingId)) ?? null;
}

test('the feed lists an open listing with its terms, labels and links', async ({ page, stack, chain }) => {
  const key = disclosure.generateDisclosureKeyPair();
  const { listingId, artifactHash, view } = await chain.openListing({ recipient: key.recipient, allowlist: [stack.accounts.hunter] });
  // the indexer has seen it and the listing archive (image, scope) has been read beside it
  let entry = null;
  await chain.until(async () => {
    entry = await feedEntry(stack, listingId);
    return Boolean(entry?.archive?.ok);
  }, { what: 'the feed entry' });
  const listing = await chain.sa.getListing(listingId);
  const commit = view.list.params.artifact.baseCommit;

  await page.goto('/#/feed');
  await expect(page.getByRole('heading', { name: F.title, level: 2 })).toBeVisible();
  const card = page.getByTestId(`feed-${listingId}`);
  await expect(card).toBeVisible();
  const f = (name) => card.getByTestId(`feed-${listingId}-${name}`);
  await expect(f('artifact')).toHaveText(fill(F.repoAt, { repo: 'https://github.com/acme/vault', commit }));
  await expect(f('hash')).toHaveText(artifactHash.toLowerCase());
  await expect(f('labels')).toHaveText([STRINGS.labels['under-staked'], STRINGS.labels.invited].join(', '));
  await expect(f('awards')).toHaveText(fill(STRINGS.record.awardsLine, { LOW: '0', MEDIUM: '0.1', HIGH: '0.4', CRITICAL: '2' }));
  // drawn as pills and chips, read as one line each: the page's text (what a reader copies) is the value whole
  expect(await f('labels').innerText()).toBe([STRINGS.labels['under-staked'], STRINGS.labels.invited].join(', '));
  expect(await f('awards').innerText()).toBe(fill(STRINGS.record.awardsLine, { LOW: '0', MEDIUM: '0.1', HIGH: '0.4', CRITICAL: '2' }));
  await expect(f('lowest')).toHaveText('MEDIUM');
  await expect(f('bond')).toHaveText(fill(STRINGS.record.eth, { eth: '0.02' }));
  await expect(f('windows')).toHaveText(fill(F.windowsLine, { fix: 14, dispute: 72, grace: 48, reveal: 7, disclose: 60 }));
  await expect(f('opened')).toHaveText(at(listing.openedAt));
  await expect(f('funded-until')).toHaveText(at(listing.fundedUntil));
  await expect(f('days-open')).toHaveText(String(entry.daysOpen));
  await expect(f('claims')).toHaveText('0');
  await expect(f('escrow')).toHaveText(fill(STRINGS.record.eth, { eth: '2' }));
  await expect(f('value-at-risk')).toHaveText(fill(STRINGS.record.usd, { usd: '1,250,000' }));
  await expect(f('image')).toHaveText(entry.image);
  await expect(f('scope')).toHaveText(fill(F.scopeLine, { include: entry.scope.include.join(', '), exclude: entry.scope.exclude.join(', ') }));
  // node P20: where the listing says its requirements are written; this one names none
  await expect(f('documents')).toHaveText(F.documentsNone);
  // node P35: the disclosure key in both its forms, said to be one key, and the other listings of its repository
  await expect(f('disclosure-key')).toContainText(key.recipient);
  await expect(f('disclosure-key')).toContainText(listing.disclosureKey);
  await expect(f('disclosure-key')).toContainText(STRINGS.disclosure.note);
  for (const x of entry.sameRepository) {
    await expect(f('same-repository').getByTestId(`same-repository-${x.listingId}`).getByRole('link')).toHaveAttribute('href', `#/fund/${x.listingId}`);
  }
  await expect(page.getByTestId('feed-as-of')).toBeVisible();
  await expect(page.getByRole('heading', { name: STRINGS.diligence.title })).toBeVisible();
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'feed', { target: card });
  // the same card for a reader whose system asks for dark
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'feed-dark', { target: card });
  await page.emulateMedia({ colorScheme: 'light' });

  // a commit shows up in the count once the indexer reads it
  const commitArchive = new Uint8Array(Buffer.from(`PK\u0003\u0004 feed claim ${Math.random()}`, 'latin1'));
  const hunter = await chain.as(stack.accounts.hunter);
  await (await hunter.commit(listingId, disclosure.disclosureSha256(commitArchive), disclosure.disclosureSha256(commitArchive), { value: await chain.sa.commitPrice(listingId) })).wait();
  await chain.until(async () => (await feedEntry(stack, listingId))?.claimsSoFar === 1, { what: 'the claim count' });
  await page.getByRole('button', { name: STRINGS.site.retry }).click();
  await expect(f('claims')).toHaveText('1');

  // the record and the listing are a click away
  await card.getByRole('link', { name: F.record }).click();
  await expect(page.getByTestId('record-hash')).toHaveText(artifactHash.toLowerCase());
  await page.goBack();
  await page.getByTestId(`feed-${listingId}`).getByRole('link', { name: F.listing }).click();
  await expect(page.getByTestId('listing-summary')).toContainText(fill(STRINGS.fund.summary, { id: listingId }));
  await expect(page.getByTestId('listing-disclosure-key')).toContainText(key.recipient);
  await expect(page.getByTestId('same-repository')).toContainText(STRINGS.sameRepository.title);
  for (const x of entry.sameRepository) await expect(page.getByTestId(`same-repository-${x.listingId}`)).toHaveCount(1);
});

// The site's look for node P35's two additions. Each keeps its text, one line of the page's text (what a reader
// selects, a search of the page finds and a tool reads): the key's two forms are chips in that line, each with a
// button that copies it whole, and the other listing's line is one link, its state a pill.
test('the disclosure key and the other listings keep their line, drawn as chips and a pill', async ({ page, stack, chain }) => {
  const key = disclosure.generateDisclosureKeyPair();
  const first = await chain.openListing({ recipient: key.recipient });
  const second = await chain.openListing({ recipient: key.recipient });
  let other = null;
  await chain.until(async () => {
    const entry = await feedEntry(stack, second.listingId);
    other = entry?.sameRepository.find((x) => x.listingId === String(first.listingId)) ?? null;
    return Boolean(entry?.archive?.ok && other);
  }, { what: 'the feed entry and its repository\'s other listing' });
  const listing = await chain.sa.getListing(second.listingId);
  const keyLine = fill(STRINGS.disclosure.line, { recipient: key.recipient, bytes32: listing.disclosureKey });
  const otherLine = fill(STRINGS.sameRepository.line, { id: first.listingId, commit: other.artifact.baseCommit, state: STRINGS.fund.states.Open });
  const copyName = (form) => fill(STRINGS.copy.label, { what: STRINGS.disclosure.copy[form] });
  // what a copy button writes: the site's headers deny reading the clipboard back (Permissions-Policy, clipboard-read),
  // so the write is recorded where it is made
  await page.addInitScript(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (text) => { window.__copied.push(String(text)); };
  });
  const copied = () => page.evaluate(() => window.__copied.at(-1));

  for (const where of ['listing', 'feed']) {
    await page.goto(where === 'listing' ? `/#/fund/${second.listingId}` : '/#/feed');
    const shown = page.getByTestId(where === 'listing' ? 'listing-disclosure-key' : `feed-${second.listingId}-disclosure-key`);
    await expect(shown).toContainText(key.recipient);
    if (where === 'listing') {
      await expect(page.getByTestId(`same-repository-${first.listingId}`)).toBeVisible();
      await shot(page, 'listing-disclosure-key', { target: page.getByTestId('listing-summary') });
      await shot(page, 'listing-other-listings', { target: page.getByTestId('same-repository') });
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'listing-disclosure-key-dark', { target: page.getByTestId('listing-summary') });
      await shot(page, 'listing-other-listings-dark', { target: page.getByTestId('same-repository') });
      await page.emulateMedia({ colorScheme: 'light' });
      // on a phone each chip wraps inside itself: the page never scrolls sideways
      const size = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await shot(page, 'listing-disclosure-key-phone', { target: page.getByTestId('listing-summary') });
      await shot(page, 'listing-other-listings-phone', { target: page.getByTestId('same-repository') });
      await page.setViewportSize(size);
    }
    // the text is the line and the note, as before; on the page the line is one line and the note the next
    await expect(shown).toHaveText(`${keyLine} ${STRINGS.disclosure.note}`);
    expect((await shown.innerText()).split('\n')).toEqual([keyLine, STRINGS.disclosure.note]);
    for (const form of [key.recipient, listing.disclosureKey]) expect(await page.evaluate((t) => window.find(t, true, false, true), form)).toBe(true);
    // each form has its own button, named for what it copies, and copies that form whole
    await shown.getByRole('button', { name: copyName('recipient') }).click();
    await expect(shown.getByRole('button', { name: STRINGS.copy.done })).toHaveCount(1);
    expect(await copied()).toBe(key.recipient);
    await shown.getByRole('button', { name: copyName('bytes32') }).click();
    expect(await copied()).toBe(listing.disclosureKey);

    const line = page.getByTestId(where === 'listing' ? 'same-repository' : `feed-${second.listingId}-same-repository`).getByTestId(`same-repository-${first.listingId}`);
    await expect(line).toHaveText(otherLine);
    expect(await line.innerText()).toBe(otherLine);
    await expect(line.getByRole('link', { name: otherLine })).toHaveAttribute('href', `#/fund/${first.listingId}`);
    await expect(line.locator('.pill')).toHaveText(STRINGS.fund.states.Open);
    await expect(line.locator('.pill-ok')).toHaveCount(1);
    expect(await page.evaluate((t) => window.find(t, true, false, true), other.artifact.baseCommit)).toBe(true);
  }
});
