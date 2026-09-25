import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    include: ['ui/src/**/*.test.ts'],
  },
});
