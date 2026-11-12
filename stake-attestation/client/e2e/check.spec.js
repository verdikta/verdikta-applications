// Acceptance 3 (node P6a): decrypt-and-check after a claim is disclosed, all in the browser:
// fetch the ciphertext from the gateway, check its sha256 against the claim's commitment,
// decryptDisclosure with the maker's private key, compare the plaintext's hash with the
// committed archive hash; offer flagBadDisclosure, through the wallet, only inside the grace
// period. Each test lists its own version (server + chain) under a key made for it, and the
// hunter's side (commit, pin, disclose) is sent from the test.
import fs from 'node:fs';

import { STRINGS, fill } from '../src/strings.js';
import { archiveBytes, disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
import { field } from './support/listingForm.js';

const C = STRINGS.check;
const step = (page, id) => page.getByTestId(`check-step-${id}`);
const stepText = (id, result) => fill(C.stepLine, { name: C.steps[id], result });
const keyFileOf = ({ identity, recipient }) => `# created: 2026-11-02T00:00:00Z\n# public key: ${recipient}\n${identity}\n`;

async function openCheck(page, stack, claimId, account = stack.accounts.maker) {
  await installWallet(page, stack, account);
  await page.goto(`/#/check/${claimId}`);
  await expect(page.getByTestId('claim-summary')).toBeVisible();
}

async function runCheck(page, identity) {
  await field(page, C.identity).fill(identity);
  await page.getByRole('button', { name: C.run }).click();
  await expect(page.getByTestId('check-verdict')).toBeVisible();
}

test.describe('decrypt-and-check', () => {
  let key;
  let listingId;
  test.beforeEach(async ({ chain }) => {
    key = disclosure.generateDisclosureKeyPair();
    ({ listingId } = await chain.openListing({ recipient: key.recipient }));
  });

  test('a disclosed copy that matches both commitments is decrypted locally; nothing to flag', async ({ page, stack, chain }) => {
    const archive = archiveBytes('matching');
    const { claimId, cid, ciphertextSha256, archiveHash } = await chain.claim({ listingId, archive, recipient: key.recipient });
    await openCheck(page, stack, claimId);
    const summary = page.getByTestId('claim-summary');
    await expect(summary).toContainText(fill(C.summary, { id: claimId, listingId }));
    await expect(summary).toContainText(cid);
    await expect(summary).toContainText(archiveHash);
    await expect(summary).toContainText(ciphertextSha256);

    // the downloaded key file works as well as the pasted key
    await page.getByLabel(C.keyFile).setInputFiles({ name: 'key.txt', mimeType: 'text/plain', buffer: Buffer.from(keyFileOf(key)) });
    await expect(field(page, C.identity)).toHaveValue(key.identity);
    await page.getByRole('button', { name: C.run }).click();
    await expect(page.getByTestId('check-verdict')).toHaveText(C.verdicts.match);
    for (const id of ['key', 'fetch', 'ciphertext', 'decrypt', 'plaintext']) await expect(step(page, id)).toHaveText(stepText(id, C.stepPassed));
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
    await shot(page, 'check-match');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: C.save }).click()]);
    expect(download.suggestedFilename()).toBe(`claim-${claimId}.zip`);
    expect(Buffer.from(fs.readFileSync(await download.path())).equals(Buffer.from(archive))).toBe(true);
  });

  test('a copy that is not the committed archive can be flagged inside the grace period', async ({ page, stack, chain }) => {
    // the hunter commits one archive and encrypts another
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('sent'), commitArchive: archiveBytes('committed'), recipient: key.recipient });
    await openCheck(page, stack, claimId);
    await runCheck(page, key.identity);
    await expect(step(page, 'ciphertext')).toHaveText(stepText('ciphertext', C.stepPassed));
    await expect(step(page, 'decrypt')).toHaveText(stepText('decrypt', C.stepPassed));
    await expect(step(page, 'plaintext')).toHaveText(stepText('plaintext', C.stepFailed));
    await expect(page.getByTestId('check-verdict')).toContainText(fill(C.verdicts.bad, { reason: '' }).trim());
    await expect(page.getByRole('button', { name: C.save })).toHaveCount(0);
    await shot(page, 'check-bad-disclosure');

    expect((await chain.sa.getClaim(claimId)).flaggedBadDisclosure).toBe(false);
    await page.getByRole('button', { name: C.flag }).click();
    await expect(page.getByTestId('flagged')).toBeVisible({ timeout: 30_000 });
    expect((await chain.sa.getClaim(claimId)).flaggedBadDisclosure).toBe(true);
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
    await shot(page, 'check-flagged');

    // reloaded, the page reads the flag from the chain
    await page.reload();
    await runCheck(page, key.identity);
    await expect(page.getByText(C.alreadyFlagged)).toBeVisible();
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
  });

  test('a ciphertext that is not the committed one, or one sealed to another key, is a bad disclosure', async ({ page, stack, chain }) => {
    const other = disclosure.generateDisclosureKeyPair();
    // the gateway serves bytes that are not the committed ciphertext
    const swapped = await chain.claim({ listingId, archive: archiveBytes('swapped'), recipient: key.recipient, served: Buffer.from('not the ciphertext') });
    await openCheck(page, stack, swapped.claimId);
    await runCheck(page, key.identity);
    await expect(step(page, 'ciphertext')).toHaveText(stepText('ciphertext', C.stepFailed));
    await expect(step(page, 'decrypt')).toHaveText(stepText('decrypt', C.stepSkipped));
    await expect(page.getByRole('button', { name: C.flag })).toBeVisible();

    // committed consistently, but encrypted to a key that is not the listing's
    const sealed = await chain.claim({ listingId, archive: archiveBytes('other key'), recipient: other.recipient });
    await page.goto(`/#/check/${sealed.claimId}`);
    await runCheck(page, key.identity);
    await expect(step(page, 'ciphertext')).toHaveText(stepText('ciphertext', C.stepPassed));
    await expect(step(page, 'decrypt')).toHaveText(stepText('decrypt', C.stepFailed));
    await expect(page.getByTestId('check-verdict')).toContainText('NO_MATCHING_IDENTITY');
    await expect(page.getByRole('button', { name: C.flag })).toBeVisible();
  });

  test('after the grace period the check still runs, but no flag is offered', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('late'), commitArchive: archiveBytes('other'), recipient: key.recipient });
    const claim = await chain.sa.getClaim(claimId);
    const listing = await chain.sa.getListing(listingId);
    await chain.increaseTime(Number(listing.disclosureGrace) + 60);
    await openCheck(page, stack, claimId);
    await runCheck(page, key.identity);
    await expect(step(page, 'plaintext')).toHaveText(stepText('plaintext', C.stepFailed));
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
    const graceEnd = new Date(Number(claim.disclosedAt + listing.disclosureGrace) * 1000).toISOString().replace('.000Z', 'Z');
    await expect(page.getByText(fill(C.graceOver, { time: graceEnd }))).toBeVisible();
    await shot(page, 'check-grace-over');
  });

  // The build's gateways, asked in order (src/lib/fetchCiphertext.js): the next only when one fails to deliver.
  const gatewayRequests = (page, cid) => {
    const asked = [];
    page.on('request', (r) => { if (r.url().endsWith(`/ipfs/${cid}`)) asked.push(new URL(r.url()).origin); });
    return asked;
  };

  test('a gateway that fails to deliver is passed over: the next one\'s copy is checked', async ({ page, stack, chain }) => {
    test.skip(stack.gatewayUrls.length < 2, 'the build names one gateway');
    const { claimId, cid } = await chain.claim({ listingId, archive: archiveBytes('first gateway down'), recipient: key.recipient, servedBy: [502, 'ciphertext'] });
    await openCheck(page, stack, claimId);
    const asked = gatewayRequests(page, cid);
    await runCheck(page, key.identity);
    await expect(page.getByTestId('check-verdict')).toHaveText(C.verdicts.match);
    expect(asked).toEqual(stack.gatewayUrls.slice(0, 2).map((u) => new URL(u).origin));
  });

  test('wrong bytes from the first gateway are a bad disclosure: the next, which has the right copy, is not asked', async ({ page, stack, chain }) => {
    test.skip(stack.gatewayUrls.length < 2, 'the build names one gateway');
    const { claimId, cid } = await chain.claim({ listingId, archive: archiveBytes('first gateway wrong'), recipient: key.recipient, servedBy: [Buffer.from('not the ciphertext'), 'ciphertext'] });
    await openCheck(page, stack, claimId);
    const asked = gatewayRequests(page, cid);
    await runCheck(page, key.identity);
    await expect(step(page, 'fetch')).toHaveText(stepText('fetch', C.stepPassed));
    await expect(step(page, 'ciphertext')).toHaveText(stepText('ciphertext', C.stepFailed));
    await expect(page.getByRole('button', { name: C.flag })).toBeVisible();
    expect(asked).toEqual([new URL(stack.gatewayUrls[0]).origin]);
  });

  test('when every gateway fails, the copy is unavailable and the page names the last failure', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('every gateway down'), recipient: key.recipient, servedBy: stack.gatewayUrls.map((_, i) => (i === stack.gatewayUrls.length - 1 ? 503 : 502)) });
    await openCheck(page, stack, claimId);
    await runCheck(page, key.identity);
    await expect(step(page, 'fetch')).toHaveText(stepText('fetch', C.stepFailed));
    await expect(page.getByTestId('check-verdict')).toHaveText(fill(C.verdicts.unavailable, { reason: fill(C.reasons.http, { status: 503 }) }));
    await expect(page.getByRole('button', { name: C.flag })).toBeVisible();
  });

  test('a private key that is not the listing\'s is the maker\'s mistake: nothing to flag', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('wrong key'), recipient: key.recipient });
    await openCheck(page, stack, claimId);
    await runCheck(page, disclosure.generateDisclosureKeyPair().identity);
    await expect(page.getByTestId('check-verdict')).toHaveText(C.verdicts.wrongKey);
    await expect(step(page, 'key')).toHaveText(stepText('key', C.stepFailed));
    await expect(step(page, 'fetch')).toHaveText(stepText('fetch', C.stepSkipped));
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);

    await runCheck(page, 'AGE-SECRET-KEY-1NOTAKEY');
    await expect(page.getByTestId('check-verdict')).toContainText(fill(C.verdicts.badIdentity, { reason: '' }).trim());
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
  });

  test('a wallet that switches to the maker\'s account can flag; the page asks the wallet again', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('switch'), commitArchive: archiveBytes('other'), recipient: key.recipient });
    await openCheck(page, stack, claimId, stack.accounts.other);
    await runCheck(page, key.identity);
    await page.getByRole('button', { name: C.flag }).click();
    await expect(page.getByText(fill(C.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }))).toBeVisible();
    await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.other }));

    await page.evaluate((maker) => window.__testWallet.setAccount(maker), stack.accounts.maker);
    // the old connection is forgotten as soon as the wallet says so
    await expect(page.getByRole('button', { name: STRINGS.wallet.connect })).toBeVisible();
    await page.getByRole('button', { name: C.flag }).click();
    await expect(page.getByTestId('flagged')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.maker }));
    expect((await chain.sa.getClaim(claimId)).flaggedBadDisclosure).toBe(true);
  });

  test('a wallet the page switches to the site\'s chain while flagging keeps the check and the flag on the page', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('auto switch'), commitArchive: archiveBytes('other'), recipient: key.recipient });
    await openCheck(page, stack, claimId);
    await runCheck(page, key.identity);
    await page.evaluate(() => window.__testWallet.setChain(1, { allowSwitch: true }));
    await page.getByRole('button', { name: C.flag }).click();
    await expect(page.getByTestId('flagged')).toBeVisible({ timeout: 30_000 });
    await expect(step(page, 'plaintext')).toHaveText(stepText('plaintext', C.stepFailed));
    expect((await chain.sa.getClaim(claimId)).flaggedBadDisclosure).toBe(true);
  });

  test('a flag offered before the grace ended is checked against the chain again when clicked', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('stale offer'), commitArchive: archiveBytes('other'), recipient: key.recipient });
    await openCheck(page, stack, claimId);
    await runCheck(page, key.identity);
    await expect(page.getByRole('button', { name: C.flag })).toBeVisible();
    const listing = await chain.sa.getListing(listingId);
    await chain.increaseTime(Number(listing.disclosureGrace) + 60);
    await page.getByRole('button', { name: C.flag }).click();
    await expect(page.getByText(/^The disclosure grace ended at /)).toBeVisible();
    await expect(page.getByRole('button', { name: C.flag })).toHaveCount(0);
    expect((await chain.sa.getClaim(claimId)).flaggedBadDisclosure).toBe(false);
  });

  test('a claim that is committed but not yet disclosed has nothing to check', async ({ page, stack, chain }) => {
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('undisclosed'), recipient: key.recipient, disclose: false });
    await openCheck(page, stack, claimId);
    await expect(page.getByText(C.notDisclosed)).toBeVisible();
    await expect(page.getByRole('button', { name: C.run })).toHaveCount(0);
  });
});

test('a claim id that does not exist says so', async ({ page, stack }) => {
  await installWallet(page, stack);
  await page.goto('/#/check');
  await field(page, C.claimId).fill('999999');
  await page.getByRole('button', { name: C.load }).click();
  await expect(page.getByText(fill(C.notFound, { id: '999999' }))).toBeVisible();
});
