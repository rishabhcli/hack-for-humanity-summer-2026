import { resolve } from 'node:path';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
export const REPOSITORY_NPM_CACHE = resolve(REPOSITORY_ROOT, '.dev', 'cache', 'npm');

/** @param {NodeJS.ProcessEnv} environment @returns {NodeJS.ProcessEnv} */
export function withRepositoryNpmCache(environment) {
  return { ...environment, npm_config_cache: REPOSITORY_NPM_CACHE };
}
