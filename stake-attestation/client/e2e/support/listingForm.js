// Filling the listing form the way a maker does, by its labels (src/strings.js).
import crypto from 'node:crypto';
import fs from 'node:fs';

import { expect } from '@playwright/test';

import { STRINGS, fill } from '../../src/strings.js';

const F = STRINGS.listing.fields;
export const field = (page, label) => page.getByLabel(label, { exact: true });
export const awardField = (page, cls) => field(page, fill(F.award, { class: cls }));

/**
 * A repository listing's terms, as the server's fixture draft has them, at a fresh commit: a
 * maker has one listing per version that is not closed, and every test lists its own.
 */
export const repoTerms = () => ({
  kind: 'repo',
  repo: 'https://github.com/acme/vault',
  baseCommit: crypto.randomBytes(20).toString('hex'),
  include: 'src/**',
  exclude: 'test/**\nscript/**',
  awards: { LOW: '0', MEDIUM: '0.1', HIGH: '0.4', CRITICAL: '2' },
  lowest: 'MEDIUM',
  bond: '0.02',
});

/** Fills every field named in `t`; fields left out keep the form's defaults. */
export async function fillListing(page, t) {
  if (t.kind) await field(page, F.kind).selectOption(t.kind);
  if (t.repo !== undefined) await field(page, F.repo).fill(t.repo);
  if (t.baseCommit !== undefined) await field(page, F.baseCommit).fill(t.baseCommit);
  if (t.address !== undefined) await field(page, F.address).fill(t.address);
  if (t.chainId !== undefined) await field(page, F.chainId).fill(String(t.chainId));
  if (t.include !== undefined) await field(page, F.scopeInclude).fill(t.include);
  if (t.exclude !== undefined) await field(page, F.scopeExclude).fill(t.exclude);
  for (const [cls, v] of Object.entries(t.awards ?? {})) await awardField(page, cls).fill(v);
  if (t.lowest) await field(page, F.lowestClassCounted).selectOption(t.lowest);
  if (t.bond !== undefined) await field(page, F.bond).fill(t.bond);
  const w = t.windows ?? {};
  if (w.fix !== undefined) await field(page, F.fixWindowDays).fill(String(w.fix));
  if (w.dispute !== undefined) await field(page, F.disputeWindowHours).fill(String(w.dispute));
  if (w.grace !== undefined) await field(page, F.disclosureGraceHours).fill(String(w.grace));
  if (w.reveal !== undefined) await field(page, F.revealWindowDays).fill(String(w.reveal));
  if (t.allowlist !== undefined) await field(page, F.allowlist).fill(t.allowlist.join('\n'));
  for (const [i, k] of (t.knownIssues ?? []).entries()) {
    await page.getByRole('button', { name: STRINGS.listing.knownIssues.add }).click();
    const row = page.getByRole('group', { name: fill(STRINGS.listing.knownIssues.legend, { n: i + 1 }) });
    await row.getByLabel(STRINGS.listing.knownIssues.title, { exact: true }).fill(k.title);
    await row.getByLabel(STRINGS.listing.knownIssues.class, { exact: true }).selectOption(k.class);
    await row.getByLabel(STRINGS.listing.knownIssues.paths, { exact: true }).fill(k.paths.join('\n'));
    await row.getByLabel(STRINGS.listing.knownIssues.description, { exact: true }).fill(k.description);
  }
  if (t.valueAtRisk !== undefined) await field(page, F.valueAtRiskUsd).fill(String(t.valueAtRisk));
}

/**
 * Generates the disclosure key in the page, downloads the key file, reads both halves off the
 * page and confirms the private half is saved. Returns them for the test's own checks.
 */
export async function generateAndSaveKey(page) {
  await page.getByRole('button', { name: STRINGS.key.generate }).click();
  const recipient = await field(page, STRINGS.key.recipient).inputValue();
  const identity = await field(page, STRINGS.key.identity).inputValue();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: STRINGS.key.download }).click(),
  ]);
  const keyFile = fs.readFileSync(await download.path(), 'utf8');
  await page.getByRole('button', { name: STRINGS.key.saved }).click();
  await expect(page.getByText(STRINGS.key.gone)).toBeVisible();
  return { recipient, identity, keyFile, fileName: download.suggestedFilename() };
}

/** Sends the form to the server and waits for the listing to settle; returns the final status text. */
export async function validate(page, expected = 'ready') {
  await page.getByRole('button', { name: STRINGS.listing.submit }).click();
  await expect(page.getByTestId('listing-status')).toHaveText(
    fill(STRINGS.listing.status, { status: STRINGS.listing.statuses[expected] }),
    { timeout: 30_000 },
  );
}

/** list() then fund() through the wallet; returns the listing id the page reports. */
export async function listAndFund(page) {
  await page.getByRole('button', { name: STRINGS.chain.list }).click();
  const listed = page.getByTestId('listed');
  await expect(listed).toBeVisible({ timeout: 30_000 });
  const listingId = BigInt(await listed.getAttribute('data-listing-id'));
  await page.getByRole('button', { name: STRINGS.chain.fund }).click();
  await expect(page.getByTestId('opened')).toBeVisible({ timeout: 30_000 });
  return listingId;
}
