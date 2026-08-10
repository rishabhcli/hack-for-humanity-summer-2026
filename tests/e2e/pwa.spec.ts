import { expect, test } from './fixtures';

test('serves an install manifest with descriptive, non-diagnostic metadata', async ({ page }) => {
  const response = await page.request.get('https://127.0.0.1:4181/manifest.webmanifest');
  expect(response.ok()).toBe(true);

  const manifest = (await response.json()) as Record<string, unknown>;
  expect(manifest['name']).toBe('Head repositioning measurement');
  expect(manifest['display']).toBe('standalone');
  expect(String(manifest['description'])).toContain('non-diagnostic');
});

test('keeps the truthful readiness surface available after the preview goes offline', async ({
  page,
}) => {
  await page.goto('https://127.0.0.1:4181/');
  const registration = await page.evaluate(async () => {
    const readyRegistration = await navigator.serviceWorker.ready;
    if (readyRegistration.active === null) {
      throw new Error('PWA_SERVICE_WORKER_NOT_ACTIVE');
    }
    return {
      scope: readyRegistration.scope,
      scriptURL: readyRegistration.active.scriptURL,
    };
  });
  expect(registration).toEqual({
    scope: 'https://127.0.0.1:4181/',
    scriptURL: 'https://127.0.0.1:4181/sw.js',
  });
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null),
    )
    .toBe('activated');

  // The first load installs the worker; a controlled online reload proves that
  // the fresh registration owns this document before the network is removed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .toBe('https://127.0.0.1:4181/sw.js');

  await page.context().setOffline(true);
  try {
    const offlineResponse = await page.reload({ waitUntil: 'domcontentloaded' });
    expect(offlineResponse).not.toBeNull();
    expect(offlineResponse?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole('status')).toContainText('Not yet in production');
    await expect(page.getByText(/No measurement is currently available/i)).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});
