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
    const got = await this.rdp.next((p) => p.type === 'evaluationResult' && p.resultID === resultID);
    if (got.exceptionMessage) throw new Error(`in ${this.url}: ${String(got.exceptionMessage)}`);
    return this.rdp.grip(got.result);
  }

  /** Runs `fn(arg)` in the page (it may be async) and returns its JSON-serialisable result. */
  async evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    const key = `__e2e${this.seq++}`;
    await this.evalText(
      `window.${key} = null; (async () => (${fn.toString()})(${JSON.stringify(arg ?? null)}))()` +
        `.then((v) => { window.${key} = JSON.stringify({ ok: true, v: v === undefined ? null : v }); },` +
        ` (e) => { window.${key} = JSON.stringify({ ok: false, v: String(e && e.stack || e) }); }); 0`,
    );
    for (;;) {
      const raw = await this.evalText(`window.${key}`);
      if (typeof raw === 'string') {
        await this.evalText(`delete window.${key}; 0`);
        const r = JSON.parse(raw) as { ok: boolean; v: unknown };
        if (!r.ok) throw new Error(`in ${this.url}: ${String(r.v)}`);
        return r.v as T;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Polls `fn(arg)` until it returns something truthy, and returns that. */
  async waitFor<T, A = undefined>(
    fn: (arg: A) => T | Promise<T>,
    arg?: A,
    { timeout = 15_000, what = fn.toString() } = {},
  ): Promise<NonNullable<T>> {
    const until = Date.now() + timeout;
    let last: unknown;
    for (;;) {
      last = await this.evaluate(fn, arg).catch((e: unknown) => e);
      if (last && !(last instanceof Error)) return last as NonNullable<T>;
      if (Date.now() > until)
        throw new Error(`timed out after ${timeout} ms in ${this.url} waiting for ${what}; last: ${String(last)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Clicks the element with this data-testid once it exists (a DOM click: no user activation). */
  async click(testId: string): Promise<void> {
    await this.waitFor(
      (id) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (!el || (el as HTMLButtonElement).disabled) return false;
        el.click();
        return true;
      },
      testId,
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
