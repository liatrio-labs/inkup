// Which Playwright specs a pull request runs. The `changes` job still decides whether the e2e jobs start; this
// narrows the specs inside them. A shared fixture, the harness, the Playwright config, a package.json or the
// lockfile runs the whole suite. A path with no rule under the extension, packages or the contract does too,
// so an unmapped change cannot skip coverage. Anywhere else (docs, CI, a leaf the map names) runs only the
// specs that map names, or nothing.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Suite = 'chrome' | 'firefox';

export type E2ePlan = { mode: 'all' | 'none' | 'specs'; specs: string[] };

const SUITE_DIR: Record<Suite, string> = { chrome: 'tests/e2e', firefox: 'tests/e2e-firefox' };

// Longest matching prefix wins. Specs are basenames; a suite keeps the ones it has. An empty list is an area
// the browser suites do not drive (the TUI, the update check).
const RULES: { prefix: string; specs: string[] }[] = [
  { prefix: 'extensions/web/src/content/text-comment', specs: ['text-comment.spec.ts'] },
  { prefix: 'extensions/web/src/content/object-select', specs: ['object-select.spec.ts'] },
  { prefix: 'extensions/web/src/content/page-api', specs: ['page-api.spec.ts'] },
  { prefix: 'extensions/web/src/background/page-api', specs: ['page-api.spec.ts'] },
  { prefix: 'extensions/web/src/bridge/page-api', specs: ['page-api.spec.ts'] },
  { prefix: 'extensions/web/src/content/source-probe', specs: ['source-map.spec.ts'] },
  {
    prefix: 'extensions/web/src/content/overlay',
    specs: ['overlay-cleanup.spec.ts', 'single-overlay.spec.ts', 'overlap.spec.ts'],
  },
  { prefix: 'extensions/web/src/content/lifetime', specs: ['overlay-cleanup.spec.ts'] },
  { prefix: 'extensions/web/src/content/top-layer', specs: ['overlay-cleanup.spec.ts', 'single-overlay.spec.ts'] },
  { prefix: 'extensions/web/src/content/theme', specs: ['adaptive-contrast.spec.ts', 'dark-mode.spec.ts'] },
  { prefix: 'extensions/web/src/content/toolbar', specs: ['toolbar-session.spec.ts', 'toolbar.spec.ts'] },
  {
    prefix: 'extensions/web/src/content/paint',
    specs: ['shapes.spec.ts', 'stroke-capture.spec.ts', 'highlight.spec.ts'],
  },
  { prefix: 'extensions/web/src/background/voice', specs: ['voice-commands.spec.ts', 'voice-optional.spec.ts'] },
  { prefix: 'extensions/web/src/background/viewport', specs: ['viewport.spec.ts'] },
  { prefix: 'extensions/web/src/viewport/', specs: ['viewport.spec.ts'] },
  { prefix: 'extensions/web/src/background/toolbar', specs: ['toolbar-session.spec.ts', 'toolbar.spec.ts'] },
  { prefix: 'extensions/web/src/background/audio', specs: ['cancel-mute.spec.ts', 'mic-gate.spec.ts'] },
  { prefix: 'extensions/web/src/background/capture', specs: ['capture.spec.ts', 'stroke-capture.spec.ts'] },
  { prefix: 'extensions/web/src/background/screenshots', specs: ['capture.spec.ts'] },
  { prefix: 'extensions/web/src/background/drafts', specs: ['drafts.spec.ts'] },
  { prefix: 'extensions/web/src/background/picker', specs: ['dropped-pick.spec.ts', 'mic-picker.spec.ts'] },
  { prefix: 'extensions/web/src/background/review-tab', specs: ['review-tab.spec.ts'] },
  {
    prefix: 'extensions/web/src/background/session',
    specs: ['sessions.spec.ts', 'session.spec.ts', 'start-path.spec.ts'],
  },
  { prefix: 'extensions/web/src/background/process', specs: ['process.spec.ts', 'process-stream.spec.ts'] },
  { prefix: 'extensions/web/src/background/video', specs: ['video-process.spec.ts'] },
  {
    prefix: 'extensions/web/src/background/host-',
    specs: ['host.spec.ts', 'host-sync.spec.ts', 'network-host.spec.ts'],
  },
  { prefix: 'extensions/web/src/adapters/transcription', specs: ['stt-tiers.spec.ts', 'voice-optional.spec.ts'] },
  { prefix: 'extensions/web/src/adapters/llm', specs: ['gateway.spec.ts', 'process.spec.ts'] },
  { prefix: 'extensions/web/src/adapters/host', specs: ['host.spec.ts', 'host-sync.spec.ts'] },
  { prefix: 'extensions/web/src/db/session-export', specs: ['export.spec.ts'] },
  { prefix: 'extensions/web/src/db/session-import', specs: ['restore.spec.ts'] },
  {
    prefix: 'extensions/web/src/db/',
    specs: ['sessions.spec.ts', 'session.spec.ts', 'page-storage.spec.ts', 'restore.spec.ts', 'export.spec.ts'],
  },
  { prefix: 'extensions/web/src/lib/trackers', specs: ['trackers.spec.ts'] },
  { prefix: 'extensions/web/src/entrypoints/toolbar-start', specs: ['start-path.spec.ts'] },
  { prefix: 'extensions/web/src/media/', specs: ['video-process.spec.ts', 'capture.spec.ts'] },
  { prefix: 'packages/ui/src/comment-box/', specs: ['text-comment.spec.ts'] },
  { prefix: 'packages/ui/src/highlight/', specs: ['highlight.spec.ts'] },
  { prefix: 'packages/ui/src/toolbar/mic-picker', specs: ['mic-picker.spec.ts'] },
  { prefix: 'packages/ui/src/toolbar/viewport-control', specs: ['viewport.spec.ts'] },
  { prefix: 'packages/ui/src/toolbar/', specs: ['toolbar-session.spec.ts', 'toolbar.spec.ts'] },
  { prefix: 'packages/ui/src/product/tone', specs: ['adaptive-contrast.spec.ts', 'dark-mode.spec.ts'] },
  { prefix: 'host/crates/tui/', specs: [] },
  { prefix: 'host/crates/update-check/', specs: [] },
  { prefix: 'host/', specs: ['host.spec.ts', 'host-sync.spec.ts', 'network-host.spec.ts'] },
];

const FULL_SUITE = [
  /^fixtures\//,
  /^tests\/e2e\/fixtures\.ts$/,
  /^tests\/e2e\/helpers\//,
  /^tests\/e2e\/raw-cdp\.ts$/,
  /^tests\/e2e\/harness\.spec\.ts$/,
  /^tests\/e2e-firefox\/fixtures\.ts$/,
  /^tests\/e2e-firefox\/rdp\.ts$/,
  /^playwright\.[^/]*config\.ts$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
];

// Code the map does not name still runs every spec. CI config and docs do not.
const PRODUCT = /^(extensions|packages|contract)\//;
const SPEC_FILE = /^tests\/e2e(?:-firefox)?\/[^/]+\.spec\.ts$/;
const SPEC_PATH = /^tests\/e2e(?:-firefox)?\/[A-Za-z0-9._-]+\.spec\.ts$/;

export function mappedSpecBasenames(): string[] {
  return [...new Set(RULES.flatMap((rule) => rule.specs))].sort();
}

function ruleFor(file: string): { specs: string[] } | null {
  let best: { prefix: string; specs: string[] } | null = null;
  for (const rule of RULES) {
    if (file.startsWith(rule.prefix) && (best === null || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best;
}

function suiteOf(file: string): Suite | null {
  if (file.startsWith('tests/e2e-firefox/')) return 'firefox';
  if (file.startsWith('tests/e2e/')) return 'chrome';
  return null;
}

/** `available` is the suite's spec paths (`tests/e2e/foo.spec.ts`). */
export function selectE2e(files: string[], suite: Suite, available: ReadonlySet<string>): E2ePlan {
  let all = false;
  const specs = new Set<string>();
  const dir = SUITE_DIR[suite];
  for (const file of files) {
    if (!file || file.endsWith('.md') || file.startsWith('docs/') || file === 'LICENSE') continue;
    if (FULL_SUITE.some((pattern) => pattern.test(file))) {
      all = true;
      continue;
    }
    if (SPEC_FILE.test(file)) {
      if (suiteOf(file) === suite && available.has(file) && SPEC_PATH.test(file)) specs.add(file);
      continue;
    }
    if (file.startsWith('tests/e2e/') || file.startsWith('tests/e2e-firefox/')) {
      all = true;
      continue;
    }
    const rule = ruleFor(file);
    if (rule) {
      for (const basename of rule.specs) {
        const path = `${dir}/${basename}`;
        if (available.has(path)) specs.add(path);
      }
      continue;
    }
    if (PRODUCT.test(file)) all = true;
  }
  if (all) return { mode: 'all', specs: [] };
  if (specs.size === 0) return { mode: 'none', specs: [] };
  return { mode: 'specs', specs: [...specs].sort() };
}

export function formatE2ePlan(plan: E2ePlan): string {
  if (plan.mode !== 'specs') return `${plan.mode}\n`;
  return `specs\n${plan.specs.join('\n')}\n`;
}

export function availableSpecs(root: string, suite: Suite): Set<string> {
  const dir = SUITE_DIR[suite];
  return new Set(
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => `${dir}/${name}`),
  );
}

export function planE2e(files: string[], suite: Suite, root: string): E2ePlan {
  return selectE2e(files, suite, availableSpecs(root, suite));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const suite = process.argv[2];
  if (suite !== 'chrome' && suite !== 'firefox') {
    process.stderr.write('usage: node scripts/affected-e2e.ts <chrome|firefox>  # paths on stdin\n');
    process.exit(2);
  }
  const files = readFileSync(0, 'utf8').split('\n');
  process.stdout.write(formatE2ePlan(planE2e(files, suite, ROOT)));
}
