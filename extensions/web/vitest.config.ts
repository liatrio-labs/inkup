import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // `root` pins WXT to this folder when the repo root runs this file as a Vitest project.
  plugins: [WxtVitest({ root: import.meta.dirname })],
  test: {
    name: 'extension',
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
  },
});
