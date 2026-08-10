import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      clean: true,
      exclude: ['src/main.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 10_000,
  },
});
