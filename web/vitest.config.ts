// Local-verification-only config for T9's static checks. T9 owns web/ only
// and may not edit the root vitest.config.ts, whose `include` glob doesn't
// cover web/tests/. This lets *this* track run its own tests with:
//   npx vitest run --config web/vitest.config.ts
// Integration should still add `web/tests/**/*.test.ts` to the root
// vitest.config.ts#test.include so it's part of the one `npx vitest run`
// suite — see notes/T9.md.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['web/tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
