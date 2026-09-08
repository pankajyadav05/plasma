import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './l1',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'ipc', testMatch: /.*\.spec\.ts/ }],
});
