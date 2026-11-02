// Acceptance 2 (node P6a): the disclosure key is generated in the browser with
// @verdikta/common's disclosure module; the private half is shown and downloadable once and is
// never sent. The second test records every request the browser makes through a whole maker
// session (generate, list, fund, then decrypt-and-check a disclosed claim with the same key) and
// asserts that none of them carries the private key in any encoding, and that no browser store
// holds it.
import fs from 'node:fs';

import { STRINGS } from '../src/strings.js';
import { archiveBytes, disclosure, expect, findSecret, installWallet, recordRequests, secretForms, shot, test } from './support/fixtures.js';
import { REPO_TERMS, field, fillListing, generateAndSaveKey, listAndFund, validate } from './support/listingForm.js';

const AGE_RECIPIENT = /^age1[ac-hj-np-z02-9]{58}$/;
const AGE_IDENTITY = /^AGE-SECRET-KEY-1[ACDEFGHJKLMNPQRSTUVWXYZ023456789]{58}$/;

test('the key pair is made in the browser, and its private half is shown and downloadable once', async ({ page, context, stack }) => {
  await installWallet(page, stack);
  await page.goto('/#/list');
  const submit = page.getByRole('button', { name: STRINGS.listing.submit });
  await expect(page.getByText(STRINGS.listing.needKey)).toBeVisible();
  await expect(submit).toBeDisabled();

  // offline: nothing but the page's own code can make the key
  await context.setOffline(true);
  await page.getByRole('button', { name: STRINGS.key.generate }).click();
  const recipient = await field(page, STRINGS.key.recipient).inputValue();
  const identity = await field(page, STRINGS.key.identity).inputValue();
  await context.setOffline(false);
  expect(recipient).toMatch(AGE_RECIPIENT);
  expect(identity).toMatch(AGE_IDENTITY);
  // the pair is common's: the identity's recipient is the listed key
  expect(disclosure.disclosureRecipient(identity)).toBe(recipient);
  await expect(page.getByText(STRINGS.key.shownOnce)).toBeVisible();
  await expect(submit).toBeDisabled(); // not before the maker says the private half is saved
  await shot(page, 'disclosure-key-shown-once', { fullPage: false });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: STRINGS.key.download }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^verdikta-disclosure-key-[a-z0-9]{8}\.txt$/);
  const keyFile = fs.readFileSync(await download.path(), 'utf8');
  // age-keygen's format: stock `age -d -i <file>` reads it
  expect(keyFile).toMatch(/^# created: \d{4}-\d\d-\d\dT[\d:.]+Z\n/);
  expect(keyFile).toContain(`# public key: ${recipient}\n`);
  expect(keyFile.trimEnd().split('\n').at(-1)).toBe(identity);

  await page.getByLabel(STRINGS.key.saved).check();
  await expect(page.getByText(STRINGS.key.gone)).toBeVisible();
  await expect(field(page, STRINGS.key.identity)).toHaveCount(0);
  await expect(page.getByRole('button', { name: STRINGS.key.download })).toHaveCount(0);
  expect(await page.content()).not.toContain(identity);
  // the public half stays: it is what the listing names
  await expect(field(page, STRINGS.key.recipient)).toHaveValue(recipient);
  await expect(submit).toBeEnabled();

  // a different key is a new pair, shown once again; the old private half never comes back
  await page.getByRole('button', { name: STRINGS.key.replace }).click();
  const second = await field(page, STRINGS.key.identity).inputValue();
  expect(second).toMatch(AGE_IDENTITY);
  expect(second).not.toBe(identity);
  expect(await page.content()).not.toContain(identity);
});

test('no request carries the private key, and no browser store holds it', async ({ page, context, stack, chain }) => {
  const rec = recordRequests(context);
  await installWallet(page, stack);
  await page.goto('/#/list');

  const { recipient, identity, keyFile } = await generateAndSaveKey(page);
  await fillListing(page, { ...REPO_TERMS, allowlist: [] });
  await validate(page, 'ready');
  const listingId = await listAndFund(page);

  // a hunter's claim, disclosed to this key; the maker checks it with the same private key
  const archive = archiveBytes('no-key-in-requests');
  const { claimId, cid } = await chain.claim({ listingId, archive, recipient });
  await page.goto(`/#/check/${claimId}`);
  await page.getByLabel(STRINGS.check.keyFile).setInputFiles({ name: 'key.txt', mimeType: 'text/plain', buffer: Buffer.from(keyFile) });
  await page.getByRole('button', { name: STRINGS.check.run }).click();
  await expect(page.getByTestId('check-verdict')).toHaveText(STRINGS.check.verdicts.match);
  await field(page, STRINGS.check.identity).fill(identity);
  await page.getByRole('button', { name: STRINGS.check.run }).click();
  await expect(page.getByTestId('check-verdict')).toHaveText(STRINGS.check.verdicts.match);

  const forms = secretForms(identity);
  const requests = await rec.settle();
  // the recorder saw the session: the listing request with the public key, the RPC calls, the ciphertext
  const listingPost = requests.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/listings');
  expect(listingPost, 'POST /api/listings was recorded').toBeTruthy();
  expect(listingPost.body.toString('utf8')).toContain(recipient);
  expect(requests.some((r) => r.url.startsWith(stack.rpcUrl) && r.body.toString('utf8').includes('eth_sendTransaction'))).toBe(true);
  expect(requests.some((r) => r.url === `${stack.gatewayUrl}/ipfs/${cid}`)).toBe(true);
  expect(requests.length).toBeGreaterThan(10);

  for (const r of requests) {
    expect(findSecret(forms, r.url), `URL of ${r.method} ${r.url}`).toBeNull();
    expect(findSecret(forms, JSON.stringify(r.headers)), `headers of ${r.method} ${r.url}`).toBeNull();
    expect(findSecret(forms, r.body), `body of ${r.method} ${r.url}`).toBeNull();
  }
  for (const f of rec.frames) expect(findSecret(forms, f), 'a WebSocket frame').toBeNull();
  expect(findSecret(forms, page.url())).toBeNull();

  // nothing persistent in the browser holds it
  const stores = await page.evaluate(async () => {
    const dump = (s) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    const cacheKeys = 'caches' in window ? await caches.keys() : [];
    return { local: dump(localStorage), session: dump(sessionStorage), cookie: document.cookie, dbs, cacheKeys };
  });
  expect(findSecret(forms, JSON.stringify(stores))).toBeNull();
  expect(stores.dbs).toEqual([]);
  expect(stores.cacheKeys).toEqual([]);
  expect(findSecret(forms, JSON.stringify(await context.cookies()))).toBeNull();
  expect(findSecret(forms, JSON.stringify(await context.storageState()))).toBeNull();

  // and the server never saw it: neither the builder it ran nor the listing it keeps
  expect(findSecret(forms, fs.readFileSync(stack.builderRecord))).toBeNull();
  const { id } = await (await listingPost.req.response()).json();
  const view = await (await fetch(`${stack.apiUrl}/api/listings/${id}`)).text();
  expect(view).toContain(recipient);
  expect(findSecret(forms, view)).toBeNull();
});
