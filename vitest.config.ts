import { defineConfig } from 'vitest/config';

// `pnpm test`: every package's unit tests plus the repo-level ones (fixtures, schema sync, test support).
export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/protocol',
      'extensions/web',
      {
        test: {
          name: 'repo',
          environment: 'happy-dom',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
    ],
  },
});
