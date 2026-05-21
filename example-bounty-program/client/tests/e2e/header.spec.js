import { expect, test } from '@playwright/test';

test.describe('mobile header', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('hamburger toggles the nav drawer', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.menu-toggle');
    await expect(toggle).toBeVisible();
    // Drawer hidden initially.
    await expect(page.locator('.header-collapsible.is-open')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Browse' })).toBeHidden();

    await toggle.click();
    await expect(page.locator('.header-collapsible.is-open')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Browse' })).toBeVisible();

    // Closes on Escape.
    await page.keyboard.press('Escape');
    await expect(page.locator('.header-collapsible.is-open')).toHaveCount(0);
  });

  test('drawer closes on route change', async ({ page }) => {
    await page.goto('/');
    await page.locator('.menu-toggle').click();
    await page.getByRole('link', { name: 'Agents' }).click();
    await page.waitForURL('**/agents');
    await expect(page.locator('.header-collapsible.is-open')).toHaveCount(0);
  });
});

test.describe('desktop header', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('hamburger is hidden; nav is inline', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.menu-toggle')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Browse' })).toBeVisible();
  });
});
