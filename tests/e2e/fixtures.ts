// Playwright harness for the real extension (docs/PLAN.md "E2E testing").
//
// - Launches Playwright's bundled Chromium (branded Chrome 137+ ignores --load-extension) as a persistent
//   context with extensions/web/.output/chrome-mv3 loaded, headless via the new headless mode (`channel: 'chromium'`).
//   Set HEADED=1 to watch.
// - Fake media: the mic plays `fakeAudio` (a fixtures/audio WAV, looped), camera is a fake device,
//   permission prompts auto-accept, and getDisplayMedia auto-selects the tab whose title contains
//   `captureSourceTitle`.
// - Playwright opens every page in its own window, so switching tabs never hides a page. Hidden pages need
//   raw CDP (raw-cdp.ts).
// - There is no API to open the docked side panel (Playwright #26693); `openExtensionPage('sidepanel.html')`
//   opens it as a tab instead.
// - Starts the fixture site on two origins per worker; `site.primaryOrigin` / `site.secondOrigin`.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium, type Page, type Worker } from '@playwright/test';
import { type FixtureServers, startFixtureServers } from '../../scripts/fixture-server.ts';

type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_PATH = join(ROOT, 'extensions/web/.output/chrome-mv3');
/** Another extension (fixtures/extension): its page is a review target no overlay can run on. */
export const FIXTURE_EXTENSION_PATH = join(ROOT, 'fixtures/extension');
export const AUDIO_DIR = join(ROOT, 'fixtures/audio');

/** Chromium's id for an unpacked extension: the first 128 bits of the SHA-256 of its path, as letters a–p. */
export function unpackedExtensionId(path: string): string {
  return [...createHash('sha256').update(path).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

/**
 * Stands in for the toolbar-icon click or shortcut that lets Chrome's tabCapture record a tab: automation cannot
 * give one, and this switch lifts the check for our extension (docs/spikes/toolbar-start.md).
 */
export const ALLOW_TAB_CAPTURE = `--allowlisted-extension-id=${unpackedExtensionId(EXTENSION_PATH)}`;

export interface ExtensionFixtures {
  /** WAV file name in fixtures/audio played as the fake microphone. */
  fakeAudio: string;
  /** getDisplayMedia auto-selects the first tab whose title contains this. */
  captureSourceTitle: string;
  /** Extra Chromium switches for a test. */
  extraArgs: string[];
  /** More unpacked extensions to load next to ours, e.g. FIXTURE_EXTENSION_PATH. */
  extraExtensions: string[];
  /** Playwright default switches to drop, e.g. its anti-backgrounding flags when testing hidden-page behaviour. */
  ignoreDefaultArgs: string[];
  /** More launch options, e.g. `recordVideo` for the site captures (site-captures.spec.ts). */
  persistentOptions: Pick<LaunchOptions, 'recordVideo' | 'viewport'>;
  /** The persistent profile directory (Chromium writes DevToolsActivePort here). */
  userDataDir: string;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Opens an extension page (e.g. 'sidepanel.html', 'onboarding.html') in a new tab. */
  openExtensionPage: (path: string) => Promise<Page>;
  site: Pick<FixtureServers, 'primaryOrigin' | 'secondOrigin'>;
}

interface WorkerFixtures {
  fixtureServers: FixtureServers;
}

export function chromiumArgs(opts: {
  fakeAudio: string;
  captureSourceTitle: string;
  extraArgs?: string[];
  extraExtensions?: string[];
}): string[] {
  const extensions = [EXTENSION_PATH, ...(opts.extraExtensions ?? [])].join(',');
  return [
    `--disable-extensions-except=${extensions}`,
    `--load-extension=${extensions}`,
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${join(AUDIO_DIR, opts.fakeAudio)}`,
    // Do NOT add --use-fake-ui-for-media-stream: combined with this flag it crashes Chromium 153 at startup (SIGTRAP).
    '--auto-accept-camera-and-microphone-capture',
    `--auto-select-tab-capture-source-by-title=${opts.captureSourceTitle}`,
    '--autoplay-policy=no-user-gesture-required',
    ...(opts.extraArgs ?? []),
  ];
}

export const test = base.extend<ExtensionFixtures, WorkerFixtures>({
  fakeAudio: ['review-scratch-that.wav', { option: true }],
  captureSourceTitle: ['Pricing Fixture', { option: true }],
  extraArgs: [[], { option: true }],
  extraExtensions: [[], { option: true }],
  ignoreDefaultArgs: [[], { option: true }],
  persistentOptions: [{}, { option: true }],

  fixtureServers: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter and requires an object pattern, even an empty one
    async ({}, use, workerInfo) => {
      // E2E_PORT_BASE moves the ports, so e2e runs in parallel checkouts on one machine do not collide.
      const base = Number(process.env.E2E_PORT_BASE ?? 4401);
      const offset = workerInfo.parallelIndex * 10;
      const servers = await startFixtureServers(base + offset, base + 1 + offset);
      await use(servers);
      await servers.close();
    },
    { scope: 'worker' },
  ],

  site: async ({ fixtureServers }, use) => {
    await use({ primaryOrigin: fixtureServers.primaryOrigin, secondOrigin: fixtureServers.secondOrigin });
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter and requires an object pattern, even an empty one
  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'var-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  },

  context: async (
    { fakeAudio, captureSourceTitle, extraArgs, extraExtensions, ignoreDefaultArgs, persistentOptions, userDataDir },
    use,
    info,
  ) => {
    // E2E_CHROME_LOG_DIR=<dir>: one Chromium log per test, with media-stream and offscreen detail (for flakes).
    const logDir = process.env.E2E_CHROME_LOG_DIR;
    const logArgs = logDir
      ? [
          '--enable-logging',
          '--v=0',
          '--vmodule=*media_stream*=3,*user_media*=3,*offscreen*=2',
          `--log-file=${join(
            logDir,
            `${info.titlePath
              .slice(1)
              .join(' ')
              .replace(/[^\w.-]+/g, '_')
              .slice(0, 80)}-r${info.repeatEachIndex}-w${info.workerIndex}.log`,
          )}`,
        ]
      : [];
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...persistentOptions,
      channel: 'chromium',
      headless: !process.env.HEADED,
      ignoreDefaultArgs,
      args: chromiumArgs({ fakeAudio, captureSourceTitle, extraArgs: [...extraArgs, ...logArgs], extraExtensions }),
    });
    // A crashed renderer otherwise shows up only as a wait that times out (e.g. Stop's review tab never opening, as
    // the extension's pages and worker share one process): name it in the report.
    const onCrash = (page: Page) =>
      page.on('crash', () => info.annotations.push({ type: 'renderer crashed', description: page.url() }));
    context.pages().forEach(onCrash);
    context.on('page', onCrash);
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    // Ours, not a fixture extension's (fixtures/extension names its worker fixture-sw.js).
    const ours = (w: Worker) => !w.url().endsWith('/fixture-sw.js');
    const sw =
      context.serviceWorkers().find(ours) ?? (await context.waitForEvent('serviceworker', { predicate: ours }));
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (path: string) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${path.replace(/^\//, '')}`);
      return page;
    });
  },
});

export const expect = test.expect;

/** Completes onboarding's microphone step, which Start requires (auto-accepted by the fake-media flags). */
export async function grantMic(openExtensionPage: ExtensionFixtures['openExtensionPage']): Promise<void> {
  const page = await openExtensionPage('onboarding.html');
  // Diagnostics for the intermittent "mic-status never appears" failure: what the page logged and showed.
  const log: string[] = [];
  page.on('console', (m) => log.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
  await page.getByTestId('allow-mic').click();
  // Either outcome ends the wait. On a failed grant or a timeout, attach what the page showed and logged, then fail
  // with the page's own error text when there is one.
  const ready = page.getByTestId('mic-status');
  const failed = page.getByRole('alert');
  const reached = await expect(ready.or(failed))
    .toBeVisible({ timeout: 20_000 })
    .then(
      () => null,
      (e: unknown) => e,
    );
  if (reached !== null || (await failed.isVisible())) {
    const alert = await failed.textContent({ timeout: 1000 }).catch(() => null);
    const granted = await page
      .evaluate(() => chrome.storage.local.get('micGranted'))
      .catch((err: unknown) => String(err));
    const detail = JSON.stringify(
      {
        alert,
        granted,
        allowMicStillShown: await page
          .getByTestId('allow-mic')
          .isVisible()
          .catch(() => null),
        log,
      },
      null,
      2,
    );
    await test.info().attach('grantMic-diagnostics.json', { body: detail, contentType: 'application/json' });
    console.log(`grantMic failed: ${detail}`);
    if (alert) throw new Error(`onboarding could not open the microphone: ${alert}`);
    throw reached;
  }
  await page.close();
}

/**
 * Dev/test overrides (src/settings.ts devOverrides): replay a transcript fixture from fixtures/transcripts
 * instead of Web Speech, and optionally shorten the 30s audio chunk interval.
 */
export async function useScriptedTranscript(sw: Worker, fixture: string, audioChunkMs?: number): Promise<void> {
  await useScript(sw, JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts', fixture), 'utf8')), audioChunkMs);
}

export interface ScriptCue {
  at_ms: number;
  duration_ms: number;
  text: string;
}

/** Replays `script` instead of Web Speech (see useScriptedTranscript). */
export async function useScript(
  sw: Worker,
  script: { timestamp_quality: 'word' | 'approximate'; cues: ScriptCue[] },
  audioChunkMs?: number,
): Promise<void> {
  await sw.evaluate((devOverrides) => chrome.storage.local.set({ devOverrides }), {
    transcription: 'scripted' as const,
    script,
    ...(audioChunkMs ? { audioChunkMs } : {}),
  });
}

/**
 * Comment-box dictation (E11). Specs whose speech is meant for the Session transcript while a comment box is open use
 * 'push' (the box then only takes typing unless its mic button is on); the default is 'auto'.
 */
export async function useBoxDictation(sw: Worker, mode: 'auto' | 'push'): Promise<void> {
  await sw.evaluate(async (m) => {
    const { captureSettings } = await chrome.storage.local.get('captureSettings');
    await chrome.storage.local.set({ captureSettings: { fadeMs: 2000, ...(captureSettings ?? {}), boxDictation: m } });
  }, mode);
}
