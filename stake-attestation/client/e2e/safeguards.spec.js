// Node P18: the claim, listing and record pages on the settlement safeguards (design §13.2, errata
// E7-E9), against the local stack and its keeper. A listing made while the owner's floor is 25
// points and the size 0: its page states both. A narrow INVALID shows its appeal window, the
// waiver of a hunter's early settle, then its returned bond once the keeper settles it from
// settleableAt. A HIGH waits for its confirmation, which the keeper starts after the dispute
// window, finalizes and settles. The record counts both, from the contract's record.
import { Contract } from 'ethers';

import { formatWhole } from '../src/lib/format.js';
import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
import { wordingProblems } from './support/wording.js';

const C = STRINGS.claim;
const E = STRINGS.enums;
const R = STRINGS.record;
const MAX = 2n ** 256n - 1n;
const THRESHOLD = 500_001n;
const NARROW = [600_000n, 0n, 0n, 0n, 400_000n, 0n];

test('the safeguards on the listing, claim and record pages, each as the contract has it', async ({ page, stack, chain }) => {
  test.setTimeout(240_000);
  const key = disclosure.generateDisclosureKeyPair();
  const owner = await chain.as(stack.accounts.owner);
  const agg = new Contract(stack.aggregator, stack.aggregatorAbi, await chain.provider.getSigner(stack.accounts.owner));
  await (await owner.setNarrowInvalidFloor(250_000n)).wait();
  await (await owner.setConfirmAboveWei(0n)).wait();
  let listing;
  try {
    listing = await chain.openListing({ recipient: key.recipient, escrow: 5n * 10n ** 18n });
  } finally {
    // every other test's listing is as before
    await (await owner.setConfirmAboveWei(MAX)).wait();
    await (await owner.setNarrowInvalidFloor(THRESHOLD)).wait();
  }
  const { listingId, artifactHash } = listing;
  await installWallet(page, stack);

  // the listing page: the floor and the size it was made with
  await page.goto(`/#/fund/${listingId}`);
  await expect(page.getByTestId('listing-band')).toHaveText(fill(STRINGS.chain.band, { floor: formatWhole(250_000n), points: '25' }));
  await expect(page.getByTestId('listing-size')).toHaveText(STRINGS.chain.sizeAll);

  // a narrow INVALID: the appeal window and the waiver, then the bond back once the keeper settles it
  const narrow = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'narrow' });
  await (await agg.scriptResult((await chain.sa.getClaim(narrow.claimId)).requestId, NARROW, 'bafkreinarrowjustificationxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).wait();
  await chain.judged(narrow.claimId);
  const appealDeadline = await chain.sa.appealDeadline(narrow.claimId);
  const time = (t) => new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z');
  await page.goto(`/#/claim/${narrow.claimId}`);
  await expect(page.getByTestId('claim-appeal')).toHaveText(fill(C.appealUntil, { time: time(appealDeadline) }));
  await expect(page.getByTestId('claim-waiver')).toHaveText(fill(C.waiver, { time: time(appealDeadline) }));
  await expect(page.getByTestId('claim-narrow')).toHaveText(C.narrowYes);
  await expect(page.getByTestId('claim-bond')).toHaveCount(0);
  await shot(page, 'claim-appeal-window');
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await chain.settledAfter(narrow.claimId);
  await page.reload();
  await expect(page.getByTestId('claim-bond')).toHaveText(C.bonds.returnedNarrow);
  await expect(page.getByTestId('claim-waiver')).toHaveCount(0);

  // a HIGH above the size: it awaits the confirmation; the keeper starts it after the dispute window
  const high = await chain.revealedClaim({ listingId, recipient: key.recipient, label: 'high' });
  await chain.verdict(high.claimId, 'HIGH');
  await chain.judged(high.claimId);
  const [opensAt, deadline] = await chain.sa.confirmWindow(high.claimId);
  await page.goto(`/#/claim/${high.claimId}`);
  await expect(page.getByTestId('claim-confirmation')).toHaveText(fill(C.confirmationStates.awaiting, { opensAt: time(opensAt), deadline: time(deadline) }));
  await expect(page.getByTestId('claim-appeal')).toHaveCount(0);
  await chain.increaseTime(Number(opensAt - BigInt(await chain.now())) + 1);
  await chain.until(async () => Number((await chain.sa.getClaim(high.claimId)).disputeKind) === 2, { what: 'the keeper\'s confirm' });
  await page.reload();
  await expect(page.getByTestId('claim-round-kind')).toContainText(E.disputeKinds.Confirmation);
  await chain.verdict(high.claimId, 'HIGH', { dispute: true });
  await chain.until(async () => (await chain.sa.getClaim(high.claimId)).settledAt !== 0n, { what: 'the confirmed HIGH settled' });
  await page.reload();
  await expect(page.getByTestId('claim-confirmation')).toHaveText(C.confirmationStates.held);
  await expect(page.getByTestId('claim-bond')).toHaveText(C.bonds.returned);
  await shot(page, 'claim-confirmed');

  // the record: the contract's counts, and the listing's floor and size
  await chain.until(async () => {
    const r = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
    return r.ok && (await r.json()).record.history.confirmationsHeld === '1';
  }, { what: 'the record mirror' });
  await page.goto(`/#/record/${artifactHash}`);
  await expect(page.getByTestId('history-narrow-invalid')).toHaveText('1');
  await expect(page.getByTestId('history-confirmations')).toHaveText('1');
  await expect(page.getByTestId('history-confirmation-results')).toHaveText(fill(R.confirmationLine, { held: 1, overturned: 0, noVerdict: 0 }));
  await expect(page.getByTestId('history-appeals')).toHaveText('0');
  await expect(page.getByTestId(`listing-${listingId}-narrow-floor`)).toHaveText(fill(R.narrowFloorLine, { floor: formatWhole(250_000n), points: '25' }));
  await expect(page.getByTestId(`listing-${listingId}-confirm-size`)).toHaveText(R.confirmSizeAll);
  await expect(page.getByTestId(`finding-${high.claimId}`)).toContainText(fill(R.findingRound, { kind: E.disputeKinds.Confirmation, result: E.panelResults.Held }));
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'record-safeguards');
});
