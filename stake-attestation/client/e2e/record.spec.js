// Acceptance 1 (node P6b): the record page shows design §4.1's fields (artifact, stake, history,
// lineage, later findings), the labels and the bad-disclosure flags, from the server's mirror of
// recordByHash; the badge is embedded with its Markdown and HTML; the diligence text (§4, §15)
// is on the page; and nothing the page renders holds a banned word or a judgemental phrase.
//
// One version's whole life on the in-process chain: a valid HIGH finding, a flagged claim
// judged INVALID, a duplicate, a roll forward to a fixed version, and a late finding after it.
// The site's keeper finalizes and settles each round, as it does in production (erratum E4).
import { STRINGS, fill } from '../src/strings.js';
import { archiveBytes, disclosure, expect, shot, test } from './support/fixtures.js';
import { wordingProblems } from './support/wording.js';

const R = STRINGS.record;
const STAKE = { fixWindowDays: 1, disclosureGraceHours: 24, disputeWindowHours: 24, revealWindowDays: 3 };
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

async function recordFromServer(stack, hash) {
  const res = await fetch(`${stack.apiUrl}/api/records/${hash}`);
  return res.ok ? res.json() : null;
}

test('a version\'s record: stake, labels, history, findings, flags, lineage, later findings and the badge', async ({ page, stack, chain }) => {
  test.setTimeout(300_000);
  const key = disclosure.generateDisclosureKeyPair();
  const maker = await chain.as(stack.accounts.maker);
  // five times the top award, so the HIGH payout leaves it open (not depleted) for the claims after it
  const first = await chain.openListing({ recipient: key.recipient, stake: STAKE, escrow: 5n * 10n ** 18n });
  const id = first.listingId;

  // a valid HIGH finding, settled after the dispute window
  const high = await chain.revealedClaim({ listingId: id, recipient: key.recipient, label: 'high' });
  await chain.verdict(high.claimId, 'HIGH');
  await chain.judged(high.claimId);
  await chain.settledAfter(high.claimId);
  // a claim the maker flagged as a bad disclosure, then released; judged INVALID
  const flagged = await chain.claim({ listingId: id, archive: archiveBytes('flagged'), recipient: key.recipient });
  await (await maker.flagBadDisclosure(flagged.claimId)).wait();
  await (await maker.release(flagged.claimId)).wait();
  await chain.reveal(flagged);
  await chain.verdict(flagged.claimId, 'INVALID');
  await chain.judged(flagged.claimId);
  await chain.settledAfter(flagged.claimId);
  // a duplicate
  const dup = await chain.revealedClaim({ listingId: id, recipient: key.recipient, label: 'duplicate' });
  await chain.verdict(dup.claimId, 'DUPLICATE');
  await chain.judged(dup.claimId);
  await chain.settledAfter(dup.claimId);
  // the fixed version, listed and funded, and the stake rolled forward to it
  const second = await chain.openListing({ recipient: key.recipient, stake: STAKE });
  await (await maker.rollForward(id, second.listingId)).wait();
  // found later: a late claim on the rolled version, judged LOW
  const late = await chain.revealedClaim({ listingId: id, recipient: key.recipient, label: 'late', late: true });
  await chain.verdict(late.claimId, 'LOW');
  await chain.judged(late.claimId);
  await chain.settledAfter(late.claimId);

  // the site's indexer has it all
  await chain.until(async () => {
    const r = await recordFromServer(stack, first.artifactHash);
    return r?.record.findings.length === 2 && r.record.listings[0].state === 'Rolled';
  }, { what: 'the record mirror' });

  const listing = await chain.sa.getListing(id);
  const highClaim = await chain.sa.getClaim(high.claimId);
  const flaggedClaim = await chain.sa.getClaim(flagged.claimId);
  const commit = first.view.list.params.artifact.baseCommit;

  await page.goto(`/#/record/${first.artifactHash}`);
  await expect(page.getByRole('heading', { name: R.title, level: 2 })).toBeVisible();

  // the artifact
  await expect(page.getByTestId('record-hash')).toHaveText(first.artifactHash.toLowerCase());
  await expect(page.getByTestId('record-kind')).toHaveText(STRINGS.enums.kinds.Repo);
  await expect(page.getByTestId('record-repo')).toHaveText('https://github.com/acme/vault');
  await expect(page.getByTestId('record-commit')).toHaveText(commit);
  await expect(page.getByTestId('record-listing-count')).toHaveText('1');

  // the stake, its labels and its lineage
  const s = (f) => page.getByTestId(`listing-${id}-${f}`);
  await expect(s('state')).toHaveText(STRINGS.enums.listingStates.Rolled);
  await expect(s('labels')).toHaveText(STRINGS.labels['under-staked']);
  await expect(s('awards')).toHaveText(fill(R.awardsLine, { LOW: '0', MEDIUM: '0.1', HIGH: '0.4', CRITICAL: '2' }));
  await expect(s('lowest')).toHaveText('MEDIUM');
  await expect(s('bond')).toHaveText(fill(R.eth, { eth: '0.02' }));
  await expect(s('escrow')).toHaveText(fill(R.eth, { eth: '4.6' }));
  await expect(s('value-at-risk')).toHaveText(fill(R.usd, { usd: '1,250,000' }));
  await expect(s('share')).toHaveText(fill(R.share, { usd: '4,840', share: '0.38' }));
  await expect(s('opened')).toHaveText(at(listing.openedAt));
  await expect(s('funded-until')).toHaveText(at(listing.fundedUntil));
  await expect(s('rolled')).toHaveText(at(listing.rolledAt));
  await expect(s('successor')).toHaveText(fill(R.lineageLine, { id: second.listingId, hash: second.artifactHash.toLowerCase() }));
  await expect(s('predecessor')).toHaveText(R.none);

  // the history
  const h = (f) => page.getByTestId(`history-${f}`);
  await expect(h('claims')).toHaveText('3');
  await expect(h('judged')).toHaveText('3');
  await expect(h('pending')).toHaveText('0');
  for (const [outcome, count] of [['INVALID', 1], ['DUPLICATE', 1], ['LOW', 0], ['MEDIUM', 0], ['HIGH', 1], ['CRITICAL', 0]]) {
    await expect(page.getByTestId('history-verdicts')).toContainText(fill(R.verdictLine, { outcome, count }));
  }
  await expect(h('duplicates')).toHaveText('1');
  await expect(h('released')).toHaveText('3');
  await expect(h('disputes')).toHaveText('0');
  await expect(h('days-since')).toHaveText('0');

  // the valid finding, the later one, the flag
  const finding = page.getByTestId(`finding-${high.claimId}`);
  await expect(finding).toContainText('HIGH');
  await expect(finding).toContainText(fill(R.eth, { eth: '0.4' }));
  await expect(finding).toContainText(at(highClaim.revealedAt));
  await expect(finding).toContainText(high.bcid);
  await expect(page.getByTestId('record-findings')).not.toContainText(String(late.bcid));
  await expect(page.getByTestId(`late-finding-${late.claimId}`)).toContainText('LOW');
  await expect(page.getByTestId('later-claims')).toHaveText('1');
  await expect(page.getByTestId('later-verdicts')).toContainText(fill(R.verdictLine, { outcome: 'LOW', count: 1 }));
  const flag = page.getByTestId(`flag-${flagged.claimId}`);
  await expect(flag).toContainText(at(flaggedClaim.disclosedAt));
  await expect(flag).toContainText(STRINGS.enums.claimStates.Settled);
  await expect(flag).toContainText(fill(R.judgedLine, { outcome: 'INVALID', time: at(flaggedClaim.judgedAt) }));
  // the duplicate and the INVALID claim are counts, never published as findings
  await expect(page.getByTestId('record-findings')).not.toContainText(dup.bcid);
  await expect(page.getByTestId('record-findings')).not.toContainText(flagged.cid);

  // what a record means, and the placeholders behind the labels
  await expect(page.getByRole('heading', { name: STRINGS.diligence.title })).toBeVisible();
  await expect(page.getByTestId('diligence')).toContainText(STRINGS.diligence.readings[2]);
  await expect(page.getByText(STRINGS.labels.placeholders)).toBeVisible();

  const text = await page.locator('main').innerText();
  expect(wordingProblems(text)).toEqual([]);
  await shot(page, 'record-page');

  // the successor's record links back, and its badge states the live stake
  await page.getByTestId(`listing-${id}-successor`).getByRole('link').click();
  await expect(page.getByTestId('record-hash')).toHaveText(second.artifactHash.toLowerCase());
  await expect(page.getByTestId(`listing-${second.listingId}-predecessor`)).toHaveText(fill(R.lineageLine, { id, hash: first.artifactHash.toLowerCase() }));
  await expect(page.getByTestId(`listing-${second.listingId}-state`)).toHaveText(STRINGS.enums.listingStates.Open);

  const badge = page.getByTestId('badge');
  await expect(badge).toBeVisible();
  await expect.poll(() => badge.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  const svgUrl = `${origin}/api/records/${second.artifactHash.toLowerCase()}/badge.svg`;
  const pageUrl = `${origin}/#/record/${second.artifactHash.toLowerCase()}`;
  await expect(page.getByTestId('badge-markdown')).toHaveValue(`[![${STRINGS.badge.alt}](${svgUrl})](${pageUrl})`);
  await expect(page.getByTestId('badge-html')).toHaveValue(`<a href="${pageUrl}"><img src="${svgUrl}" alt="${STRINGS.badge.alt}"></a>`);
  const svg = await (await page.request.get(svgUrl)).text();
  expect(svg).toContain('no finding at or above MEDIUM while staked · under-staked');
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'record-badge', { target: page.getByTestId('badge-panel') });

  // the rolled version's badge says how its stake ended
  const ended = await (await page.request.get(`${origin}/api/records/${first.artifactHash.toLowerCase()}/badge.svg`)).text();
  expect(ended).toContain('stake rolled forward');
});

test('a hash with no opened listing has no record, and a malformed one is refused before any request', async ({ page }) => {
  const unknown = `0x${'ab'.repeat(32)}`;
  await page.goto(`/#/record/${unknown}`);
  await expect(page.getByText(fill(R.notFound, { hash: unknown }))).toBeVisible();
  await page.goto('/#/record');
  await page.getByLabel(R.hash, { exact: true }).fill('0x1234');
  await page.getByRole('button', { name: R.load }).click();
  await expect(page.getByText(R.badHash)).toBeVisible();
});
