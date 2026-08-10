import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const verification = spawnSync('npm', ['run', 'verify-all'], {
  env: withRepositoryNpmCache(process.env),
  stdio: 'inherit',
});
if (verification.status !== 0) {
  console.error(`RELEASE_CHECK_REFUSED code=VERIFY_ALL_FAILED exit=${String(verification.status)}`);
  process.exit(verification.status ?? 1);
}

const gateEvidencePath = resolve('evidence', 'release-gates.json');
if (!existsSync(gateEvidencePath)) {
  console.error(
    'RELEASE_CHECK_REFUSED code=RELEASE_GATE_EVIDENCE_MISSING detail="No release gate is verified"',
  );
  process.exit(2);
}

const gateEvidence = JSON.parse(readFileSync(gateEvidencePath, 'utf8'));
/** @type {Array<{status: string}>} */
const gates = Array.isArray(gateEvidence.gates) ? gateEvidence.gates : [];
if (gates.length !== 6 || gates.some((gate) => gate.status !== 'passed')) {
  console.error(
    'RELEASE_CHECK_REFUSED code=RELEASE_GATES_NOT_GREEN detail="All six gates must pass from a clean checkout"',
  );
  process.exit(2);
}

console.error(
  'RELEASE_CHECK_REFUSED code=PRODUCTION_AUDIT_UNIMPLEMENTED detail="GOAL.md section 5 has not been independently verified"',
);
process.exit(2);
