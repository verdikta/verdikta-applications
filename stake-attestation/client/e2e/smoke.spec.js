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
