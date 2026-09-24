// Playwright harness for the Firefox build (extensions/web/.output/firefox-mv3; docs/browsers.md "Testing").
//
// - Playwright's Firefox has no API to load an add-on, and it cannot open or see moz-extension:// pages: goto()
//   times out on them (Juggler loses the tab when it switches to the extension process), the WebDriver BiDi channel
//   refuses the navigation ("not allowed in this context"), and tabs the add-on opens itself never appear in
//   context.pages(). So the harness starts Firefox's remote debugging server, installs the build as a temporary
//   add-on over RDP (as about:debugging does) and scripts the extension pages over RDP too (ExtPage). Web pages under
//   review are ordinary Playwright pages: drawing on them uses real pointer events.
// - The add-on's moz-extension UUID is pinned by a pref, so extension URLs are known up front.
// - Fake media: fake mic and camera, permission prompts skipped. getDisplayMedia needs a real user gesture, which
//   neither Playwright nor RDP can give an extension page, so automated Firefox Sessions run with video off.
// - Downloads go straight to a per-test folder.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, test as base, firefox } from '@playwright/test';
import { type FixtureServers, startFixtureServers } from '../../scripts/fixture-server.ts';
import { Rdp } from './rdp.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const EXTENSION_PATH = join(ROOT, 'extensions/web/.output/firefox-mv3');
export const EXTENSION_UUID = '5d0c2a6e-7a1f-4c3b-9e2d-7a8b9c0d1e2f';
export const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

/** The start of a function's source, to name it in an error. */
const summary = (fn: (...args: never[]) => unknown) => fn.toString().replace(/\s+/g, ' ').slice(0, 120);

/** An extension page (moz-extension://…) scripted over RDP: evaluate, click, wait. */
export class ExtPage {
  private seq = 0;
  private readonly rdp: Rdp;
  private readonly tabActor: string;
  readonly url: string;
  constructor(rdp: Rdp, tabActor: string, url: string) {
    this.rdp = rdp;
    this.tabActor = tabActor;
    this.url = url;
  }

  private async consoleActor(): Promise<string> {
    // Asked each time: a navigation or reload replaces the page's actors.
    const target = await this.rdp.request(this.tabActor, 'getTarget');
    return (target.frame as { consoleActor: string }).consoleActor;
  }

  private async evalText(text: string): Promise<unknown> {
    const actor = await this.consoleActor();
    const { resultID } = await this.rdp.request(actor, 'evaluateJSAsync', { text });
    const got = await this.rdp.evaluationResult(resultID as string);
    if (got.exceptionMessage) throw new Error(`in ${this.url}: ${String(got.exceptionMessage)}`);
    return this.rdp.grip(got.result);
  }

  /**
   * Runs `fn(arg)` in the page (it may be async) and returns its JSON-serialisable result. Throws once `timeout` ms
   * pass without one: a promise in the page that never settles, or an RDP reply that never comes, names the call
   * instead of running into the test's timeout.
   */
  async evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A, timeout = 30_000): Promise<T> {
    const key = `__e2e${this.seq++}`;
    const until = Date.now() + timeout;
    const bounded = <R>(p: Promise<R>): Promise<R> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`in ${this.url}: no result after ${timeout} ms from ${summary(fn)}`)),
          Math.max(0, until - Date.now()),
        );
      });
      return Promise.race([p, late]).finally(() => clearTimeout(timer));
    };
    await bounded(
      this.evalText(
        `window.${key} = null; (async () => (${fn.toString()})(${JSON.stringify(arg ?? null)}))()` +
          `.then((v) => { window.${key} = JSON.stringify({ ok: true, v: v === undefined ? null : v }); },` +
          ` (e) => { window.${key} = JSON.stringify({ ok: false, v: String(e && e.stack || e) }); }); 0`,
      ),
    );
    for (;;) {
      const raw = await bounded(this.evalText(`window.${key}`));
      if (typeof raw === 'string') {
        await this.evalText(`delete window.${key}; 0`);
        const r = JSON.parse(raw) as { ok: boolean; v: unknown };
        if (!r.ok) throw new Error(`in ${this.url}: ${String(r.v)}`);
        return r.v as T;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Polls `fn(arg)` until it returns something truthy, and returns that. Each try gets the time that is left. */
  async waitFor<T, A = undefined>(
    fn: (arg: A) => T | Promise<T>,
    arg?: A,
    { timeout = 15_000, what = fn.toString() } = {},
  ): Promise<NonNullable<T>> {
    const until = Date.now() + timeout;
    let last: unknown;
    for (;;) {
      last = await this.evaluate(fn, arg, Math.max(1_000, until - Date.now())).catch((e: unknown) => e);
      if (last && !(last instanceof Error)) return last as NonNullable<T>;
      if (Date.now() > until)
        throw new Error(`timed out after ${timeout} ms in ${this.url} waiting for ${what}; last: ${String(last)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Clicks the element with this data-testid once it exists (a DOM click: no user activation). A click that navigates
   * the page away (the frame host's Reset) would take the evaluation's answer with it, so with `navigates` it runs
   * just after the answer; any other click has happened by the time this returns.
   */
  async click(testId: string, { navigates = false } = {}): Promise<void> {
    await this.waitFor(
      ({ id, later }) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (!el || (el as HTMLButtonElement).disabled) return false;
        if (later) setTimeout(() => el.click(), 50);
        else el.click();
        return true;
      },
      { id: testId, later: navigates },
      { what: `a clickable [data-testid="${testId}"]` },
    );
  }

  /** The trimmed text of the element with this data-testid, or null. */
  text(testId: string): Promise<string | null> {
    return this.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null, testId);
  }

  /** Waits until the element with this data-testid has text matching `re`. */
  async waitForText(testId: string, re: RegExp, timeout = 15_000): Promise<string> {
    return this.waitFor(
      ({ id, src, flags }) => {
        const t = document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';
        return new RegExp(src, flags).test(t) ? t : '';
      },
      { id: testId, src: re.source, flags: re.flags },
      { timeout, what: `[data-testid="${testId}"] to match ${re}` },
    );
  }
}

export interface FirefoxFixtures {
  /** Overrides Firefox's event-page idle timeout (30 s), after which it suspends a background page with no events. */
  idleTimeoutMs: number | null;
  context: BrowserContext;
  rdp: Rdp;
  /** Waits for an open extension tab whose URL contains `part`. */
  extPage: (part: string, timeout?: number) => Promise<ExtPage>;
  /** Opens an extension page in a new window (its own window keeps the page under review the active tab). */
  openExtensionWindow: (path: string) => Promise<ExtPage>;
  downloadDir: string;
  site: Pick<FixtureServers, 'primaryOrigin' | 'secondOrigin'>;
}

interface WorkerFixtures {
  fixtureServers: FixtureServers;
}

/** E2E_PORT_BASE (default 4401, as in tests/e2e) moves every port, so checkouts can run e2e side by side. */
const portBase = () => Number(process.env.E2E_PORT_BASE ?? 4401);

const addonId = (): string =>
  JSON.parse(readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;

export const test = base.extend<FirefoxFixtures, WorkerFixtures>({
  idleTimeoutMs: [null, { option: true }],

  fixtureServers: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter and requires an object pattern, even an empty one
    async ({}, use, workerInfo) => {
      const port = portBase() + 200 + workerInfo.parallelIndex * 10;
      const servers = await startFixtureServers(port, port + 1);
      await use(servers);
      await servers.close();
    },
    { scope: 'worker' },
  ],

  site: async ({ fixtureServers }, use) => {
    await use({ primaryOrigin: fixtureServers.primaryOrigin, secondOrigin: fixtureServers.secondOrigin });
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter and requires an object pattern, even an empty one
  downloadDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'var-ff-downloads-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  // The RDP port rides on the context: Firefox starts the debugging server at launch.
  context: async ({ downloadDir, idleTimeoutMs }, use, info) => {
    const profile = mkdtempSync(join(tmpdir(), 'var-ff-e2e-'));
    const port = portBase() + 1800 + info.parallelIndex;
    const context = await firefox.launchPersistentContext(profile, {
      headless: !process.env.HEADED,
      args: ['-start-debugger-server', String(port)],
      firefoxUserPrefs: {
        'devtools.debugger.remote-enabled': true,
        'devtools.debugger.prompt-connection': false,
        'devtools.chrome.enabled': true,
        'extensions.webextensions.uuids': JSON.stringify({ [addonId()]: EXTENSION_UUID }),
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        // Web Audio (the PCM graph, the VAD) starts without a user gesture, as it does for the add-on in a real profile.
        'media.autoplay.default': 0,
        'media.autoplay.block-webaudio': false,
        'browser.download.dir': downloadDir,
        'browser.download.folderList': 2,
        'browser.download.useDownloadDir': true,
        'browser.download.always_ask_before_handling_new_types': false,
        ...(idleTimeoutMs ? { 'extensions.background.idle.timeout': idleTimeoutMs } : {}),
      },
    });
    (context as BrowserContext & { rdpPort?: number }).rdpPort = port;
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  },

  rdp: async ({ context }, use) => {
    const rdp = await Rdp.connect((context as BrowserContext & { rdpPort: number }).rdpPort);
    const root = await rdp.request('root', 'getRoot');
    await rdp.request(root.addonsActor as string, 'installTemporaryAddon', { addonPath: EXTENSION_PATH });
    await use(rdp);
    rdp.close();
  },

  extPage: async ({ rdp }, use) => {
    await use(async (part, timeout = 15_000) => {
      const until = Date.now() + timeout;
      for (;;) {
        const { tabs } = (await rdp.request('root', 'listTabs')) as unknown as {
          tabs: { actor: string; url: string }[];
        };
        const tab = tabs.find((t) => t.url.startsWith(ORIGIN) && t.url.includes(part));
        if (tab) return new ExtPage(rdp, tab.actor, tab.url);
        if (Date.now() > until)
          throw new Error(`no extension tab with "${part}"; open: ${tabs.map((t) => t.url).join(', ')}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  },

  openExtensionWindow: async ({ extPage }, use) => {
    await use(async (path) => {
      // Install opens onboarding.html; any extension page can open another.
      const opener = await extPage('/onboarding.html');
      await opener.evaluate((p) => chrome.windows.create({ url: p }).then(() => true), `/${path.replace(/^\//, '')}`);
      return extPage(`/${path.replace(/^\//, '')}`);
    });
  },
});

export const expect = test.expect;
