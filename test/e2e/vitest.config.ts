import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the e2e suite. The file is named e2e.e2etest.ts so the
 * repo-default include glob (**\/*.test.ts) can never pick it up in the
 * normal `npm test` run; run it explicitly with:
 *   npx vitest run --config test/e2e/vitest.config.ts
 * It boots a real `wrangler dev` on port 8788 and plays full matches, so it
 * needs long timeouts and must not run in parallel with itself.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2etest.ts'],
    testTimeout: 900_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // One worker: the suite owns port 8788 and a single wrangler dev child.
    maxConcurrency: 1,
  },
  // Run from the repo root regardless of where vitest is invoked.
  root: new URL('../..', import.meta.url).pathname,
});
