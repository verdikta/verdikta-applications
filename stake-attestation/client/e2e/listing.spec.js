// Acceptance 1 (node P6a): the maker's listing flow. Artifact, scope, award table, lowest class
// counted, bond, windows (defaults 14/30 d, 72 h, 48 h, 7 d; a 0-day fix window allowed; the
// decision D8 bounds), allowlist, known-issues editor and value at risk; validated through the
// real server (its builder stubbed by the server's own fake builder CLI); the validation report
// shown; list() and fund() sent through the wallet to StakeAttestation on local Hardhat.
import common from '@verdikta/common';

import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, installWallet, setBuilderMode, shot, test } from './support/fixtures.js';
import { awardField, field, fillListing, generateAndSaveKey, listAndFund, repoTerms, validate } from './support/listingForm.js';

const F = STRINGS.listing.fields;
const B = STRINGS.listing.bounds;
const DAY = 86400n;
const HOUR = 3600n;
const ETH = 10n ** 18n;
const State = { Open: 1n };
const bytes32Of = (recipient) => `0x${Buffer.from(disclosure.parseDisclosureKey(recipient)).toString('hex')}`;

const KNOWN_ISSUE = {
  title: 'Owner can pause deposits',
  class: 'MEDIUM',
  paths: ['src/Vault.sol', 'src/Pausable.sol'],
  description: 'The owner may pause deposits at any time; withdrawals stay open. Documented and accepted.',
};

test.beforeEach(async ({ page, stack }) => {
  await installWallet(page, stack);
  await page.goto('/#/list');
  await expect(page.getByRole('heading', { level: 2, name: STRINGS.listing.title })).toBeVisible();
});

test('the windows default to 14 days (30 for a contract), 72 h, 48 h and 7 days', async ({ page }) => {
  await expect(field(page, F.fixWindowDays)).toHaveValue('14');
  await expect(field(page, F.disputeWindowHours)).toHaveValue('72');
  await expect(field(page, F.disclosureGraceHours)).toHaveValue('48');
  await expect(field(page, F.revealWindowDays)).toHaveValue('7');

  await field(page, F.kind).selectOption('contract');
  await expect(field(page, F.fixWindowDays)).toHaveValue('30');
  await expect(field(page, F.address)).toBeVisible();
  await field(page, F.kind).selectOption('repo');
  await expect(field(page, F.fixWindowDays)).toHaveValue('14');
  await expect(field(page, F.address)).toHaveCount(0);

  // a window the maker chose is theirs: changing the kind leaves it alone
  await field(page, F.fixWindowDays).fill('21');
  await field(page, F.kind).selectOption('contract');
  await expect(field(page, F.fixWindowDays)).toHaveValue('21');
});

test('the form holds the D8 bounds, and a 0-day fix window is allowed with no grace', async ({ page }) => {
  const submit = page.getByRole('button', { name: STRINGS.listing.submit });
  await fillListing(page, repoTerms());
  await generateAndSaveKey(page);
  await expect(submit).toBeEnabled();

  await field(page, F.fixWindowDays).fill('0');
  await expect(page.getByText(B.grace)).toBeVisible();
  await expect(submit).toBeDisabled();
  await field(page, F.disclosureGraceHours).fill('0');
  await expect(page.getByText(B.grace)).toHaveCount(0);
  await expect(submit).toBeEnabled();

  await field(page, F.fixWindowDays).fill('91');
  await expect(page.getByText(B.fixWindow)).toBeVisible();
  await field(page, F.fixWindowDays).fill('90');
  await expect(page.getByText(B.fixWindow)).toHaveCount(0);

  await field(page, F.disputeWindowHours).fill('23');
  await expect(page.getByText(B.disputeWindow)).toBeVisible();
  await field(page, F.disputeWindowHours).fill('2161');
  await expect(page.getByText(B.disputeWindow)).toBeVisible();
  await field(page, F.disputeWindowHours).fill('24');
  await expect(page.getByText(B.disputeWindow)).toHaveCount(0);

  await field(page, F.revealWindowDays).fill('2');
  await expect(page.getByText(B.revealWindow)).toBeVisible();
  await field(page, F.revealWindowDays).fill('3');
  await expect(page.getByText(B.revealWindow)).toHaveCount(0);

  await field(page, F.disclosureGraceHours).fill('2.5');
  await expect(page.getByText(B.wholeNumber)).toBeVisible();
  await expect(submit).toBeDisabled();
  await field(page, F.disclosureGraceHours).fill('2160');
  await expect(page.getByText(B.wholeNumber)).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

test('a maker lists and funds a repository version: server validation, report, list() and fund()', async ({ page, stack, chain }) => {
  const { recipient } = await generateAndSaveKey(page);
  // HIGH below MEDIUM: the client leaves the award rules to the server, which refuses them
  const terms = repoTerms();
  await fillListing(page, {
    ...terms,
    awards: { ...terms.awards, HIGH: '0.05' },
    allowlist: [stack.accounts.hunter],
    knownIssues: [KNOWN_ISSUE],
    valueAtRisk: 1250000,
  });
  const knownIssueId = common.codeReview.knownIssueId(KNOWN_ISSUE);
  await expect(page.getByText(fill(STRINGS.listing.knownIssues.id, { id: knownIssueId }))).toBeVisible();

  await page.getByRole('button', { name: STRINGS.listing.submit }).click();
  const refused = page.getByRole('alert').filter({ hasText: STRINGS.listing.refusedTitle });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('STAKE_AWARDS_NOT_MONOTONE');
  await expect(refused).toContainText('/spec/stake/awards/HIGH');
  await shot(page, 'listing-refused-by-server', { target: refused });

  await awardField(page, 'HIGH').fill('0.4');
  await validate(page, 'ready');
  const report = page.getByRole('region', { name: STRINGS.report.title });
  await expect(report).toContainText(fill(STRINGS.report.status, { status: 'accepted' }));
  for (const name of ['spec', 'fetch', 'build', 'push', 'registry', 'listingCheck', 'finalSpec']) {
    await expect(page.getByTestId(`report-step-${name}`)).toHaveText(fill(STRINGS.report.step, { name: STRINGS.report.stepNames[name], status: 'ok' }));
  }
  await expect(report).toContainText(STRINGS.report.devTrust);
  await expect(page.getByRole('region', { name: STRINGS.chain.readyTitle })).toContainText(fill(STRINGS.chain.allowlist, { count: 1 }));
  await shot(page, 'listing-validated');

  const listingId = await listAndFund(page);
  await expect(page.getByTestId('wallet')).toHaveText(fill(STRINGS.wallet.connected, { account: stack.accounts.maker }));
  await shot(page, 'listing-open');

  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.maker).toBe(stack.accounts.maker);
  expect(l.disclosureKey).toBe(bytes32Of(recipient));
  expect(l.awards.map(String)).toEqual(['0', String(ETH / 10n), String((4n * ETH) / 10n), String(2n * ETH)]);
  expect(l.bondWei).toBe((2n * ETH) / 100n);
  expect(l.lowestClassCounted).toBe(3n); // MEDIUM
  expect([l.fixWindow, l.disputeWindow, l.disclosureGrace, l.revealWindow]).toEqual([14n * DAY, 72n * HOUR, 48n * HOUR, 7n * DAY]);
  expect([...l.allowlist]).toEqual([stack.accounts.hunter]);
  expect(l.valueAtRiskUsd).toBe(1250000n);
  expect([...l.knownIssueIds]).toEqual([`0x${knownIssueId.slice('sha256:'.length)}`]);
  expect(l.escrowWei).toBe(2n * ETH);
});

test('a deployed contract listed with a 0-day fix window and the shortest D8 windows', async ({ page, chain }) => {
  const { recipient } = await generateAndSaveKey(page);
  await fillListing(page, {
    ...repoTerms(),
    kind: 'contract',
    address: '0x5f2a00000000000000000000000000000000c0de',
    chainId: 8453,
    windows: { fix: 0, grace: 0, dispute: 24, reveal: 3 },
  });
  await validate(page, 'ready');
  const listingId = await listAndFund(page);

  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.artifactKind).toBe(1n);
  expect(l.artifactAddress.toLowerCase()).toBe('0x5f2a00000000000000000000000000000000c0de');
  expect(l.artifactChainId).toBe(8453n);
  expect(l.disclosureKey).toBe(bytes32Of(recipient));
  expect([l.fixWindow, l.disputeWindow, l.disclosureGrace, l.revealWindow]).toEqual([0n, 24n * HOUR, 0n, 3n * DAY]);
  expect([...l.allowlist]).toEqual([]);
});

test('a version listed but not funded is funded later from its own page, and listing it again points there', async ({ page, chain }) => {
  const terms = repoTerms();
  await generateAndSaveKey(page);
  await fillListing(page, terms);
  await validate(page, 'ready');
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  const listed = page.getByTestId('listed');
  await expect(listed).toBeVisible({ timeout: 30_000 });
  const listingId = BigInt(await listed.getAttribute('data-listing-id'));
  await expect(page.getByRole('link', { name: fill(STRINGS.chain.fundPage, { id: listingId }) })).toBeVisible();

  // the maker leaves before funding; the page's state is gone
  await page.reload();
  await generateAndSaveKey(page);
  await fillListing(page, terms);
  await validate(page, 'ready');
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  await expect(page.getByTestId('existing-listing')).toContainText(fill(STRINGS.chain.existingListed, { id: listingId }));
  expect((await chain.sa.getListing(listingId)).state).toBe(0n); // still Listed: no second list()
  await page.getByRole('link', { name: fill(STRINGS.chain.fundPage, { id: listingId }) }).click();

  await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Listed);
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.escrowWei).toBe(2n * ETH);
  await shot(page, 'listing-funded-from-its-page');
  await page.reload();
  await expect(page.getByText(new RegExp(`^Listing ${listingId} is open until `))).toBeVisible();
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
});

test('a read that fails after fund() is mined never offers a second payment', async ({ page, chain }) => {
  await generateAndSaveKey(page);
  await fillListing(page, repoTerms());
  await validate(page, 'ready');
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  const listed = page.getByTestId('listed');
  await expect(listed).toBeVisible({ timeout: 30_000 });
  const listingId = BigInt(await listed.getAttribute('data-listing-id'));
  await page.evaluate(() => window.__testWallet.failCallsAfterNextSend(5));
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByTestId('opened')).toHaveText(new RegExp(`^Listing ${listingId} is open \\(transaction 0x[0-9a-f]{64}\\)`));
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.escrowWei).toBe(2n * ETH);
});

/** list() through the page, without fund(); returns the listing id. */
async function listOnly(page) {
  await generateAndSaveKey(page);
  await fillListing(page, repoTerms());
  await validate(page, 'ready');
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  const listed = page.getByTestId('listed');
  await expect(listed).toBeVisible({ timeout: 30_000 });
  return BigInt(await listed.getAttribute('data-listing-id'));
}

test('a listing page left open in another tab cannot pay a second escrow', async ({ page, context, stack, chain }) => {
  const listingId = await listOnly(page);
  const other = await context.newPage();
  await installWallet(other, stack);
  await other.goto(`/#/fund/${listingId}`);
  await expect(other.getByRole('button', { name: STRINGS.chain.fund })).toBeVisible();

  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
  // the other tab still shows the listing waiting to open; funding it again sends nothing
  await other.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(other.getByRole('alert')).toContainText(/^Nothing was sent: listing \d+ on the site's chain is not the one this page shows, or it is no longer waiting to open \(it is open\)/);
  await expect(other.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
  expect((await chain.sa.getListing(listingId)).escrowWei).toBe(2n * ETH);
});

test('the listing page reads and funds on the site\'s chain only, and reads again when the wallet comes back', async ({ page, chain }) => {
  const listingId = await listOnly(page);
  await page.goto(`/#/fund/${listingId}`);
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toBeVisible();
  await page.evaluate(() => window.__testWallet.setChain(1));
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByText(fill(STRINGS.wallet.wrongChain, { actual: 1, expected: 31337 })).first()).toBeVisible();
  expect((await chain.sa.getListing(listingId)).state).toBe(0n); // nothing was sent

  await page.evaluate(() => window.__testWallet.setChain(31337));
  await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Listed);
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
  expect((await chain.sa.getListing(listingId)).state).toBe(State.Open);
});

test('a listing the builder refuses shows the validation report and offers nothing to list', async ({ page, stack }) => {
  setBuilderMode(stack, 'refused-source');
  try {
    await generateAndSaveKey(page);
    const terms = repoTerms();
    await fillListing(page, { ...terms, kind: 'contract', address: '0x5f2a00000000000000000000000000000000c0de', chainId: 8453 });
    await validate(page, 'refused');
    const report = page.getByRole('region', { name: STRINGS.report.title });
    await expect(report).toContainText(fill(STRINGS.report.status, { status: 'refused' }));
    await expect(page.getByTestId('report-step-verifiedSource')).toHaveText(fill(STRINGS.report.step, { name: STRINGS.report.stepNames.verifiedSource, status: 'failed' }));
    await expect(report.getByRole('list', { name: STRINGS.report.refusals })).toContainText('BYTECODE_MISMATCH');
    await expect(page.getByRole('button', { name: STRINGS.chain.list })).toHaveCount(0);
    await shot(page, 'listing-refused-by-builder');
    // the maker can go back to the form, which kept what they entered
    await page.getByRole('button', { name: STRINGS.listing.again }).click();
    await expect(field(page, F.baseCommit)).toHaveValue(terms.baseCommit);
  } finally {
    setBuilderMode(stack, 'accepted');
  }
});
