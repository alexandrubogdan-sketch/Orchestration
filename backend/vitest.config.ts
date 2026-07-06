import { defineConfig } from 'vitest/config';

/**
 * Single shared config. Unit vs. integration is a directory split
 * (test/unit vs test/integration — see package.json scripts), not a
 * vitest "projects"/workspace split: that feature's config shape has
 * changed across vitest 2.x/3.x, and a plain directory filter is more
 * than enough for two suites with genuinely different runtime
 * requirements (integration needs DATABASE_URL/REDIS_URL; see
 * test/integration/health.test.ts).
 */
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
