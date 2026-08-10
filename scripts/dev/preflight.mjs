import { acquireLifecycleLock, formatErrorChain, runPreflight } from './lib.mjs';

let releaseLifecycleLock = null;
try {
  releaseLifecycleLock = acquireLifecycleLock('preflight', 120_000);
  const { definitions } = runPreflight();
  console.log(
    `dev:preflight ready repository=hack-for-humanity-summer-2026 services=${definitions.length} block=4180-4189 host=127.0.0.1`,
  );
} catch (error) {
  console.error(formatErrorChain(error));
  process.exitCode = 1;
} finally {
  releaseLifecycleLock?.();
}
