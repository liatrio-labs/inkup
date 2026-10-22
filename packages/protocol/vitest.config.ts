import { defineConfig } from 'vitest/config';
import { FORCE_RERUN_TRIGGERS } from '../../scripts/vitest-rerun.ts';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
  },
});
