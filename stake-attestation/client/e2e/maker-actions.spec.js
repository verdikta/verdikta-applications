// Acceptances 2 and 3 (node P6b): the maker's actions on a claim or a listing, through the wallet
// (design §13.2): release inside the fix window, roll forward to a funded successor of the same
// artifact, and dispute a valid verdict with a statement pinned by the server and named by CID in
// the request's second addendum line (erratum E2), the escalation prepay read from the chain and
// shown before anything is sent. A pending evaluation is polled for up to 15 minutes; then the
// page says so plainly and offers a re-check.
import { formatEth } from '../src/lib/format.js';
import { STRINGS, fill } from '../src/strings.js';
import { archiveBytes, disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
import { field } from './support/listingForm.js';
import { wordingProblems } from './support/wording.js';

const C = STRINGS.claim;
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

async function openClaim(page, stack, claimId, account = stack.accounts.maker) {
  await installWallet(page, stack, account);
  await page.goto(`/#/claim/${claimId}`);
  await expect(page.getByTestId('claim-facts')).toBeVisible();
}

test.describe('maker actions', () => {
  let key;
  test.beforeEach(() => {
    key = disclosure.generateDisclosureKeyPair();
  });

  test('release: the maker waives the rest of the fix window, through the wallet', async ({ page, stack, chain }) => {
    const { listingId, artifactHash } = await chain.openListing({ recipient: key.recipient });
    const { claimId } = await chain.claim({ listingId, archive: archiveBytes('release'), recipient: key.recipient });
    const { revealableAt } = await chain.sa.claimTimes(claimId);

    // the listing's page lists its claims and links to each
    await installWallet(page, stack);
    await chain.until(async () => {
      const r = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
      return r.ok && (await r.json()).history.events.some((e) => e.name === 'Committed' && e.claimId === String(claimId));
    }, { what: 'the claim in the record mirror' });
    await page.goto(`/#/fund/${listingId}`);
    await page.getByTestId('listing-claims').getByRole('link', { name: fill(STRINGS.claims.line, { id: claimId }) }).click();
    await expect(page.getByTestId('claim-facts')).toBeVisible();
    await expect(page.getByTestId('claim-state')).toHaveText(STRINGS.enums.claimStates.Committed);
    await expect(page.getByTestId('claim-fix-window-end')).toHaveText(at(revealableAt));

    // another account is refused before anything is sent
    await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.other);
    await page.getByRole('button', { name: STRINGS.release.button }).click();
    await expect(page.getByRole('alert')).toHaveText(fill(C.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
    expect((await chain.sa.getClaim(claimId)).released).toBe(false);

    await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.maker);
    await shot(page, 'claim-release');
    await page.getByRole('button', { name: STRINGS.release.button }).click();
    await expect(page.getByTestId('released')).toBeVisible({ timeout: 30_000 });
    const claim = await chain.sa.getClaim(claimId);
    expect(claim.released).toBe(true);
    expect(Number(await chain.sa.claimState(claimId))).toBe(1); // Revealable
    await expect(page.getByTestId('claim-state')).toHaveText(STRINGS.enums.claimStates.Revealable);
    await expect(page.getByRole('button', { name: STRINGS.release.button })).toHaveCount(0);
  });

  test('roll forward: the maker picks a funded listing of the same repository', async ({ page, stack, chain }) => {
    const first = await chain.openListing({ recipient: key.recipient });
    const { claimId } = await chain.claim({ listingId: first.listingId, archive: archiveBytes('roll'), recipient: key.recipient });
    const successor = await chain.openListing({ recipient: key.recipient });
    // not candidates: another maker's listing of the repository, and one of another repository
    const theirs = await chain.openListing({ recipient: key.recipient, maker: stack.accounts.other });
    const elsewhere = await chain.openListing({ recipient: key.recipient, spec: { repo: 'https://github.com/acme/other' } });
    await chain.until(async () => {
      const r = await fetch(`${stack.apiUrl}/api/feed`);
      const ids = r.ok ? (await r.json()).listings.map((l) => l.listingId) : [];
      return [first, successor, theirs, elsewhere].every((l) => ids.includes(String(l.listingId)));
    }, { what: 'the feed' });

    await installWallet(page, stack);
    await page.goto(`/#/fund/${first.listingId}`);
    const pick = field(page, STRINGS.roll.pick);
    await expect(pick).toBeVisible();
    const options = await pick.locator('option').evaluateAll((os) => os.map((o) => o.value));
    expect(options).toContain(String(successor.listingId));
    expect(options).not.toContain(String(theirs.listingId));
    expect(options).not.toContain(String(elsewhere.listingId));
    expect(options).not.toContain(String(first.listingId));
    await pick.selectOption(String(successor.listingId));
    await shot(page, 'roll-forward', { target: page.getByTestId('roll-forward') });
    await page.getByRole('button', { name: fill(STRINGS.roll.button, { id: successor.listingId }) }).click();
    await expect(page.getByTestId('rolled')).toBeVisible({ timeout: 30_000 });

    const l = await chain.sa.getListing(first.listingId);
    expect(Number(l.state)).toBe(3); // Rolled
    expect(l.successor).toBe(successor.listingId);
    expect((await chain.sa.getListing(successor.listingId)).predecessor).toBe(first.listingId);
    // every claim disclosed on it is revealable at once
    expect(Number(await chain.sa.claimState(claimId))).toBe(1);
    await expect(page.getByRole('button', { name: fill(STRINGS.roll.button, { id: successor.listingId }) })).toHaveCount(0);
  });

  test('dispute: the escalation prepay is shown, the statement pinned and named by CID in the request', async ({ page, stack, chain }) => {
    test.setTimeout(180_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, stake: { fixWindowDays: 0, disclosureGraceHours: 0 } });
    const claim = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'disputed' });
    await chain.verdict(claim.claimId, 'MEDIUM');
    await chain.judged(claim.claimId);
    const fee = await chain.sa.disputeFee(listingId);
    const deadline = await chain.sa.disputeDeadline(claim.claimId);

    await openClaim(page, stack, claim.claimId);
    await expect(page.getByTestId('claim-outcome')).toHaveText('MEDIUM');
    const panel = page.getByTestId('dispute-panel');
    await expect(panel).toContainText(fill(STRINGS.dispute.intro, { deadline: at(deadline) }));
    await expect(page.getByTestId('dispute-prepay')).toHaveText(fill(STRINGS.dispute.prepay, { fee: formatEth(fee) }));

    const statement = 'The proof of concept reads a storage slot that the listed known issue 0x1f covers. Ünïcödé.';
    await field(page, fill(STRINGS.dispute.statement, { max: 4096 })).fill(statement);
    await expect(panel).toContainText(fill(STRINGS.dispute.bytes, { bytes: Buffer.byteLength(statement), max: 4096 }));
    await shot(page, 'dispute-panel', { target: panel });
    const balanceBefore = await chain.provider.getBalance(stack.accounts.maker);
    await page.getByRole('button', { name: fill(STRINGS.dispute.button, { fee: formatEth(fee) }) }).click();
    await expect(page.getByTestId('disputed')).toBeVisible({ timeout: 60_000 });

    // on-chain: Disputed, the statement by CID, the prepay paid
    const c = await chain.sa.getClaim(claim.claimId);
    expect(Number(c.state)).toBe(4); // Disputed
    const { rawCid } = await import('../../server/src/pinning/cid.js');
    const cid = rawCid(Buffer.from(statement, 'utf8'));
    await expect(page.getByTestId('statement-cid')).toHaveText(fill(STRINGS.dispute.pinned, { cid }));
    const request = await chain.request(c.disputeRequestId);
    const lines = request.addendum.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`verdikta-dispute: ${cid}`);
    expect(disclosure.parseAddendum(request.addendum).dispute.statementCid).toBe(cid);
    // the pinned bytes are the statement, readable where arbiters read IPFS
    const pinned = await fetch(`${stack.gatewayUrl}/ipfs/${cid}`);
    expect(Buffer.from(await pinned.arrayBuffer()).toString('utf8')).toBe(statement);
    expect(balanceBefore - (await chain.provider.getBalance(stack.accounts.maker))).toBeGreaterThanOrEqual(fee);

    // the dispute round is pending, and the page watches it until the panel's verdict lands
    await expect(page.getByTestId('pending')).toContainText(fill(STRINGS.pending.dispute, { time: at(c.disputedAt), seconds: 5, minutes: 15 }));
    await shot(page, 'dispute-pending');
    await chain.verdict(claim.claimId, 'HIGH', { dispute: true });
    await expect(page.getByTestId('claim-outcome')).toHaveText('HIGH', { timeout: 40_000 });
    await expect(page.getByTestId('claim-dispute')).toHaveText(STRINGS.enums.disputes.Overturned);
    await expect(page.getByTestId('pending')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('dispute: a statement over 4,096 bytes is refused before the wallet is asked anything', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient, stake: { fixWindowDays: 0, disclosureGraceHours: 0 } });
    const claim = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'too long' });
    await chain.verdict(claim.claimId, 'LOW');
    await chain.judged(claim.claimId);
    await openClaim(page, stack, claim.claimId);
    await field(page, fill(STRINGS.dispute.statement, { max: 4096 })).fill('é'.repeat(2049));
    await expect(page.getByText(fill(STRINGS.dispute.tooLong, { bytes: 4098, max: 4096 }))).toBeVisible();
    const fee = await chain.sa.disputeFee(listingId);
    await expect(page.getByRole('button', { name: fill(STRINGS.dispute.button, { fee: formatEth(fee) }) })).toBeDisabled();
  });
});

test('a pending evaluation is watched for 15 minutes, then the page says so and offers a re-check', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const key = disclosure.generateDisclosureKeyPair();
  const { listingId } = await chain.openListing({ recipient: key.recipient, stake: { fixWindowDays: 0, disclosureGraceHours: 0 } });
  const claim = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'slow' });
  const c = await chain.sa.getClaim(claim.claimId);

  await page.clock.install();
  await openClaim(page, stack, claim.claimId);
  await expect(page.getByTestId('claim-state')).toHaveText(STRINGS.enums.claimStates.Revealed);
  await expect(page.getByTestId('pending')).toContainText(fill(STRINGS.pending.claim, { time: at(c.revealedAt), seconds: 5, minutes: 15 }));
  await expect(page.getByRole('button', { name: STRINGS.pending.recheck })).toHaveCount(0);

  // fourteen minutes: still watching
  await page.clock.fastForward('14:00');
  await expect(page.getByTestId('pending-timeout')).toHaveCount(0);
  // past fifteen: the page has stopped and says so
  await page.clock.fastForward('01:10');
  await expect(page.getByTestId('pending-timeout')).toHaveText(fill(STRINGS.pending.timedOut, { minutes: 15 }));
  await shot(page, 'pending-timed-out');

  // the verdict lands later; a re-check finds it
  await chain.verdict(claim.claimId, 'INVALID');
  await chain.judged(claim.claimId);
  await page.getByRole('button', { name: STRINGS.pending.recheck }).click();
  await expect(page.getByTestId('claim-outcome')).toHaveText('INVALID', { timeout: 30_000 });
  await expect(page.getByTestId('pending-timeout')).toHaveCount(0);
});
