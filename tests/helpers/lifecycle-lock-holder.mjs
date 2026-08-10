import { acquireLifecycleLock } from '../../scripts/dev/lib.mjs';

const rawDurationMs = process.argv[2] ?? '';
const durationMs = Number.parseInt(rawDurationMs, 10);
if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 5_000) {
  throw new Error(`TEST_LOCK_DURATION_INVALID value=${rawDurationMs}`);
}

const release = acquireLifecycleLock('integration-lock-holder', 5_000);
process.stdout.write('lock-ready\n');

setTimeout(() => {
  release();
  process.stdout.write('lock-released\n');
}, durationMs);
