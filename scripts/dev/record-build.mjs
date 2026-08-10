import { recordCurrentBuildProvenance } from './build.mjs';

console.log(`build-provenance recorded digest=${recordCurrentBuildProvenance()}`);
