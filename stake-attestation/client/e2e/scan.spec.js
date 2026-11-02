// The maker's baseline scan in the listing flow (design §8.3; the server's routes from node P4b2,
// read here by node P6b): the listing request names the connected wallet as the maker; once the
// scan has finished, the page asks for a sign-in challenge, the wallet signs it (EIP-191
// personal_sign), and the findings are shown to that wallet only.
import crypto from 'node:crypto';

import { STRINGS, fill } from '../src/strings.js';
import { expect, installWallet, readStack, setBuilderMode, shot, test } from './support/fixtures.js';
import { fillListing, generateAndSaveKey, repoTerms, validate } from './support/listingForm.js';

const S = STRINGS.scan;

test.afterEach(() => setBuilderMode(readStack(), 'accepted'));

test('the scan\'s findings are shown to the maker\'s wallet after it signs in, and to no other', async ({ page, stack }) => {
  const mark = `scan-canary-${crypto.randomBytes(8).toString('hex')}`;
  setBuilderMode(stack, 'accepted', { scanMode: 'ok', mark });
  const requests = [];
  page.on('request', (r) => { if (r.url().includes('/api/listings')) requests.push({ url: r.url(), body: r.postData() }); });

  await installWallet(page, stack);
  await page.goto('/#/list');
  await fillListing(page, repoTerms());
  await generateAndSaveKey(page);
  await validate(page, 'ready');
  // the request named the connected wallet as the maker
  const sent = JSON.parse(requests.find((r) => r.url.endsWith('/api/listings')).body);
  expect(sent.maker).toBe(stack.accounts.maker);

  const panel = page.getByTestId('scan-panel');
  await expect(page.getByTestId('scan-status')).toHaveText(fill(S.status, { status: S.statuses.done }));
  // nothing of the scan is on the page before the maker signs in
  await expect(page.locator('main')).not.toContainText(mark);

  // another wallet is refused before anything is signed
  await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.other);
  await panel.getByRole('button', { name: S.read }).click();
  await expect(panel.getByRole('alert')).toHaveText(fill(S.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
  await expect(page.locator('main')).not.toContainText(mark);

  await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.maker);
  await panel.getByRole('button', { name: S.read }).click();
  const findings = page.getByTestId('scan-findings');
  await expect(findings).toBeVisible({ timeout: 30_000 });
  await expect(findings.locator('li')).toHaveCount(3);
  await expect(findings).toContainText(`tx.origin decides who may withdraw (${mark})`);
  await expect(panel).toContainText(fill(S.findings, { count: 3 }));
  await shot(page, 'listing-scan', { target: panel });
  // a wallet that switches away no longer sees them
  await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.other);
  await expect(page.getByTestId('scan-findings')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(mark);
  await expect(panel.getByRole('button', { name: S.read })).toBeVisible();
  // the scan was read once, with the signature, from the listing's scan route
  expect(requests.filter((r) => /\/scan$/.test(r.url))).toHaveLength(1);
  expect(JSON.parse(requests.find((r) => /\/scan$/.test(r.url)).body)).toEqual({ nonce: expect.stringMatching(/^[0-9a-f]{32}$/), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
});

test('without a wallet the request names no maker, and the page says no scan runs', async ({ page }) => {
  await page.goto('/#/list');
  await fillListing(page, repoTerms());
  await generateAndSaveKey(page);
  await validate(page, 'ready');
  await expect(page.getByTestId('scan-status')).toHaveText(fill(S.status, { status: S.statuses.skipped }));
  await expect(page.getByText(S.noWallet)).toBeVisible();
  await expect(page.getByRole('button', { name: S.read })).toHaveCount(0);
});
