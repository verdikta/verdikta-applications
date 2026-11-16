import { defineConfig } from '@playwright/test';

import base from './playwright.config.js';

// The client's Playwright flows again, under the deploy kit's headers (node P23; README "Running the site"):
// `npm run test:e2e:csp`. The stack (e2e/support/stack.mjs, with SA_E2E_CSP=1) serves the same production build
// through e2e/support/headerServer.mjs, which applies every header of
// ../deploy/nginx/verifiers.verdikta.org-headers.conf, the file nginx includes, to every answer. The policy's two
// off-origin sources (deploy/client.env's RPC endpoint and gateway) are mapped to this stack's stand-ins, and a
// report-uri is added so the run collects every report; nothing else of the policy changes. e2e/support/fixtures.js
// fails any test whose pages see a violation, and the teardown fails the run on any report from outside the control
// tests of e2e/csp.spec.js. A run of its own, after `npx playwright test`: both use port 5176.
export default defineConfig({
  ...base,
  outputDir: './test-results/csp-run',
  globalTeardown: './e2e/support/cspTeardown.mjs',
  use: { ...base.use, csp: true },
  webServer: { ...base.webServer, env: { SA_E2E_CSP: '1' } },
});
