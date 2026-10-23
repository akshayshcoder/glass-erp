import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test file gets its own throw-away database (see test/test-app.ts).
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
