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
    // the app's own link, in its footer (the shell's fallback, node P29, links the same paths until the app mounts)
    const link = page.locator('footer').getByRole('link', { name: href, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', href);
    const res = await request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(/^# Verdikta stake attestation/);
  }
  await expect(page.locator('footer').getByText(STRINGS.footer.lead, { exact: true })).toBeVisible();
});

// Node P29: a fetch of / that runs no JavaScript gets the shell, client/index.html, which names both documents in a
// fallback inside #root (test/agentDocsBuild.test.js holds it to that). The app's first render replaces the fallback,
// so once the app has mounted the page has the app's own footer link and nothing of the shell's.
test('the shell\'s fallback for agents is in / as served, and gone once the app mounts', async ({ page, request }) => {
  const shell = await request.get('/');
  expect(shell.status()).toBe(200);
  const html = await shell.text();
  expect(html).toContain('<div id="agents-fallback"');
  for (const href of [STRINGS.footer.guide, STRINGS.footer.index]) expect(html).toContain(`<a href="${href}">${href}</a>`);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(STRINGS.appName);
  await expect(page.locator('#agents-fallback')).toHaveCount(0);
  await expect(page.locator('#root noscript')).toHaveCount(0);
  for (const href of [STRINGS.footer.guide, STRINGS.footer.index]) {
    await expect(page.locator(`#root a[href="${href}"]`)).toHaveCount(1);
    await expect(page.locator('footer').getByRole('link', { name: href, exact: true })).toBeVisible();
  }
  await expect(page.locator('footer').getByText(STRINGS.footer.lead, { exact: true })).toBeVisible();
});
