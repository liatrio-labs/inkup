import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } },
  test: {
    name: 'desktop',
    include: ['ui/src/**/*.test.{ts,tsx}'],
  },
});
