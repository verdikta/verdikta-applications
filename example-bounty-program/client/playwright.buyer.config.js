import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: ['buyer-preview.spec.js', 'create-import.spec.js', 'create-failure.spec.js', 'home.spec.js', 'header.spec.js', 'skills.spec.js'],
  use: { baseURL: 'http://127.0.0.1:5191' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node tests/e2e/start-buyer-server.mjs', url: 'http://127.0.0.1:5191/agents', reuseExistingServer: false },
});
