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

  // Tester bounty 400 (2026-11): a claim behind an earlier one cannot be revealed until that one is settled or
  // expired (decision D5), released or not, and the lens gives it no reveal deadline. The page said "the hunter may
  // reveal it now" of every release.
  test('release behind an earlier claim: the page names the claim that comes first, before and after the release', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const first = await chain.claim({ listingId, archive: archiveBytes('first in order'), recipient: key.recipient });
    const second = await chain.claim({ listingId, archive: archiveBytes('second in order'), recipient: key.recipient });
    expect((await chain.sa.getListing(listingId)).headClaim).toBe(first.claimId);
    expect((await chain.sa.claimTimes(second.claimId)).revealDeadline).toBe(0n);

    // the first claim: first on its listing, its deadline the latest it can be while its fix window is open
    await openClaim(page, stack, first.claimId);
    await expect(page.getByTestId('claim-queue')).toHaveText(C.queueFirst);
    await expect(page.getByTestId('claim-reveal-before')).toHaveText(fill(C.revealLatest, { time: at((await chain.sa.claimTimes(first.claimId)).revealDeadline) }));
    await expect(page.getByTestId('release-intro')).toHaveText(`${STRINGS.release.intro} ${STRINGS.release.counted}`);
    await expect(page.getByTestId('claim-queue-head')).toHaveCount(0);

    // the second: it waits for the first and has no deadline, and the panel says a release changes neither
    await page.goto(`/#/claim/${second.claimId}`);
    await expect(page.getByTestId('claim-queue')).toHaveText(fill(C.queueWaits, { head: first.claimId }));
    await expect(page.getByTestId('claim-reveal-before')).toHaveText(C.revealUnset);
    await expect(page.getByTestId('release-intro')).toHaveText(`${fill(STRINGS.release.introWaits, { head: first.claimId })} ${STRINGS.release.counted}`);
    await expect(page.getByTestId('claim-queue-head')).toHaveAttribute('href', `#/claim/${first.claimId}`);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
    await shot(page, 'claim-release-waits');
    await page.getByRole('button', { name: STRINGS.release.button }).click();
    const released = page.getByTestId('released');
    await expect(released).toBeVisible({ timeout: 30_000 });
    const tx = /0x[0-9a-f]{64}/.exec(await released.innerText())[0];
    await expect(released).toHaveText(fill(STRINGS.release.doneWaits, { tx, head: first.claimId }));
    await expect(released).not.toContainText('revealable now');

    // the chain agrees: released, its fix window over, and still no reveal deadline; a reveal is refused for the order
    expect((await chain.sa.getClaim(second.claimId)).released).toBe(true);
    expect(Number(await chain.sa.claimState(second.claimId))).toBe(1); // Revealable
    expect((await chain.sa.claimTimes(second.claimId)).revealDeadline).toBe(0n);
    await expect(chain.reveal(second)).rejects.toThrow(/earlier claim unresolved/);
    await expect(page.getByTestId('claim-state')).toHaveText(STRINGS.enums.claimStates.Revealable);
    await expect(page.getByTestId('claim-queue')).toHaveText(fill(C.queueWaits, { head: first.claimId }));
    await expect(page.getByTestId('claim-reveal-before')).toHaveText(C.revealUnset);

    // the listing's page says how many are open and which is first
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-queue')).toHaveText(`${fill(STRINGS.claims.open, { count: 2 })} ${fill(STRINGS.claims.order, { head: first.claimId })}`);
  });

  // The independent review of that change: the page does not poll an unrevealed claim, so the claim it waits for can
  // be settled or expired while the page is open. A release sent then would let the hunter reveal at once, under an
  // intro that says the opposite, so the page reads the claim again and stops.
  test('release: not sent under words that stopped being true while the page was open', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const first = await chain.claim({ listingId, archive: archiveBytes('never disclosed'), recipient: key.recipient, disclose: false });
    const second = await chain.claim({ listingId, archive: archiveBytes('waits, then first'), recipient: key.recipient });
    await openClaim(page, stack, second.claimId);
    await expect(page.getByTestId('release-intro')).toHaveText(`${fill(STRINGS.release.introWaits, { head: first.claimId })} ${STRINGS.release.counted}`);

    // the first claim's time to disclose passes, and someone expires it: no place in the order holds that back
    await chain.increaseTime(Number(await chain.sa.DISCLOSE_WINDOW()) + 1);
    await (await (await chain.as(stack.accounts.other)).expire(first.claimId)).wait();
    expect((await chain.sa.getListing(listingId)).headClaim).toBe(second.claimId);

    await page.getByRole('button', { name: STRINGS.release.button }).click();
    await expect(page.getByRole('alert')).toHaveText(C.changed);
    expect((await chain.sa.getClaim(second.claimId)).released).toBe(false);
    // read again: it is first now, and the panel says what a release does for the first claim
    await expect(page.getByTestId('claim-queue')).toHaveText(C.queueFirst);
    await expect(page.getByTestId('release-intro')).toHaveText(`${STRINGS.release.intro} ${STRINGS.release.counted}`);
    await page.getByRole('button', { name: STRINGS.release.button }).click();
    const released = page.getByTestId('released');
    await expect(released).toBeVisible({ timeout: 30_000 });
    const tx = /0x[0-9a-f]{64}/.exec(await released.innerText())[0];
    await expect(released).toHaveText(fill(STRINGS.release.done, { tx }));
    expect((await chain.sa.getClaim(second.claimId)).released).toBe(true);

    // the expired claim's page, and the listing's: one claim open, and it is first
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-queue')).toHaveText(`${fill(STRINGS.claims.open, { count: 1 })} ${fill(STRINGS.claims.order, { head: second.claimId })}`);
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
    // node P38: what a maker does before publishing a fix, above the picker; each line is one line of the page's text
    const panel = page.getByTestId('roll-forward');
    expect(await panel.getByTestId('roll-fix-keep').innerText()).toBe(STRINGS.roll.fix.keep);
    expect((await panel.getByTestId('roll-fix-order').innerText()).split('\n')).toEqual([STRINGS.roll.fix.noClaim, STRINGS.roll.fix.claimPending]);
    expect(wordingProblems(await panel.innerText())).toEqual([]);
    await shot(page, 'roll-forward', { target: panel });
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

  test('dispute: the round is watched from the moment it is mined, even when the wallet cannot read the claim after it', async ({ page, stack, chain }) => {
    test.setTimeout(180_000);
    const { listingId } = await chain.openListing({ recipient: key.recipient, stake: { fixWindowDays: 0, disclosureGraceHours: 0 } });
    const claim = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'refresh fails' });
    await chain.verdict(claim.claimId, 'HIGH');
    await chain.judged(claim.claimId);
    const fee = await chain.sa.disputeFee(listingId);

    await openClaim(page, stack, claim.claimId);
    await field(page, fill(STRINGS.dispute.statement, { max: 4096 })).fill('The class is overstated.');
    // every read through the wallet after the dispute is sent fails, as a flaky RPC would
    await page.evaluate(() => window.__testWallet.failCallsAfterNextSend(1000));
    await page.getByRole('button', { name: fill(STRINGS.dispute.button, { fee: formatEth(fee) }) }).click();
    await expect(page.getByTestId('disputed')).toBeVisible({ timeout: 60_000 });
    expect(Number((await chain.sa.getClaim(claim.claimId)).state)).toBe(4); // Disputed
    // the watch runs on the site's reader all the same, and finds the panel's verdict
    await expect(page.getByTestId('pending')).toBeVisible();
    await chain.verdict(claim.claimId, 'HIGH', { dispute: true });
    await expect(page.getByTestId('claim-dispute')).toHaveText(STRINGS.enums.disputes.Held, { timeout: 40_000 });
    await expect(page.getByTestId('pending')).toHaveCount(0);
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
