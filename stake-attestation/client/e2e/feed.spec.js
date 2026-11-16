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
  await expect(page.getByTestId('feed-as-of')).toBeVisible();
  await expect(page.getByRole('heading', { name: STRINGS.diligence.title })).toBeVisible();
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'feed', { target: card });

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
});
