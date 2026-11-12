// Node P22: the site's pages fit a phone. At a 390 x 844 viewport the document is no wider than the
// viewport on the feed, a record and the listing form, with the wallet bar before and after the wallet
// connects. What is measured is document.documentElement.scrollWidth, not a screenshot. Nothing may be
// clipped to get there: the root and the body keep overflow-x visible, so whatever did not fit would
// widen the document and fail here.
import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
import { field, fillListing, repoTerms, validate } from './support/listingForm.js';

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE });

/**
 * The document's width against the viewport, the root's and the body's overflow-x, and (for the
 * message) the outermost elements that reach past the viewport's right edge outside a scroller, widest first.
 */
function measure(page) {
  return page.evaluate(() => {
    const scrolls = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX);
    const past = (el) => el.getBoundingClientRect().right > window.innerWidth + 0.5;
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p)) return true;
      return false;
    };
    // the nearest ancestor with a box of its own (a fact's row is display: contents)
    const boxParent = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body && getComputedStyle(p).display === 'contents') p = p.parentElement;
      return p && p !== document.body ? p : null;
    };
    const name = (el) => `${el.tagName.toLowerCase()}${el.getAttribute('class') ? `.${el.getAttribute('class').split(' ').join('.')}` : ''}${el.dataset?.testid ? `[${el.dataset.testid}]` : ''}`;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => past(el) && !inScroller(el) && !(boxParent(el) && past(boxParent(el))))
      .map((el) => ({ el, right: Math.round(el.getBoundingClientRect().right) }))
      .sort((a, b) => b.right - a.right)
      .slice(0, 8)
      .map(({ el, right }) => `${name(el)} right ${right}`);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowX: [getComputedStyle(document.documentElement).overflowX, getComputedStyle(document.body).overflowX],
      wide,
    };
  });
}

async function fits(page, what) {
  const m = await measure(page);
  expect.soft(m.innerWidth, what).toBe(PHONE.width);
  expect.soft(m.overflowX, `${what}: nothing is clipped to fit`).toEqual(['visible', 'visible']);
  expect.soft(m.scrollWidth, `${what}: document scrollWidth ${m.scrollWidth} at ${m.innerWidth}; past the edge: ${m.wide.join('; ')}`).toBeLessThanOrEqual(PHONE.width);
}

const goHash = (page, hash) => page.evaluate((h) => { window.location.hash = h; }, hash);

test('at 390 x 844 the feed, a record and the listing form are no wider than the viewport', async ({ page, stack, chain }) => {
  test.setTimeout(240_000);
  const key = disclosure.generateDisclosureKeyPair();
  // an invited listing that names its documents, with escrow left after a HIGH payout, so it stays in the feed
  const { listingId, artifactHash } = await chain.openListing({
    recipient: key.recipient,
    allowlist: [stack.accounts.hunter],
    stake: { documents: ['README.md', 'docs/**'] },
    escrow: 5n * 10n ** 18n,
  });
  // a valid finding, so the record has its findings table
  const high = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'phone width' });
  await chain.verdict(high.claimId, 'HIGH');
  await chain.judged(high.claimId);
  await chain.settledAfter(high.claimId);
  await chain.until(async () => {
    const res = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
    return res.ok && (await res.json()).record.findings.length === 1;
  }, { what: 'the record mirror' });
  const hash = artifactHash.toLowerCase();

  await installWallet(page, stack);
  const pages = [
    { name: 'feed', hash: '#/feed', ready: () => expect(page.getByTestId(`feed-${listingId}`)).toBeVisible() },
    { name: 'record', hash: `#/record/${hash}`, ready: () => expect(page.getByTestId(`finding-${high.claimId}`)).toBeVisible() },
    { name: 'list', hash: '#/list', ready: () => expect(page.getByRole('heading', { level: 2, name: STRINGS.listing.title })).toBeVisible() },
  ];

  // no wallet yet: the bar offers to connect
  await page.goto(`/${pages[0].hash}`);
  for (const p of pages) {
    await goHash(page, p.hash);
    await p.ready();
    await fits(page, `${p.name}, no wallet`);
  }

  // the maker's flow: the private key shown once, then the form validated by the server, which connects the wallet
  await page.getByRole('button', { name: STRINGS.key.generate }).click();
  await expect(field(page, STRINGS.key.identity)).not.toHaveValue('');
  await fits(page, 'list, the private key shown once');
  await page.getByRole('button', { name: STRINGS.key.saved }).click();
  await expect(page.getByText(STRINGS.key.gone)).toBeVisible();
  await fillListing(page, { ...await repoTerms(stack), allowlist: [stack.accounts.hunter] });
  await validate(page, 'ready');
  await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.maker }));
  await fits(page, 'list, validated, wallet connected');
  await shot(page, 'phone-list');

  // the wallet connected: the bar holds the account
  for (const p of pages.slice(0, 2)) {
    await goHash(page, p.hash);
    await p.ready();
    await expect(page.getByTestId('wallet')).toBeVisible();
    await fits(page, `${p.name}, wallet connected`);
    await shot(page, `phone-${p.name}`);
  }
});
