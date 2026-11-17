// A listing's later life on its own page, through the wallet (design §13.2): a top-up adds to the escrow,
// paying what the listing owes first; renew() pays the listing fee for another 30 days; close() ends the
// stake and returns the escrow; and withdraw() collects what the contract holds for the connected wallet. Each is the maker's (or the held wallet's) alone, reads the
// chain again before it sends, and is checked here against the chain afterwards.
import { JsonRpcProvider } from 'ethers';

import { formatEth } from '../src/lib/format.js';
import { STRINGS, fill } from '../src/strings.js';
import { archiveBytes, disclosure, expect, installWallet, shot, test } from './support/fixtures.js';
import { wordingProblems } from './support/wording.js';

const T = STRINGS.topUp;
const R = STRINGS.renew;
const C = STRINGS.close;
const W = STRINGS.withdraw;
const ETH = 10n ** 18n;
const PERIOD = 30n * 86400n;
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
const useAccount = (page, account) => page.evaluate((a) => window.__testWallet.setAccount(a), account);
/**
 * The contract, read with no cache. ethers answers a read it made in the last 250 ms from memory, and this
 * chain mines a transaction faster than that: a balance read before a click and again after it would be
 * the same answer twice.
 */
const uncached = (stack, chain) => chain.sa.connect(new JsonRpcProvider(stack.rpcUrl, stack.chainId, { staticNetwork: true, cacheTimeout: -1 }));

test.describe('a listing\'s later life', () => {
  let key;
  test.beforeEach(() => {
    key = disclosure.generateDisclosureKeyPair();
  });

  test('top up: the maker adds to an open listing\'s escrow, with no fee', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const sa = uncached(stack, chain);
    const before = await sa.getListing(listingId);
    const held = await sa.withdrawable(stack.accounts.feeRecipient);

    await installWallet(page, stack, stack.accounts.other);
    await page.goto(`/#/fund/${listingId}`);
    const panel = page.getByTestId('top-up');
    await expect(panel.getByTestId('top-up-escrow')).toHaveText(fill(T.escrow, { eth: formatEth(before.escrowWei), top: formatEth(before.awards[3]) }));
    // nothing is owed and it is not depleted: neither line is there
    await expect(panel.getByTestId('top-up-owed')).toHaveCount(0);
    await expect(panel.getByTestId('top-up-depleted')).toHaveCount(0);

    // no amount, an amount of 0 and text that is no amount: nothing can be sent
    const amount = panel.getByTestId('top-up-amount');
    await expect(panel.getByRole('button', { name: T.buttonNoAmount, exact: true })).toBeDisabled();
    await amount.fill('0');
    await expect(panel.getByText(T.positive)).toBeVisible();
    await expect(panel.getByRole('button', { name: T.buttonNoAmount, exact: true })).toBeDisabled();
    await amount.fill('half');
    await expect(panel.getByText(STRINGS.listing.bounds.amount)).toBeVisible();
    await expect(panel.getByRole('button', { name: T.buttonNoAmount, exact: true })).toBeDisabled();

    // an amount: what it would do is said before anything is sent
    await amount.fill('0.5');
    const after = before.escrowWei + ETH / 2n;
    await expect(panel.getByTestId('top-up-effect')).toHaveText(fill(T.effectPlain, { after: formatEth(after) }));
    const button = panel.getByRole('button', { name: fill(T.button, { eth: '0.5' }) });

    // another wallet is refused before anything is sent
    await button.click();
    await expect(panel.getByRole('alert')).toHaveText(fill(STRINGS.claim.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
    expect((await sa.getListing(listingId)).escrowWei).toBe(before.escrowWei);

    // the maker: all of it reaches the escrow, no fee is charged, and the paid period does not move
    await useAccount(page, stack.accounts.maker);
    await button.click();
    await expect(panel.getByTestId('topped-up')).toContainText(`The escrow now holds ${formatEth(after)} ETH.`, { timeout: 30_000 });
    const topped = await sa.getListing(listingId);
    expect(topped.escrowWei).toBe(after);
    expect(Number(topped.state)).toBe(1); // Open
    expect(topped.fundedUntil).toBe(before.fundedUntil);
    expect(await sa.withdrawable(stack.accounts.feeRecipient)).toBe(held);
    // the page follows, with the page still up: the new escrow here and where closing would return it
    await expect(panel.getByTestId('top-up-escrow')).toHaveText(fill(T.escrow, { eth: formatEth(after), top: formatEth(before.awards[3]) }));
    await expect(page.getByTestId('close-escrow')).toHaveText(fill(C.escrow, { eth: formatEth(after) }));
    await expect(amount).toHaveValue('');
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('top up: a depleted listing pays the award it owes first, and reopens once its escrow is back at the top award', async ({ page, stack, chain }) => {
    test.setTimeout(240_000);
    // Two claims on a listing whose escrow is its top award, both committed while it is open. Claims resolve in
    // commit order: the first, CRITICAL, takes the whole escrow, so the listing is depleted; only then can the
    // second be revealed, and its HIGH settles with nothing to pay it, so its award is owed.
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const sa = uncached(stack, chain);
    const top = (await sa.getListing(listingId)).awards[3];
    const high = (await sa.getListing(listingId)).awards[2];
    const first = await chain.claim({ listingId, archive: archiveBytes('top-up critical'), recipient: key.recipient });
    const owedClaim = await chain.claim({ listingId, archive: archiveBytes('top-up high'), recipient: key.recipient });
    // the maker releases a claim whose fix window is still open, then the hunter reveals it
    const reveal = async (c) => {
      const { revealableAt } = await sa.claimTimes(c.claimId);
      if (BigInt(await chain.now()) < revealableAt) await (await (await chain.as(stack.accounts.maker)).release(c.claimId)).wait();
      await chain.reveal(c);
    };
    await reveal(first);
    await chain.verdict(first.claimId, 'CRITICAL');
    await chain.judged(first.claimId);
    await chain.settledAfter(first.claimId);
    expect(Number((await sa.getListing(listingId)).state), 'the CRITICAL award took the escrow').toBe(2); // Depleted
    await reveal(owedClaim);
    await chain.verdict(owedClaim.claimId, 'HIGH');
    await chain.judged(owedClaim.claimId);
    await chain.settledAfter(owedClaim.claimId);
    const depleted = await sa.getListing(listingId);
    expect(Number(depleted.state)).toBe(2); // Depleted
    expect(depleted.escrowWei).toBe(0n);
    expect(depleted.owedWei).toBe(high);
    const hunterHeld = await sa.withdrawable(stack.accounts.hunter);

    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    const panel = page.getByTestId('top-up');
    await expect(panel.getByTestId('top-up-escrow')).toHaveText(fill(T.escrow, { eth: '0', top: formatEth(top) }));
    await expect(panel.getByTestId('top-up-owed')).toHaveText(fill(T.owed, { eth: formatEth(high) }));
    // what reopens it: the award owed, then the whole top award, since the escrow is empty; the field starts there
    await expect(panel.getByTestId('top-up-depleted')).toHaveText(fill(T.depleted, { eth: formatEth(high + top) }));
    const amount = panel.getByTestId('top-up-amount');
    await expect(amount).toHaveValue(formatEth(high + top));
    await expect(panel.getByTestId('top-up-effect')).toHaveText(`${fill(T.effect, { owed: formatEth(high), rest: formatEth(top), after: formatEth(top) })} ${T.reopens}`);
    // closing is refused while an award is owed
    await expect(page.getByTestId('close-blocked')).toHaveText(fill(C.owed, { eth: formatEth(high) }));

    // 1 ETH: the award owed is paid to the hunter's balance in the contract, the rest is escrow, and it stays depleted
    await amount.fill('1');
    await expect(panel.getByTestId('top-up-effect')).toHaveText(fill(T.effect, { owed: formatEth(high), rest: formatEth(ETH - high), after: formatEth(ETH - high) }));
    await shot(page, 'listing-top-up', { target: panel });
    await panel.getByRole('button', { name: fill(T.button, { eth: '1' }) }).click();
    await expect(panel.getByTestId('topped-up')).toContainText(`${formatEth(high)} ETH went to hunters who were owed it, and the escrow now holds ${formatEth(ETH - high)} ETH.`, { timeout: 30_000 });
    await expect(panel.getByTestId('topped-up')).not.toContainText(T.reopened);
    const partly = await sa.getListing(listingId);
    expect(Number(partly.state)).toBe(2);
    expect(partly.owedWei).toBe(0n);
    expect(partly.escrowWei).toBe(ETH - high);
    expect(await sa.withdrawable(stack.accounts.hunter)).toBe(hunterHeld + high);
    expect((await sa.getClaim(owedClaim.claimId)).owedWei).toBe(0n);
    // the page follows: nothing is owed now, and what reopens it is what the escrow is short of the top award
    await expect(panel.getByTestId('top-up-owed')).toHaveCount(0);
    await expect(panel.getByTestId('top-up-depleted')).toHaveText(fill(T.depleted, { eth: formatEth(top - (ETH - high)) }));

    // the rest: the escrow is back at the top award, and the listing is open again
    await amount.fill(formatEth(top - (ETH - high)));
    await expect(panel.getByTestId('top-up-effect')).toHaveText(`${fill(T.effectPlain, { after: formatEth(top) })} ${T.reopens}`);
    await panel.getByRole('button', { name: fill(T.button, { eth: formatEth(top - (ETH - high)) }) }).click();
    await expect(panel.getByTestId('topped-up')).toContainText(`The escrow now holds ${formatEth(top)} ETH. ${T.reopened}`, { timeout: 30_000 });
    const reopened = await sa.getListing(listingId);
    expect(Number(reopened.state)).toBe(1); // Open
    expect(reopened.escrowWei).toBe(top);
    expect(await sa.acceptsCommits(listingId)).toBe(true);
    await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Open);
    await expect(panel.getByTestId('top-up-depleted')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });

  test('renew: the maker pays the listing fee again; 30 days are added, or run from now once the period has lapsed', async ({ page, stack, chain }) => {
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const sa = uncached(stack, chain);
    const before = await sa.getListing(listingId);
    const fee = BigInt(stack.listingFeeWei);
    const held = await sa.withdrawable(stack.accounts.feeRecipient);

    // what the page says before any wallet is connected: until when the fee is paid, and what 30 more days cost
    await installWallet(page, stack, stack.accounts.other);
    await page.goto(`/#/fund/${listingId}`);
    const panel = page.getByTestId('renew');
    await expect(panel.getByTestId('renew-period')).toHaveText(fill(R.until, { time: at(before.fundedUntil) }));
    await expect(panel.getByTestId('renew-fee')).toHaveText(fill(R.fee, { fee: formatEth(fee) }));
    const button = panel.getByRole('button', { name: fill(R.button, { fee: formatEth(fee) }) });

    // another wallet is refused before anything is sent
    await button.click();
    await expect(panel.getByRole('alert')).toHaveText(fill(STRINGS.claim.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
    expect((await sa.getListing(listingId)).fundedUntil).toBe(before.fundedUntil);

    // the maker: 30 days on top of what was paid, the fee to the fee recipient's balance, the escrow untouched
    await useAccount(page, stack.accounts.maker);
    await button.click();
    const paid = before.fundedUntil + PERIOD;
    await expect(panel.getByTestId('renewed')).toContainText(`The listing fee is paid until ${at(paid)}.`, { timeout: 30_000 });
    await expect(panel.getByTestId('renew-period')).toHaveText(fill(R.until, { time: at(paid) }));
    const renewed = await sa.getListing(listingId);
    expect(renewed.fundedUntil).toBe(paid);
    expect(renewed.escrowWei).toBe(before.escrowWei);
    expect(await sa.withdrawable(stack.accounts.feeRecipient)).toBe(held + fee);
    // the listing's own line follows, with the page still up
    await expect(page.getByText(fill(STRINGS.fund.alreadyOpen, { id: listingId, until: at(paid) }))).toBeVisible();
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
    await shot(page, 'listing-renew', { target: panel });

    // once the period has lapsed the page says so, and a renewal runs from when it is sent: the gap is not bought
    await chain.increaseTime(Number(paid - BigInt(await chain.now())) + 3600);
    await page.reload();
    await useAccount(page, stack.accounts.maker);
    await expect(panel.getByTestId('renew-period')).toHaveText(fill(R.lapsed, { time: at(paid) }));
    await button.click();
    await expect(panel.getByTestId('renewed')).toBeVisible({ timeout: 30_000 });
    const again = (await sa.getListing(listingId)).fundedUntil;
    expect(again >= paid + 3600n + PERIOD, `30 days from when it was sent: ${again}`).toBe(true);
    expect(again < paid + 2n * PERIOD, 'the lapsed gap is not bought').toBe(true);
    await expect(panel.getByTestId('renew-period')).toHaveText(fill(R.until, { time: at(again) }));
  });

  test('close: refused while a claim is pending; otherwise two steps, and the escrow comes back to the maker', async ({ page, stack, chain }) => {
    // a listing with a claim that is neither settled nor expired: the contract refuses, so the page offers nothing
    const claimed = await chain.openListing({ recipient: key.recipient });
    await chain.claim({ listingId: claimed.listingId, archive: archiveBytes('close'), recipient: key.recipient });
    await installWallet(page, stack);
    await page.goto(`/#/fund/${claimed.listingId}`);
    const panel = page.getByTestId('close');
    await expect(panel.getByTestId('close-blocked')).toHaveText(fill(C.pending, { count: 1 }));
    await expect(panel.getByRole('button')).toHaveCount(0);

    // a listing with no claim
    const { listingId, artifactHash } = await chain.openListing({ recipient: key.recipient });
    const sa = uncached(stack, chain);
    const before = await sa.getListing(listingId);
    const eth = formatEth(before.escrowWei);
    await page.goto(`/#/fund/${listingId}`);
    await expect(panel.getByTestId('close-escrow')).toHaveText(fill(C.escrow, { eth }));

    // the first step says what closing does and sends nothing; it can be taken back
    const ask = panel.getByRole('button', { name: fill(C.ask, { id: listingId }) });
    const confirm = panel.getByRole('button', { name: fill(C.confirm, { id: listingId, eth }) });
    await ask.click();
    await expect(confirm).toBeVisible();
    await shot(page, 'listing-close', { target: panel });
    await panel.getByRole('button', { name: C.keep }).click();
    await expect(confirm).toHaveCount(0);
    expect(Number((await sa.getListing(listingId)).state)).toBe(1); // Open

    // another wallet is refused before anything is sent
    await useAccount(page, stack.accounts.other);
    await ask.click();
    await confirm.click();
    await expect(panel.getByRole('alert')).toHaveText(fill(STRINGS.claim.notMaker, { maker: stack.accounts.maker, account: stack.accounts.other }));
    expect(Number((await sa.getListing(listingId)).state)).toBe(1);

    // the maker: the listing is Closed, its escrow is back in the maker's wallet, and the page says what came back
    await useAccount(page, stack.accounts.maker);
    const balance = await sa.runner.getBalance(stack.accounts.maker);
    await confirm.click();
    await expect(panel.getByTestId('closed')).toContainText(`${eth} ETH of escrow went back to ${stack.accounts.maker}.`, { timeout: 30_000 });
    const after = await sa.getListing(listingId);
    expect(Number(after.state)).toBe(4); // Closed
    expect(after.escrowWei).toBe(0n);
    const gained = (await sa.runner.getBalance(stack.accounts.maker)) - balance;
    expect(gained <= before.escrowWei && gained > before.escrowWei - 10n ** 16n, `the escrow less the gas: ${gained}`).toBe(true);
    expect(await sa.withdrawable(stack.accounts.maker)).toBe(0n);

    // the page follows without a reload: the state, and nothing left to renew, close or roll forward
    await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Closed);
    await expect(page.getByTestId('renew')).toHaveCount(0);
    await expect(page.getByTestId('roll-forward')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);

    // the record and the badge say how the stake ended
    await chain.until(async () => {
      const r = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
      return r.ok && (await r.json()).record.listings.some((l) => l.listingId === String(listingId) && l.state === 'Closed');
    }, { what: 'the record mirror' });
    await page.goto(`/#/record/${artifactHash}`);
    await expect(page.getByTestId(`listing-${listingId}-state`)).toHaveText(STRINGS.enums.listingStates.Closed);
    const svg = await (await page.request.get(`/api/records/${String(artifactHash).toLowerCase()}/badge.svg`)).text();
    expect(svg).toContain('stake closed');
    expect(svg).not.toContain('while staked');

    // and a closed listing's own page offers neither again
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Closed);
    await expect(page.getByTestId('close')).toHaveCount(0);
    await expect(page.getByTestId('renew')).toHaveCount(0);
  });

  test('withdraw: a wallet the contract holds something for collects it; a wallet it holds nothing for is shown nothing', async ({ page, stack, chain }) => {
    // every opening pays the listing fee into the fee recipient's balance in the contract
    const { listingId } = await chain.openListing({ recipient: key.recipient });
    const recipient = stack.accounts.feeRecipient;
    const sa = uncached(stack, chain);
    const held = await sa.withdrawable(recipient);
    expect(held >= BigInt(stack.listingFeeWei)).toBe(true);
    expect(await sa.withdrawable(stack.accounts.maker)).toBe(0n);

    // the maker's wallet: nothing held, so no panel, before or after it connects
    await installWallet(page, stack);
    await page.goto(`/#/fund/${listingId}`);
    await expect(page.getByTestId('close')).toBeVisible();
    await expect(page.getByTestId('withdraw')).toHaveCount(0);
    await page.getByRole('button', { name: STRINGS.wallet.connect }).click();
    await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.maker }));
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('withdraw')).toHaveCount(0);

    // the fee recipient's wallet: what is held, then the transaction that collects it
    await useAccount(page, recipient);
    await page.getByRole('button', { name: STRINGS.wallet.connect }).click();
    const panel = page.getByTestId('withdraw');
    await expect(panel.getByTestId('withdraw-held')).toHaveText(fill(W.held, { eth: formatEth(held), account: recipient }));
    await shot(page, 'listing-withdraw', { target: panel });
    const balance = await sa.runner.getBalance(recipient);
    await panel.getByRole('button', { name: fill(W.button, { eth: formatEth(held) }) }).click();
    await expect(panel.getByTestId('withdrawn')).toContainText(`${formatEth(held)} ETH to ${recipient}.`, { timeout: 30_000 });
    expect(await sa.withdrawable(recipient)).toBe(0n);
    const gained = (await sa.runner.getBalance(recipient)) - balance;
    expect(gained <= held && gained > held - 10n ** 16n, `what was held less the gas: ${gained}`).toBe(true);
    // nothing is left to collect, and the page offers nothing more
    await expect(panel.getByTestId('withdraw-held')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(0);
    expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  });
});
