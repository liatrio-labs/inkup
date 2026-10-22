import { defineConfig } from 'vitest/config';
import { FORCE_RERUN_TRIGGERS } from './scripts/vitest-rerun.ts';

// `pnpm test`: every package's unit tests plus the repo-level ones (fixtures, schema sync, test support).
export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/protocol',
      'packages/ui',
      'extensions/web',
      'apps/desktop',
      {
        test: {
          name: 'repo',
          environment: 'happy-dom',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
    ],
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
  },
});
