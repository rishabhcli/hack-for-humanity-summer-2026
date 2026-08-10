import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, expect, test as base, type BrowserContext, type Page } from '@playwright/test';

import { localCertificateSpkiArgument } from './local-certificate';

type WorkerFixtures = {
  persistentContext: BrowserContext;
};

export const test = base.extend<{ page: Page }, WorkerFixtures>({
  page: async ({ persistentContext }, use) => {
    const existingPage = persistentContext.pages()[0];
    const page = existingPage ?? (await persistentContext.newPage());
    await use(page);
  },
  persistentContext: [
    async ({ browserName }, use, workerInfo) => {
      if (browserName !== 'chromium') {
        throw new Error(`PERSISTENT_PROFILE_BROWSER_UNSUPPORTED browser=${browserName}`);
      }
      const projectName = workerInfo.project.name.replace(/[^a-zA-Z0-9_-]/gu, '-');
      const userDataDirectory = resolve(
        '.dev',
        'pw-profile',
        `${projectName}-worker-${String(workerInfo.parallelIndex)}`,
      );
      // Clear only this worker's profile so a prior run cannot supply a stale
      // service worker or cache and make the offline assertion falsely green.
      rmSync(userDataDirectory, { force: true, recursive: true });
      mkdirSync(userDataDirectory, { recursive: true });
      const context = await chromium.launchPersistentContext(userDataDirectory, {
        args: [localCertificateSpkiArgument()],
        headless: true,
        ignoreHTTPSErrors: true,
        serviceWorkers: 'allow',
      });
      try {
        await use(context);
      } finally {
        await context.close();
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
