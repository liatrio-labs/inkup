// `pnpm eval` (the live Process eval) and `pnpm eval:stt` (the live transcription eval), both in tests/eval.
// Separate from `pnpm test` because they call real services with keys from .env and cost money; each skips without its key.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// .env stays at the repo root.
const ENV = join(import.meta.dirname, '../../.env');
if (existsSync(ENV)) process.loadEnvFile(ENV);

export default defineConfig({
  plugins: [WxtVitest({ root: import.meta.dirname })],
  test: {
    environment: 'node',
    include: ['tests/eval/**/*.eval.ts'],
    testTimeout: 180_000,
    reporters: ['verbose'],
  },
});
