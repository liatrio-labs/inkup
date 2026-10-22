import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { FORCE_RERUN_TRIGGERS } from '../../scripts/vitest-rerun.ts';

// A DOM, and Tailwind compiling the package's stylesheets as the apps' Vite builds do (`?inline` in mountInShadow).
export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    name: 'ui',
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    css: { include: [/.+/] },
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
  },
});
