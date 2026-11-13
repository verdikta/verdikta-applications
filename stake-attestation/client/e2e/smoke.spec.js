// Smoke test: the production build serves, renders the home page and logs no errors.
import { test, expect } from '@playwright/test';
import { STRINGS } from '../src/strings.js';

test('home page renders from the production build', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('/');
  await expect(page).toHaveTitle(STRINGS.appName);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(STRINGS.appName);
  await expect(page.getByText(STRINGS.home.recordNote)).toBeVisible();
  expect(errors).toEqual([]);
});

// Node P27: an agent that opens the site finds what to read, and following the link gets the document itself.
test('the home page links the agents\' documents, and the build serves both', async ({ page, request }) => {
  await page.goto('/');
  for (const href of [STRINGS.footer.guide, STRINGS.footer.index]) {
    const link = page.getByRole('link', { name: href, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', href);
    const res = await request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(/^# Verdikta stake attestation/);
  }
  await expect(page.getByText(STRINGS.footer.lead, { exact: true })).toBeVisible();
});
