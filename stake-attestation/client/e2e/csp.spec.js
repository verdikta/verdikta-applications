// The deploy kit's headers on the built client (node P23). Under playwright.csp.config.js the stack serves the
// production build with the headers of deploy/nginx/verifiers.verdikta.org-headers.conf, the file nginx includes, and
// every other spec's flows then run under them: e2e/support/fixtures.js fails a test on any violation. These check the
// headers are really there, that the policy served is the include file's (its off-origin sources, the RPC endpoint and
// each gateway of deploy/client.env, mapped to this stack's stand-ins, and a report-uri for this run added; nothing
// else changed), and that a violation is seen when one happens, so a quiet run means something.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapConnectSources, parseCsp, parseEnvFile, parseHeaderInclude } from '@verdikta/stake-attestation-shared/deploy-kit';

import { parseGateways } from '../src/config.js';
import { expect, test } from './support/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(here, '..', '..', 'deploy');
const HEADERS = parseHeaderInclude(fs.readFileSync(path.join(DEPLOY, 'nginx', 'verifiers.verdikta.org-headers.conf'), 'utf8'));
const CLIENT_ENV = parseEnvFile(fs.readFileSync(path.join(DEPLOY, 'client.env'), 'utf8'));
const REPORTS = path.resolve(here, '..', '.e2e', 'csp-reports.json');
const origin = (u) => new URL(u).origin;

test.describe('the deploy kit\'s headers', () => {
  test.skip(({ csp }) => !csp, 'runs under playwright.csp.config.js, with the kit\'s headers');

  const KIT_GATEWAYS = parseGateways(CLIENT_ENV.get('VITE_IPFS_GATEWAY'));
  /** The policy this stack must serve, worked out here from the include file and deploy/client.env. */
  const expected = (stack) => `${mapConnectSources(HEADERS.find((h) => h.name === 'Content-Security-Policy').value, {
    [origin(CLIENT_ENV.get('VITE_SA_RPC_URL'))]: origin(stack.rpcUrl),
    ...Object.fromEntries(KIT_GATEWAYS.map((g, i) => [g, origin(stack.gatewayUrls[i])])),
  })}; report-uri /__csp-report`;

  test('the policy served is the include file\'s, with only the off-origin sources mapped to this stack', async ({ stack }) => {
    expect(stack.csp.policy).toBe(expected(stack));
  });

  test('each gateway of deploy/client.env has a stand-in of its own, in order, and the build asks exactly those', async ({ stack }) => {
    expect(KIT_GATEWAYS.length).toBeGreaterThan(0);
    expect(stack.gatewayUrls).toHaveLength(KIT_GATEWAYS.length);
    expect(new Set(stack.gatewayUrls.map(origin)).size).toBe(KIT_GATEWAYS.length);
    const connect = new Map(parseCsp(stack.csp.policy)).get('connect-src');
    expect(connect).toEqual(["'self'", origin(stack.rpcUrl), ...stack.gatewayUrls.map(origin)]);
  });

  test('the page, an asset, an API answer and a 404 all carry every header of the include file', async ({ request, stack }) => {
    const page = await request.get('/');
    expect(page.status()).toBe(200);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(await page.text())?.[1];
    expect(asset, 'the build\'s entry script').toBeTruthy();
    const answers = { '/': page, [asset]: await request.get(asset), '/api/feed': await request.get('/api/feed'), '/nothing-here': await request.get('/nothing-here') };
    expect(answers['/nothing-here'].status()).toBe(404);
    for (const [where, res] of Object.entries(answers)) {
      for (const h of HEADERS) {
        const want = h.name === 'Content-Security-Policy' ? stack.csp.policy : h.value;
        expect(res.headers()[h.name.toLowerCase()], `${where}: ${h.name}`).toBe(want);
      }
    }
  });

  test('a violation is seen: an inline script is refused, raises the event and reaches the report endpoint', async ({ page, cspWatch }) => {
    await page.goto('/?csp-control=inline');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.head.append(s);
    });
    // the event and the console's line both: then nothing of this one arrives after it is cleared
    await expect.poll(() => cspWatch.violations.some((v) => v.directive === 'script-src-elem') && cspWatch.violations.some((v) => v.console)).toBe(true);
    expect(await page.evaluate(() => window.__inlineRan)).toBeUndefined();
    await expect.poll(() => reports().some((r) => /csp-control=inline/.test(r['document-uri'] ?? '')), { timeout: 10_000 }).toBe(true);
    cspWatch.violations.length = 0; // made on purpose
  });

  test('a fetch to an origin connect-src does not name is refused', async ({ page, cspWatch }) => {
    await page.goto('/?csp-control=connect');
    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://example.invalid/');
        return 'fetched';
      } catch {
        return 'refused';
      }
    });
    expect(outcome).toBe('refused');
    await expect.poll(() => cspWatch.violations.some((v) => v.directive === 'connect-src') && cspWatch.violations.some((v) => v.console)).toBe(true);
    cspWatch.violations.length = 0; // made on purpose
  });
});

function reports() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS, 'utf8'));
  } catch {
    return [];
  }
}
