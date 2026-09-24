import { defineConfig } from '@playwright/test';

// `pnpm test:e2e:whisper` (opt-in, not part of `pnpm test:e2e`): downloads whisper-base from huggingface.co
// through the options page and transcribes a fixture WAV with it. Needs the network and a few minutes.
export default defineConfig({
  testDir: 'tests/e2e-whisper',
  timeout: 600_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
