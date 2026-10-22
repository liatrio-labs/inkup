import { defineConfig } from 'vitest/config';
import { FORCE_RERUN_TRIGGERS } from '../../scripts/vitest-rerun.ts';

// No DOM and no WXT: packages/core runs in plain Node (tests/core-boundary.test.ts).
export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
  },
});
