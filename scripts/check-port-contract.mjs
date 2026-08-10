import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPOSITORY_ROOT, readPorts } from './dev/lib.mjs';

const ports = readPorts();

/** @param {string} path @param {string[]} required @returns {void} */
function requireText(path, required) {
  const contents = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
  for (const value of required) {
    if (!contents.includes(value)) {
      throw new Error(`PORT_CONTRACT_DRIFT path=${path} expected=${value}`);
    }
  }
  if (/127\.0\.0\.1:(?:4173|5173)/u.test(contents)) {
    throw new Error(`PORT_CONTRACT_FRAMEWORK_DEFAULT path=${path}`);
  }
}

requireText('playwright.config.ts', [
  `baseURL: 'https://127.0.0.1:${String(ports.PORT_2)}'`,
  `url: 'https://127.0.0.1:${String(ports.PORT_2)}/livez'`,
]);
requireText('vite.config.ts', [
  `process.env['DEV_SERVICE_PORT'] ?? '${String(ports.PORT_0)}'`,
  `port: ${String(ports.PORT_1)}`,
  `port: ${String(ports.PORT_0)}`,
]);
requireText('tests/e2e/readiness.spec.ts', [
  `https://127.0.0.1:${String(ports.PORT_0)}`,
  `https://127.0.0.1:${String(ports.PORT_2)}`,
]);
requireText('tests/e2e/pwa.spec.ts', [`https://127.0.0.1:${String(ports.PORT_1)}`]);

console.log(
  `port-contract current pwa=${String(ports.PORT_0)} preview=${String(ports.PORT_1)} playwright=${String(ports.PORT_2)} fixtures=${String(ports.PORT_3)}`,
);
