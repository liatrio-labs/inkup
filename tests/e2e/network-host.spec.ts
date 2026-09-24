// E14 proof (ADR 0006): the extension pairs with a Host in network mode as another machine would. The real host runs
// with --network and --print-pairing-codes (test only: the code the TUI would show goes to stdout), and everything
// reaches it on this machine's LAN address, which the host counts as remote: it asks for the code, and wants a token
// for /mcp, /api and /blobs.
//
// - By address: a wrong code is refused, the right one pairs; a Session streams to the host (events and blobs over
//   the LAN address); MCP on the LAN address is 401 without a token and works with an agent token.
// - Find hubs, with the probe list set to [the live hub, a dead address]: only the live one is listed; Connect pairs.
// - Pasting the `inkup://pair` link the TUI shows pairs.
import type { Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { HostProcess, lanAddress, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { storeRows } from './helpers/seed';
import { activeSessionId } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

const LAN = lanAddress();
test.skip(!LAN, 'no LAN address on this machine');

/** A network-mode host, and its address as another machine reaches it. */
async function startNetworkHost(dir: string): Promise<{ host: HostProcess; lanUrl: string }> {
  const host = await HostProcess.start(dir, 0, {
    network: { mdnsName: `inkup-e2e-${process.pid}-${test.info().parallelIndex}` },
  });
  return { host, lanUrl: `http://${LAN}:${host.port}` };
}

/** Not a hub: TEST-NET-1 answers nothing, so its probe runs into the timeout. */
const DEAD_ADDRESS = 'http://192.0.2.1:49999';

async function pairingToken(sw: Worker): Promise<{ url: string; token: string }> {
  return sw.evaluate(
    async () => (await chrome.storage.local.get('hostPairing')).hostPairing as { url: string; token: string },
  );
}

async function typeCode(options: Page, code: string) {
  await options.getByTestId('host-code').fill(code);
  await options.getByTestId('host-code-submit').click();
}

/** Another 6-digit code than `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('pairs with a network hub by its code on the LAN address, streams a Session there, and MCP there wants a token', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    await serviceWorker.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), lanUrl);
    const options = await openExtensionPage('options.html');
    await options.getByTestId('host-other-address').click();
    await expect(options.getByTestId('host-url')).toHaveValue(lanUrl);
    await options.getByTestId('host-pair').click();
    // The host wants the code it shows.
    await expect(options.getByTestId('host-code-form')).toBeVisible();
    const code = await host.nextCode(0);

    await typeCode(options, wrong(code));
    await expect(options.getByTestId('host-error')).toContainText('Wrong code');
    await expect(options.getByTestId('host-status')).toHaveCount(0);

    await typeCode(options, code);
    await expect(options.getByTestId('host-status')).toHaveAttribute('data-state', 'connected');
    await expect(options.getByTestId('host-network-note')).toContainText('Unencrypted network hub');
    const { url, token } = await pairingToken(serviceWorker);
    expect(url).toBe(lanUrl);

    // A Session streams to the host over the LAN address.
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    // The toolbar icon shows the page toolbar, whose host dot says the same.
    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
      (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
    });
    await expect(pricing.getByTestId('toolbar-host')).toHaveAttribute(
      'title',
      'Host connected · Unencrypted network hub',
    );
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await expect(panel.getByTestId('host-indicator')).toHaveAttribute('title', /Unencrypted network hub/);
    await panel.getByTestId('draw-toggle').click();
    const sessionId = (await activeSessionId(serviceWorker))!;
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
    await panel.waitForTimeout(2500);
    const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    await review;
    await expect.poll(async () => (await storeRows(options, 'outbox')).length, { timeout: 30_000 }).toBe(0);

    const get = (path: string, bearer?: string) =>
      fetch(`${lanUrl}${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    expect((await get(`/api/sessions/${sessionId}/events`)).status, 'no token from the LAN').toBe(401);
    const events = (await (await get(`/api/sessions/${sessionId}/events`, token)).json()) as TimelineEvent[];
    expect(events[0]!.type).toBe('session_start');
    expect(events.at(-1)!.type).toBe('session_end');
    expect(events.filter((e) => e.type === 'annotation')).toHaveLength(1);
    const blobs = await storeRows<{ id: string; session_id: string; kind: string; size: number }>(options, 'blobs');
    const mine = blobs.filter((b) => b.session_id === sessionId && (b.kind === 'screenshot' || b.kind === 'audio'));
    expect(mine.length).toBeGreaterThan(1);
    for (const b of mine) {
      const res = await get(`/blobs/${encodeURIComponent(b.id)}`, token);
      expect(res.status, `${b.kind} ${b.id}`).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(b.size);
    }

    // An agent on another machine: nothing without a token, everything with an agent token.
    await expect(McpClient.connect(lanUrl)).rejects.toThrow(/401/);
    const agent = await McpClient.connect(lanUrl, host.createAgentToken('e2e agent'));
    const sessions = await agent.json<{ sessions: { id: string }[] } | { id: string }[]>('list_sessions');
    expect(JSON.stringify(sessions)).toContain(sessionId);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Find hubs lists the live hub and not the dead address, and Connect pairs with it', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    await serviceWorker.evaluate(
      (urls) => chrome.storage.local.set({ hostProbeOverride: urls }),
      [lanUrl, DEAD_ADDRESS],
    );
    const options = await openExtensionPage('options.html');
    await options.getByTestId('host-find').click();
    await expect(options.getByTestId('host-found')).toHaveAttribute('data-count', '1');
    const hub = options.getByTestId('host-found-item');
    await expect(hub).toHaveAttribute('data-url', lanUrl);
    await expect(hub).toContainText(/inkup on \S+/);
    await expect(hub).toContainText('Unencrypted network hub');

    await hub.getByTestId('host-connect').click();
    await expect(options.getByTestId('host-code-form')).toBeVisible();
    await typeCode(options, await host.nextCode(0));
    await expect(options.getByTestId('host-status')).toHaveAttribute('data-state', 'connected');
    expect((await pairingToken(serviceWorker)).url).toBe(lanUrl);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('pasting the pair link the host shows pairs', async ({ serviceWorker, openExtensionPage }) => {
  const data = tempDataDir();
  const { host, lanUrl } = await startNetworkHost(data.dir);
  try {
    await serviceWorker.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), lanUrl);
    const options = await openExtensionPage('options.html');
    await options.getByTestId('host-other-address').click();
    await options.getByTestId('host-pair').click();
    await expect(options.getByTestId('host-code-form')).toBeVisible();
    // What the TUI shows beside its QR code.
    await options.getByTestId('host-url').fill(`inkup://pair?url=${lanUrl}&code=${await host.nextCode(0)}`);
    await options.getByTestId('host-pair').click();
    await expect(options.getByTestId('host-status')).toHaveAttribute('data-state', 'connected');
    expect((await pairingToken(serviceWorker)).url).toBe(lanUrl);
  } finally {
    await host.kill();
    data.remove();
  }
});
