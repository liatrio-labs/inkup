// Recording a Session through the side panel and checking that the real host binary holds exactly what the
// extension stored: shared by host.spec.ts and host-sync.spec.ts.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../../packages/core/src/timeline.ts';
import { expect, grantMic, useScriptedTranscript } from '../fixtures';
import { circle } from './draw';
import type { HostProcess } from './host';
import { storeRows } from './seed';
import { activeSessionId, ofType, sessionEvents } from './session';

export async function pair(
  sw: Worker,
  openExtensionPage: (p: string) => Promise<Page>,
  host: HostProcess,
): Promise<{ options: Page; token: string }> {
  await sw.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), host.url);
  const options = await openExtensionPage('options.html');
  await expect(options.getByTestId('host-hint')).toHaveText(/Pair a host to hand items to agents/);
  // The address the tests' host listens on; a reviewer on the default port never opens this.
  await options.getByTestId('host-other-address').click();
  await expect(options.getByTestId('host-url')).toHaveValue(host.url);
  await options.getByTestId('host-pair').click();
  await expect(options.getByTestId('host-status')).toHaveAttribute('data-state', 'connected');
  const token = await sw.evaluate(
    async () => ((await chrome.storage.local.get('hostPairing')).hostPairing as { token: string }).token,
  );
  return { options, token };
}

export async function startRecording(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  openExtensionPage: (p: string) => Promise<Page>,
) {
  await useScriptedTranscript(sw, 'pricing-cta.json', 2000);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  const sessionId = (await activeSessionId(sw))!;
  return { pricing, panel, sessionId };
}

export async function drawAnnotation(pricing: Page, panel: Page, count: number) {
  await pricing.bringToFront();
  await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
  await expect(panel.getByTestId('annotation-count')).toHaveText(String(count), { timeout: 10_000 });
}

export async function stop(context: BrowserContext, panel: Page) {
  const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  await review;
  await expect(panel.getByTestId('status')).toHaveText('Ready');
}

/** Waits for the outbox to drain, then checks the host holds exactly the extension's Session. */
export async function expectHostMatches(page: Page, host: HostProcess, token: string, sessionId: string) {
  await expect.poll(async () => (await storeRows(page, 'outbox')).length, { timeout: 30_000 }).toBe(0);
  const local = (await sessionEvents(page, sessionId)).map(
    ({ seq: _s, session_id: _id, ...e }: TimelineEvent & { seq?: number; session_id?: string }) => e,
  );
  const remote = await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token);
  const ids = (events: TimelineEvent[]) => events.map((e) => e.id).sort();
  expect(new Set(ids(remote)).size, 'no duplicate events on the host').toBe(remote.length);
  expect(ids(remote)).toEqual(ids(local));
  const byId = new Map(remote.map((e) => [e.id, e]));
  for (const e of local) expect(byId.get(e.id), `event ${e.type} ${e.id}`).toEqual(e);

  const sessions = await host.get<{ id: string; event_count: number; url: string }[]>('/api/sessions', token);
  expect(sessions.find((s) => s.id === sessionId)).toMatchObject({
    event_count: local.length,
    url: expect.stringContaining('/pricing.html'),
  });

  // Every screenshot and the audio, byte for byte in size.
  const blobs = await storeRows<{ id: string; session_id: string; kind: string; size: number; mime: string }>(
    page,
    'blobs',
  );
  const mine = blobs.filter((b) => b.session_id === sessionId && (b.kind === 'screenshot' || b.kind === 'audio'));
  expect(mine.filter((b) => b.kind === 'screenshot').length).toBe(ofType(local, 'screenshot').length);
  expect(mine.some((b) => b.kind === 'audio')).toBe(true);
  for (const b of mine) {
    expect(await host.blob(b.id, token), `${b.kind} ${b.id}`).toEqual({ status: 200, type: b.mime, bytes: b.size });
  }
  return local;
}
