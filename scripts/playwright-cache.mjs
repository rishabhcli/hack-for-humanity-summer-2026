import { PLAYWRIGHT_BROWSER_CACHE_PATH } from './dev/lib.mjs';

export const PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSER_CACHE_PATH;

/** @param {NodeJS.ProcessEnv} environment @returns {NodeJS.ProcessEnv} */
export function withRepositoryPlaywrightCache(environment) {
  return { ...environment, PLAYWRIGHT_BROWSERS_PATH };
}
