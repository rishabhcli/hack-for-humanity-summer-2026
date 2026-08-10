import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(
  readFileSync(resolve('validation', 'fixtures', 'manifest.v1.json'), 'utf8'),
);

if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
  console.error(
    'EVALUATION_REFUSED code=EVAL_FIXTURE_CORPUS_EMPTY detail="No validated known-angle fixture is committed"',
  );
  process.exit(2);
}

console.error(
  'EVALUATION_REFUSED code=EVAL_ALGORITHM_UNIMPLEMENTED detail="The measurement correctness oracle is not implemented"',
);
process.exit(2);
