import { defineConfig } from 'vitest/config';

// No DOM and no WXT: packages/core runs in plain Node (tests/core-boundary.test.ts).
export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
