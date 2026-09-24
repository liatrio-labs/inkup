import { defineConfig } from '@playwright/test';

// One project per browser build. `pnpm test:e2e` builds chrome-mv3 and runs `chrome` (tests/e2e/fixtures.ts loads
// extensions/web/.output/chrome-mv3); `pnpm test:e2e:firefox` builds firefox-mv3 and runs `firefox`
// (tests/e2e-firefox/fixtures.ts).
export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Each test launches its own persistent browser; fixture servers are per worker on distinct ports. Locally, 4 workers
  // halve the run (7.6 to 4.0 min on 10 cores) with no new flakes; 5 overloads the machine (load 77) and timing-sensitive
  // specs fail. CI runs one per runner and splits the suite with --shard instead. `--workers=N` overrides.
  workers: process.env.CI ? 1 : 4,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chrome', testDir: 'tests/e2e' },
    { name: 'firefox', testDir: 'tests/e2e-firefox' },
  ],
});
