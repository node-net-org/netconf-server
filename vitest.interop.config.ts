import { defineConfig } from 'vitest/config';

// npm run test:interop: differential tests against netopeer2 (design §15.2), outside `check`.
export default defineConfig({
  test: {
    include: ['test/interop/**/*.test.ts'],
    environment: 'node',
    // The files share one netopeer2, and the write set changes its configuration: one file at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
