// Acceptance 1 (node P6a): the maker's listing flow. Artifact, scope, award table, lowest class
// counted, bond, windows (defaults 14/30 d, 72 h, 48 h, 7 d; a 0-day fix window allowed; the
// decision D8 bounds), allowlist, known-issues editor and value at risk; validated through the
// real server (its builder stubbed by the server's own fake builder CLI); the validation report
// shown; list() and fund() sent through the wallet to StakeAttestation on local Hardhat.
import common from '@verdikta/common';

import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, installWallet, setBuilderMode, shot, test } from './support/fixtures.js';
import { awardField, field, fillListing, generateAndSaveKey, listAndFund, repoTerms, signDeployment, validate } from './support/listingForm.js';

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

test('the form holds the D8 bounds, and a 0-day fix window is allowed with no grace', async ({ stack, page }) => {
  const submit = page.getByRole('button', { name: STRINGS.listing.submit });
  await fillListing(page, await repoTerms(stack));
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

// Node P19 (owner, 2026-11-10, Q73 #5): what a known issue settles as, and how a maker marks a behaviour as no bug.
test('the known-issues fields say a listed root cause settles DUPLICATE, and how to mark a behaviour as no bug at all', async ({ page }) => {
  const known = page.getByRole('group', { name: STRINGS.listing.sections.knownIssues, exact: true });
  await expect(known.getByText(STRINGS.listing.hints.knownIssues)).toBeVisible();
  await expect(known.getByText(STRINGS.listing.hints.knownIssuesIntended)).toBeVisible();
});

// Node P20 (owner decision Q61 (a); Q73 #5): the documents field. Each line is checked in the browser with common's
// documentGlobProblem and shown by common's code; the help says what to name and that documents never widen the scope.
test('the documents field: a line common refuses shows its code and holds the form; a listing that names documents validates', async ({ page, stack }) => {
  const docs = page.getByRole('group', { name: STRINGS.listing.sections.documents, exact: true });
  await expect(docs.getByText(STRINGS.listing.hints.documents)).toBeVisible();
  const submit = page.getByRole('button', { name: STRINGS.listing.submit });
  await fillListing(page, await repoTerms(stack));
  await generateAndSaveKey(page);
  await expect(submit).toBeEnabled();
  await field(page, F.documents).fill('README.md\n./docs/**\nREADME.md');
  await expect(docs).toContainText('STAKE_DOCUMENT_NOT_PLAIN');
  await expect(docs).toContainText('STAKE_DOCUMENT_DUPLICATE');
  await expect(submit).toBeDisabled();
  await field(page, F.documents).fill('README.md\ndocs/**');
  await expect(docs).not.toContainText('STAKE_DOCUMENT_');
  await validate(page, 'ready');
  await expect(page.getByTestId('report-step-documents')).toHaveText(fill(STRINGS.report.step, { name: STRINGS.report.stepNames.documents, status: 'ok' }));
  await expect(page.getByRole('region', { name: STRINGS.report.documentsTitle })).toContainText('README.md');
});

test('a maker lists and funds a repository version: server validation, report, list() and fund()', async ({ page, stack, chain }) => {
  const { recipient } = await generateAndSaveKey(page);
  // HIGH below MEDIUM: the client leaves the award rules to the server, which refuses them
  const terms = await repoTerms(stack);
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

test('a deployed contract listed with a 0-day fix window and the shortest D8 windows', async ({ stack, page, chain }) => {
  const { recipient } = await generateAndSaveKey(page);
  await fillListing(page, {
    ...await repoTerms(stack),
    kind: 'contract',
    address: stack.ownedContract,
    chainId: stack.chainId,
    windows: { fix: 0, grace: 0, dispute: 24, reveal: 3 },
  });
  await signDeployment(page, stack);
  await validate(page, 'ready');
  const listingId = await listAndFund(page);

  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.artifactKind).toBe(1n);
  expect(l.artifactAddress).toBe(stack.ownedContract);
  expect(l.artifactChainId).toBe(BigInt(stack.chainId));
  expect(l.disclosureKey).toBe(bytes32Of(recipient));
  expect([l.fixWindow, l.disputeWindow, l.disclosureGrace, l.revealWindow]).toEqual([0n, 24n * HOUR, 0n, 3n * DAY]);
  expect([...l.allowlist]).toEqual([]);
});

test('a version listed but not funded is funded later from its own page, and listing it again points there', async ({ stack, page, chain }) => {
  const terms = await repoTerms(stack);
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
  await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Open);
  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.escrowWei).toBe(2n * ETH);
  await shot(page, 'listing-funded-from-its-page');
  await page.reload();
  await expect(page.getByText(new RegExp(`^Listing ${listingId} is open until `))).toBeVisible();
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
});

test('list() is sent only from the wallet the listing was built for: from another it would not count', async ({ page, stack, chain }) => {
  await generateAndSaveKey(page);
  await fillListing(page, await repoTerms(stack));
  await validate(page, 'ready');
  const before = await chain.sa.listingCount();
  await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.other);
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  await expect(page.getByRole('alert')).toContainText('Nothing was sent');
  expect(await chain.sa.listingCount()).toBe(before);
});

test('a read that fails after fund() is mined never offers a second payment', async ({ stack, page, chain }) => {
  await generateAndSaveKey(page);
  await fillListing(page, await repoTerms(stack));
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
async function listOnly(page, stack) {
  await generateAndSaveKey(page);
  await fillListing(page, await repoTerms(stack));
  await validate(page, 'ready');
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  const listed = page.getByTestId('listed');
  await expect(listed).toBeVisible({ timeout: 30_000 });
  return BigInt(await listed.getAttribute('data-listing-id'));
}

test('a listing page left open in another tab cannot pay a second escrow', async ({ page, context, stack, chain }) => {
  const listingId = await listOnly(page, stack);
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

test('the listing page funds on the site\'s chain only', async ({ page, stack, chain }) => {
  const listingId = await listOnly(page, stack);
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

test('a wallet the page switches to the site\'s chain while funding keeps the funding on the page', async ({ page, stack, chain }) => {
  const listingId = await listOnly(page, stack);
  await page.goto(`/#/fund/${listingId}`);
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toBeVisible();
  await page.evaluate(() => window.__testWallet.setChain(1, { allowSwitch: true }));
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  // the switch emits chainChanged mid-action; the page stays, and so does what it is doing
  await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: STRINGS.chain.fund })).toHaveCount(0);
  const l = await chain.sa.getListing(listingId);
  expect(l.state).toBe(State.Open);
  expect(l.escrowWei).toBe(2n * ETH);
});

test('a listing page whose read failed can read again', async ({ page, stack }) => {
  const listingId = await listOnly(page, stack);
  const offline = (url) => url.href.startsWith(stack.rpcUrl);
  await page.route(offline, (route) => route.abort());
  await page.goto(`/#/fund/${listingId}`);
  await expect(page.getByText(/^The listing could not be read: /)).toBeVisible();
  await page.unroute(offline);
  await page.getByRole('button', { name: STRINGS.fund.retry }).click();
  await expect(page.getByTestId('listing-summary')).toContainText(STRINGS.fund.states.Listed);
});

test('a listing the builder refuses shows the validation report and offers nothing to list', async ({ page, stack }) => {
  setBuilderMode(stack, 'refused-source');
  try {
    await generateAndSaveKey(page);
    const terms = await repoTerms(stack);
    await fillListing(page, { ...terms, kind: 'contract', address: stack.ownedContract, chainId: stack.chainId });
    await signDeployment(page, stack);
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
