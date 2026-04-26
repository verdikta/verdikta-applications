import { expect, test } from '@playwright/test';

test('home page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Bounties/);
  await expect(page.getByRole('heading', { name: 'AI-Powered Bounty Program' })).toBeVisible();
});

test('initial load does not auto-scroll past the hero', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // The hero should still be in view — no rogue scrollIntoView should have run.
  // (Regression: a one-shot useRef guard didn't survive StrictMode's
  // double-invoked effects, so the pagination scroll fired on mount.)
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50);
  await expect(page.getByRole('heading', { name: 'AI-Powered Bounty Program' })).toBeInViewport();
});
