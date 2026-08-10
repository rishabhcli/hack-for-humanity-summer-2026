import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const repositoryRoot = import.meta.dirname;

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: true,
  fullyParallel: true,
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: resolve(repositoryRoot, '.dev/pw-profile/test-results'),
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: resolve(repositoryRoot, '.dev/pw-profile/report') }],
  ],
  retries: 0,
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'https://127.0.0.1:4182',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:up',
    cwd: repositoryRoot,
    ignoreHTTPSErrors: true,
    // run-e2e starts and authenticates the owned service first; globalSetup
    // repeats semantic health validation before a reused server can run tests.
    reuseExistingServer: true,
    timeout: 30_000,
    url: 'https://127.0.0.1:4182/livez',
  },
  ...(process.env['CI'] === 'true' ? { workers: 1 } : {}),
});
