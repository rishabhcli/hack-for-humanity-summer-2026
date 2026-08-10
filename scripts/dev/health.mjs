import { acquireLifecycleLock, formatErrorChain, runPreflight, waitForHealth } from './lib.mjs';

let releaseLifecycleLock = null;
try {
  releaseLifecycleLock = acquireLifecycleLock('health', 120_000);
  const { definitions } = runPreflight();
  const results = await Promise.all(definitions.map((definition) => waitForHealth(definition)));
  for (const result of results) {
    console.log(
      `dev:health ready service=${result.service} port=${result.port} status=${result.status}`,
    );
  }
} catch (error) {
  console.error(formatErrorChain(error));
  process.exitCode = 1;
} finally {
  releaseLifecycleLock?.();
}
