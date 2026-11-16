import { defineConfig, devices } from '@playwright/test';

// The tests run against the production build, served by `vite preview` on 5176, in front of a
// local stack that e2e/support/stack.mjs starts as the web server: StakeAttestation on the
// in-process Hardhat network behind a JSON-RPC server, the real API server with its builder
// stubbed by the server's own fake builder CLI, and an IPFS gateway stand-in for each gateway of
// ../deploy/client.env (the build asks them in order). One worker: the
// tests share one chain, and some move its clock.
const PORT = 5176;

export default defineConfig({
  testDir: './e2e',
  // test-results/screenshots holds the PR's screenshots (SA_SCREENSHOTS=1); Playwright's own
  // output, which it empties on every run, goes beside it
  outputDir: './test-results/run',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/support/stack.mjs',
    url: `http://127.0.0.1:${PORT}`,
    // the stack is made per run (a fresh chain, its addresses built into the client), never reused
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
