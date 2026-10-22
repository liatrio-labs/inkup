import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { FORCE_RERUN_TRIGGERS } from '../../scripts/vitest-rerun.ts';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } },
  test: {
    name: 'desktop',
    include: ['ui/src/**/*.test.{ts,tsx}'],
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
  },
});
