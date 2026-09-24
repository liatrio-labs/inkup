// E14 proof in Firefox (ADR 0006), as tests/e2e/network-host.spec.ts: the same options page and background code
// pair with a Host in network mode on this machine's LAN address, which the host counts as another machine.
//
// - By address: a wrong code is refused, the right one pairs; a Session streams to the host over the LAN address;
//   MCP on the LAN address is 401 without a token and works with an agent token.
// - Find hubs with the probe list set to [the live hub, a dead address] lists only the live one; Connect pairs.
// - Pasting the `inkup://pair` link pairs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { circle } from '../e2e/helpers/draw';
import { HostProcess, lanAddress, tempDataDir } from '../e2e/helpers/host';
import { McpClient } from '../e2e/helpers/mcp';
import { type ExtPage, expect, ROOT, test } from './fixtures';

const LAN = lanAddress();
test.skip(!LAN, 'no LAN address on this machine');

const DEAD_ADDRESS = 'http://192.0.2.1:49999';

async function startNetworkHost(dir: string): Promise<{ host: HostProcess; lanUrl: string }> {
  const host = await HostProcess.start(dir, 0, {
    network: { mdnsName: `inkup-e2e-ff-${process.pid}-${test.info().parallelIndex}` },
  });
  return { host, lanUrl: `http://${LAN}:${host.port}` };
}

/** Types into a React input: the value setter React watches, then an input event. */
async function fill(page: ExtPage, testId: string, value: string) {
  await page.waitFor(
    ({ id, v }) => {
      const el = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
      if (!el || el.disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    { id: testId, v: value },
    { what: `an input [data-testid="${testId}"]` },
  );
}

const connected = (options: ExtPage) =>
  options.waitFor(
    () => document.querySelector('[data-testid="host-status"]')?.getAttribute('data-state') === 'connected',
    undefined,
    {
      timeout: 20_000,
      what: 'a connected host',
    },
  );

const codeForm = (options: ExtPage) =>
  options.waitFor(() => !!document.querySelector('[data-testid="host-code"]'), undefined, { what: 'the code prompt' });

async function typeCode(options: ExtPage, code: string) {
  await fill(options, 'host-code', code);
  await options.click('host-code-submit');
}

const pairedUrl = (page: ExtPage) =>
  page.evaluate(
    async () => ((await chrome.storage.local.get('hostPairing')).hostPairing as { url: string } | null)?.url ?? null,
  );

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('Firefox: pairs with a network hub by its code on the LAN address, streams a Session there, and MCP there wants a token', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    const onboarding = await extPage('/onboarding.html');
    const script = JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts/pricing-cta.json'), 'utf8'));
    await onboarding.evaluate(
      (s) => chrome.storage.local.set({ devOverrides: { transcription: 'scripted', script: s, audioChunkMs: 2000 } }),
      script,
    );
    await onboarding.click('allow-mic');
    await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
      timeout: 20_000,
      what: 'the mic grant',
    });

    await onboarding.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), lanUrl);
    const options = await openExtensionWindow('options.html');
    await options.click('host-other-address');
    await options.click('host-pair');
    await codeForm(options);
    const code = await host.nextCode(0);
    await typeCode(options, wrong(code));
    await options.waitForText('host-error', /Wrong code/);
    await typeCode(options, code);
    await connected(options);
    await options.waitForText('host-network-note', /Unencrypted network hub/);
    expect(await pairedUrl(options)).toBe(lanUrl);
    const token = await options.evaluate(
      async () => ((await chrome.storage.local.get('hostPairing')).hostPairing as { token: string }).token,
    );

    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionWindow('sidepanel.html');
    await panel.click('start');
    await panel.waitForText('status', /^Recording$/);
    const sessionId = await panel.waitFor(
      async () =>
        ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    );
    expect(
      await panel.evaluate(() => document.querySelector('[data-testid="host-indicator"]')?.getAttribute('title') ?? ''),
    ).toContain('Unencrypted network hub');
    await panel.click('draw-toggle');
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await panel.waitForText('annotation-count', /^1$/);
    await new Promise((r) => setTimeout(r, 2500));
    await panel.click('stop');
    await extPage('/review.html', 20_000);
    await options.waitFor(
      async () => {
        const idb = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open('inkup');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const n = await new Promise<number>((res) => {
          const r = idb.transaction('outbox').objectStore('outbox').count();
          r.onsuccess = () => res(r.result);
        });
        idb.close();
        return n === 0;
      },
      undefined,
      { timeout: 30_000, what: 'an empty outbox' },
    );

    const get = (path: string, bearer?: string) =>
      fetch(`${lanUrl}${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    expect((await get(`/api/sessions/${sessionId}/events`)).status).toBe(401);
    const events = (await (await get(`/api/sessions/${sessionId}/events`, token)).json()) as TimelineEvent[];
    expect(events[0]!.type).toBe('session_start');
    expect(events.at(-1)!.type).toBe('session_end');
    expect(events.filter((e) => e.type === 'annotation')).toHaveLength(1);
    const shot = events.find((e) => e.type === 'screenshot') as { screenshot_id: string } | undefined;
    expect(shot, 'a screenshot event').toBeTruthy();
    expect((await get(`/blobs/${encodeURIComponent(shot!.screenshot_id)}`, token)).status).toBe(200);

    await expect(McpClient.connect(lanUrl)).rejects.toThrow(/401/);
    const agent = await McpClient.connect(lanUrl, host.createAgentToken('e2e agent'));
    expect(JSON.stringify(await agent.json('list_sessions'))).toContain(sessionId);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Firefox: Find hubs lists the live hub and not the dead address, and Connect pairs', async ({
  extPage,
  openExtensionWindow,
}) => {
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    const onboarding = await extPage('/onboarding.html');
    await onboarding.evaluate((urls) => chrome.storage.local.set({ hostProbeOverride: urls }), [lanUrl, DEAD_ADDRESS]);
    const options = await openExtensionWindow('options.html');
    await options.click('host-find');
    const found = await options.waitFor(
      () => {
        const list = document.querySelector('[data-testid="host-found"]');
        return list
          ? [...list.querySelectorAll('[data-testid="host-found-item"]')].map((el) => ({
              url: el.getAttribute('data-url'),
              text: el.textContent,
            }))
          : null;
      },
      undefined,
      { what: 'the Find hubs list' },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.url).toBe(lanUrl);
    expect(found[0]!.text).toMatch(/inkup on \S+/);

    await options.click('host-connect');
    await codeForm(options);
    await typeCode(options, await host.nextCode(0));
    await connected(options);
    expect(await pairedUrl(options)).toBe(lanUrl);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Firefox: pasting the pair link the host shows pairs', async ({ extPage, openExtensionWindow }) => {
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    const onboarding = await extPage('/onboarding.html');
    await onboarding.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), lanUrl);
    const options = await openExtensionWindow('options.html');
    await options.click('host-other-address');
    await options.click('host-pair');
    await codeForm(options);
    await fill(options, 'host-url', `inkup://pair?url=${lanUrl}&code=${await host.nextCode(0)}`);
    await options.click('host-pair');
    await connected(options);
    expect(await pairedUrl(options)).toBe(lanUrl);
  } finally {
    await host.kill();
    data.remove();
  }
});
