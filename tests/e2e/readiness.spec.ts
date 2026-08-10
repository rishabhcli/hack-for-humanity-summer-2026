import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { resolve } from 'node:path';

import { expect, test } from './fixtures';

function requestPrivateRuntimePath(path: string): Promise<{ body: string; status: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handle = request(
      new URL(`https://127.0.0.1:4180${path}`),
      {
        ca: readFileSync(resolve('.dev', 'certs', 'localhost.pem')),
        method: 'GET',
        rejectUnauthorized: true,
        timeout: 5_000,
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: unknown) => {
          if (typeof chunk !== 'string') {
            rejectPromise(new Error('E2E_PRIVATE_PATH_RESPONSE_TYPE_INVALID'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolvePromise({
            body: chunks.join(''),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    handle.on('timeout', () => handle.destroy(new Error('E2E_PRIVATE_PATH_TIMEOUT')));
    handle.on('error', rejectPromise);
    handle.end();
  });
}

test('presents a truthful, keyboard-operable pre-measurement readiness state', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/not yet in production/i);
  await expect(page.getByRole('status')).toContainText('Not yet in production');
  await expect(page.getByRole('heading', { level: 2, name: /not a diagnosis/i })).toBeVisible();
  await expect(page.getByText(/No measurement is currently available/i)).toBeVisible();

  const runCheck = page.getByRole('button', { name: /run check/i });
  await runCheck.focus();
  await expect(runCheck).toBeFocused();
  await runCheck.press('Enter');

  await expect(page.getByText(/Local prerequisites are available/i)).toBeVisible();
  await expect(page.getByText('Secure context', { exact: true })).toBeVisible();
  await expect(page.getByText('Camera interface', { exact: true })).toBeVisible();
  await expect(page.getByText('Local session storage', { exact: true })).toBeVisible();
});

test('does not contact a third-party origin during the readiness workflow', async ({ page }) => {
  const contactedOrigins = new Set<string>();
  page.on('request', (request) => {
    contactedOrigins.add(new URL(request.url()).origin);
  });

  await page.goto('/');
  await page.getByRole('button', { name: /run check/i }).click();

  expect([...contactedOrigins]).toEqual(['https://127.0.0.1:4182']);
});

test('refuses browser access to every repository-private runtime namespace', async () => {
  const rawRecord: unknown = JSON.parse(readFileSync(resolve('.dev', 'pids', 'pwa.json'), 'utf8'));
  if (
    typeof rawRecord !== 'object' ||
    rawRecord === null ||
    !('ownershipToken' in rawRecord) ||
    typeof rawRecord.ownershipToken !== 'string' ||
    !('readinessSecret' in rawRecord) ||
    typeof rawRecord.readinessSecret !== 'string'
  ) {
    throw new Error('E2E_PWA_PID_RECORD_INVALID');
  }
  const privatePaths = [
    '/.dev/pids/pwa.json',
    '/.dev/logs/pwa.log',
    '/.dev/certs/localhost.pem',
    '/.dev/certs/localhost-key.pem',
    '/.dev/tmp/openssl.cnf',
    '/.dev/cache/npm/_update-notifier-last-checked',
    '/.dev/pw-profile/test-results/.last-run.json',
    '/%2e%64%65%76/pids/pwa.json',
    '/.dev%2fpids%2fpwa.json',
  ];

  for (const path of privatePaths) {
    const response = await requestPrivateRuntimePath(path);
    const leaked =
      response.body.includes(rawRecord.ownershipToken) ||
      response.body.includes(rawRecord.readinessSecret) ||
      response.body.includes('ownershipToken') ||
      response.body.includes('readinessSecret');
    expect([403, 404], `${path} status`).toContain(response.status);
    expect(leaked, `${path} secret-free response`).toBe(false);
  }
});
