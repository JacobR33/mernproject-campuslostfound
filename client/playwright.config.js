import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  globalTeardown: './tests/e2e/teardown.cjs',
  use: {
    baseURL: 'https://localhost:5473',
    ignoreHTTPSErrors: true,
    channel: process.env.PW_CHANNEL || 'msedge',
    headless: true,
    timezoneId: 'America/New_York',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/serve.cjs',
    url: 'https://localhost:5473',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
