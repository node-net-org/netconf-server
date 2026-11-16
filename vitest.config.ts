import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The netopeer2 differential tests run with npm run test:interop.
    exclude: ['test/interop/**', 'node_modules/**'],
    environment: 'node',
    // CI runners (the release workflow, and check-node.sh's containers, which set
    // CI) are slower than a developer's machine. Locally the 5 s default stays, so
    // a test that gets slow still shows up.
    testTimeout: process.env['CI'] ? 30_000 : 5_000,
  },
});
