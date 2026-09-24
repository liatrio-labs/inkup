// E10 proof: Cancel and Mute.
//
// Cancel (paired with the real host): a Session started from the toolbar gets a drawn Annotation and an Object Select
// pick, then the toolbar's red Cancel. The toolbar goes idle at once with "Session discarded · Undo".
// (a) Undo inside the window: the Session is kept as if stopped (its review page opens), with both Annotations, and
//     the host holds it with its audio.
// (b) The window lapses (shortened by devOverrides): no Session row, events, blobs or outbox rows are left, and the
//     host's read API, /api/state and MCP list_sessions no longer know it.
// (c) The service worker is stopped mid-window: the next worker still deletes it, here and on the host.
//
// Mute: the fake mic plays fixtures/audio/voice-session.wav and the scripted transcript replays its clips as Web
// Speech would. Muted from the page (Alt+Shift+M) before the isolated "pause" at 10.8 s and unmuted from the panel
// after it: no transcript segment reaches into the muted span, that "pause" does not pause, both events are logged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { ALLOW_TAB_CAPTURE, AUDIO_DIR, expect, grantMic, test, useScript, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { storeRows } from './helpers/seed';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.describe('Cancel', () => {
  test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

  /** Paired, recording from the toolbar, with a drawn Annotation and a typed Object Select pick that reached the host. */
  async function recordAndCancel(
    context: BrowserContext,
    sw: Worker,
    site: { primaryOrigin: string },
    openExtensionPage: (p: string) => Promise<Page>,
    undoMs?: number,
  ) {
    const data = tempDataDir();
    const host = await HostProcess.start(data.dir);
    const { options, token } = await pairThroughOptions(sw, openExtensionPage, host);
    await useScriptedTranscript(sw, 'pricing-cta.json', 2000);
    if (undoMs)
      await sw.evaluate(
        async (ms) =>
          chrome.storage.local.set({
            devOverrides: {
              ...((await chrome.storage.local.get('devOverrides')).devOverrides as object),
              discardUndoMs: ms,
            },
          }),
        undoMs,
      );
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
      (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
    });
    await pricing.getByTestId('toolbar-start').click();
    await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
    const sessionId = (await activeSessionId(sw))!;
    await expect(pricing.getByTestId('toolbar-cancel')).toBeVisible();

    const cta = (await pricing.locator('button.cta').boundingBox())!;
    // One click: a state push landing mid-click no longer swaps the button out from under it (F1).
    await pricing.getByTestId('toolbar-draw').click();
    await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
    await circle(pricing, cta);
    await pricing.getByTestId('toolbar-object-select').click();
    await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
    await pricing.mouse.move(cta.x + 10, cta.y + 10);
    await pricing.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
    await pricing.getByTestId('object-select-input').fill('Make this roomier');
    await pricing.keyboard.press('Enter');
    const annotations = () =>
      host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token).then(
        (ev) => ev.filter((e) => e.type === 'annotation').length,
        () => 0,
      );
    await expect.poll(annotations, { timeout: 20_000 }).toBe(2);

    await pricing.getByTestId('toolbar-cancel').click();
    // Over at once: idle toolbar, no ink or pick outline left, and the Undo toast.
    await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
    await expect(pricing.getByTestId('toolbar-toast')).toHaveText('Session discarded · Undo');
    await expect(pricing.getByTestId('object-select-highlight')).toHaveCount(0);
    const cleanup = async () => {
      await host.kill();
      data.remove();
    };
    return { host, token, options, pricing, sessionId, cleanup };
  }

  /** Nothing of the Session is left in the extension, and the host no longer knows it anywhere. */
  async function expectGone(page: Page, host: HostProcess, token: string, sessionId: string) {
    await expect
      .poll(async () => (await storeRows<{ id: string }>(page, 'sessions')).some((s) => s.id === sessionId), {
        timeout: 30_000,
      })
      .toBe(false);
    expect(await sessionEvents(page, sessionId)).toEqual([]);
    expect((await storeRows<{ session_id: string }>(page, 'blobs')).filter((b) => b.session_id === sessionId)).toEqual(
      [],
    );
    // The discard row itself goes once the host acked it.
    await expect
      .poll(
        async () => (await storeRows<{ session_id: string }>(page, 'outbox')).filter((r) => r.session_id === sessionId),
        { timeout: 30_000 },
      )
      .toEqual([]);
    await expect
      .poll(async () => (await host.get<{ id: string }[]>('/api/sessions', token)).map((s) => s.id), {
        timeout: 30_000,
      })
      .not.toContain(sessionId);
    expect(JSON.stringify(await host.get('/api/state', token))).not.toContain(sessionId);
    const agent = await McpClient.connect(host.url);
    const listed = await agent.json<{ sessions: { id: string }[] }>('list_sessions');
    expect(listed.sessions.map((s) => s.id)).not.toContain(sessionId);
    const res = await fetch(`${host.url}/api/sessions/${sessionId}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  }

  test('(a) Undo inside the window keeps it as a stopped Session with its Annotations, on the host too', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(150_000);
    const { host, token, options, pricing, sessionId, cleanup } = await recordAndCancel(
      context,
      serviceWorker,
      site,
      openExtensionPage,
    );
    try {
      // The outbox holds the Session's rows during the window: the audio is not on the host yet.
      const audioId = `${sessionId}:audio`;
      expect((await host.blob(audioId, token)).status).toBe(404);
      const review = context.waitForEvent('page', (p) => p.url().includes(`/review.html?session=${sessionId}`));
      await pricing.getByTestId('toolbar-undo-discard').click();
      await review;
      await expect(pricing.getByTestId('toolbar-toast')).toBeHidden();
      await expect
        .poll(
          async () =>
            (await storeRows<{ id: string; status: string }>(options, 'sessions')).find((s) => s.id === sessionId)
              ?.status,
        )
        .toBe('ended');
      const events = await sessionEvents(options, sessionId);
      expect(
        ofType(events, 'annotation').map((a) => (a.close_reason === 'object_select' ? `pick:${a.comment}` : 'drawn')),
      ).toEqual(['drawn', 'pick:Make this roomier']);
      expect(events.at(-1)!.type).toBe('session_end');
      // Released: everything reaches the host, the audio included.
      await expect.poll(async () => (await storeRows(options, 'outbox')).length, { timeout: 30_000 }).toBe(0);
      expect((await host.blob(audioId, token)).status).toBe(200);
      const remote = await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token);
      expect(remote.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
      // Undo held: well past the window, it is still there.
      await options.waitForTimeout(11_000);
      expect((await storeRows<{ id: string }>(options, 'sessions')).some((s) => s.id === sessionId)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('(b) the window lapses: no rows or blobs are left, and the host, /api/state and MCP no longer have it', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(150_000);
    const { host, token, options, sessionId, cleanup } = await recordAndCancel(
      context,
      serviceWorker,
      site,
      openExtensionPage,
      3000,
    );
    try {
      // Held during the window: the audio never went.
      expect((await host.blob(`${sessionId}:audio`, token)).status).toBe(404);
      await expectGone(options, host, token, sessionId);
      expect((await host.blob(`${sessionId}:audio`, token)).status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  test('(c) the service worker is stopped mid-window: the next one still discards it', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(150_000);
    const { host, token, options, sessionId, cleanup } = await recordAndCancel(
      context,
      serviceWorker,
      site,
      openExtensionPage,
      6000,
    );
    try {
      // Once Cancel has saved the Session (so no Stop is cut short), before the deadline.
      await expect
        .poll(
          async () =>
            (await storeRows<{ id: string; status: string }>(options, 'sessions')).find((s) => s.id === sessionId)
              ?.status,
          { timeout: 20_000 },
        )
        .toBe('ended');
      const pending = await options.evaluate(
        async () => (await chrome.storage.local.get('discardPending')).discardPending as { deadline: number }[],
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.deadline).toBeGreaterThan(Date.now());
      const cdp = await context.newCDPSession(options);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await options.waitForTimeout(Math.max(0, pending[0]!.deadline - Date.now()) + 500);
      // Anything that wakes the extension starts a new worker, which sweeps; the panel does here.
      const panel = await openExtensionPage('sidepanel.html');
      await expectGone(panel, host, token, sessionId);
    } finally {
      await cleanup();
    }
  });
});

test.describe('Mute', () => {
  test.use({ fakeAudio: 'voice-session.wav' });

  /** Web Speech-like arrival, as in voice-commands.spec.ts. */
  const ARRIVAL_MS = 600;
  const clips = JSON.parse(readFileSync(join(AUDIO_DIR, 'voice-session.timing.json'), 'utf8')) as {
    start: number;
    end: number;
    text: string;
  }[];
  const script = {
    timestamp_quality: 'approximate' as const,
    cues: clips.map((c) => ({
      at_ms: Math.round(c.end * 1000) + ARRIVAL_MS,
      duration_ms: Math.round((c.end - c.start) * 1000) + ARRIVAL_MS - 300,
      text: c.text,
    })),
  };
  const muted = (sw: Worker) =>
    sw.evaluate(
      async () =>
        !!((await chrome.storage.session.get('activeSession')).activeSession as { muted?: unknown } | null)?.muted,
    );
  const sessionTime = (sw: Worker) =>
    sw.evaluate(
      async () => Date.now() - ((await chrome.storage.session.get('activeSession')).activeSession as { t0: number }).t0,
    );

  test('muted: nothing is transcribed in the muted span and a spoken "pause" is ignored; both events are logged', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(90_000);
    await useScript(serviceWorker, script);
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    const sessionId = (await activeSessionId(serviceWorker))!;
    // Speech is transcribed until the mute: "scratch that" ends at 5.0 s.
    await expect
      .poll(async () => ofType(await sessionEvents(panel, sessionId), 'transcript_segment').map((s) => s.text), {
        timeout: 20_000,
      })
      .toContain('scratch that');

    // Alt+Shift+M on the page, which has the Session by the time the panel says Recording (F1).
    await pricing.bringToFront();
    await pricing.keyboard.press('Alt+Shift+M');
    await expect.poll(() => muted(serviceWorker)).toBe(true);
    await expect(panel.getByTestId('mute')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('muted-note')).toBeVisible();

    // Past the isolated "pause" (10.8–11.3 s, arriving ~11.9 s) and its silence gate, then back on from the panel.
    await expect.poll(() => sessionTime(serviceWorker), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(13_500);
    await panel.getByTestId('mute').click();
    await expect(panel.getByTestId('mute')).toHaveAttribute('aria-pressed', 'false');
    await panel.waitForTimeout(1000);

    const events = await sessionEvents(panel, sessionId);
    const [off] = ofType(events, 'mic_muted');
    const [on] = ofType(events, 'mic_unmuted');
    expect(off).toMatchObject({ via: 'shortcut' });
    expect(on).toMatchObject({ via: 'button' });
    // The mute has to cover the isolated "pause" for this to prove anything.
    expect(off!.t).toBeLessThan(10_800);
    expect(on!.t).toBeGreaterThan(11_900);
    const segments = ofType(events, 'transcript_segment');
    expect(segments.filter((s) => s.t < on!.t && s.t_end > off!.t)).toEqual([]);
    expect(segments.map((s) => s.text)).toContain('this button');
    expect(ofType(events, 'voice_command').filter((c) => c.command === 'pause')).toEqual([]);
    expect(ofType(events, 'session_pause')).toEqual([]);
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await test.info().attach('events.json', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
  });
});
