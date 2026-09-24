// H1 proof (ADR 0004): a paired extension streams a live Session to the real host binary. The host runs with
// --auto-approve-pairing (test only); pairing goes through the options page like a reviewer's would. The host's read
// API must end up with exactly the extension's events (no loss, no duplicates) and its screenshot and audio blobs,
// including when the host is killed mid-Session and restarted on the same data dir.
//
// H3 proof: after Process (stubbed LLM) the host holds the Change Items; an agent resolves one over MCP, and the
// review page shows the note on the item's card.
//
// H2 proof: the host's user starts a Session from the host (the TUI's `s` key sends the same command), and the
// host's state model, which the TUI renders, shows it live; pause, draw mode and stop follow the same way.
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { messageReply, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test } from './fixtures';
import { HostProcess, tempDataDir } from './helpers/host';
import { drawAnnotation, expectHostMatches, pair, startRecording, stop } from './helpers/host-session';
import { McpClient } from './helpers/mcp';
import { storeRows } from './helpers/seed';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

test('a paired extension streams its Session, screenshots and audio to the host', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    const { pricing, panel, sessionId } = await startRecording(context, serviceWorker, site, openExtensionPage);
    await expect(panel.getByTestId('host-indicator')).toHaveText('Host connected');
    await drawAnnotation(pricing, panel, 1);
    // Streamed live: the host already has the Annotation before Stop.
    await expect
      .poll(
        async () =>
          (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token)).filter(
            (e) => e.type === 'annotation',
          ).length,
        { timeout: 15_000 },
      )
      .toBe(1);
    await panel.waitForTimeout(2500);
    await stop(context, panel);

    const events = await expectHostMatches(options, host, token, sessionId);
    expect(events[0]!.type).toBe('session_start');
    expect(events.at(-1)!.type).toBe('session_end');
    await expect(options.getByTestId('host-waiting')).toHaveText('Everything is sent.');
  } finally {
    await host.kill();
    data.remove();
  }
});

test('the host dies mid-Session: capture carries on, and the outbox catches it up with nothing lost or doubled', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  let host = await HostProcess.start(data.dir);
  try {
    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    const { pricing, panel, sessionId } = await startRecording(context, serviceWorker, site, openExtensionPage);
    await drawAnnotation(pricing, panel, 1);
    await expect.poll(async () => (await storeRows(options, 'outbox')).length, { timeout: 15_000 }).toBe(0);

    await host.kill();
    await expect(panel.getByTestId('host-indicator')).toContainText('Host offline, will sync');
    // Capture is unaffected: another Annotation, with its screenshot, while the host is down.
    await drawAnnotation(pricing, panel, 2);
    await expect.poll(async () => (await storeRows(options, 'outbox')).length).toBeGreaterThan(0);
    await expect(panel.getByTestId('host-indicator')).toContainText(/Host offline, will sync \(\d+\)/);

    host = await HostProcess.start(data.dir, host.port);
    await expect(panel.getByTestId('host-indicator')).toHaveText('Host connected', { timeout: 20_000 });
    await drawAnnotation(pricing, panel, 3);
    await panel.waitForTimeout(2500);
    await stop(context, panel);

    const events = await expectHostMatches(options, host, token, sessionId);
    expect(ofType(events, 'annotation')).toHaveLength(3);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Change Items reach the host, an agent starts one (In work) and resolves it (Done) over MCP, and the review page shows both', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const stub = await startAnthropicStub({
    onMessage: (req) =>
      messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: "Move 'Get started' into the header",
              category: 'layout',
              intent: 'The primary CTA should sit in the site header.',
              locations: [
                {
                  role: 'subject',
                  selector: 'button.cta',
                  element: "button 'Get started'",
                  url: '/pricing.html',
                  screenshot: 's1',
                  annotation: 1,
                },
              ],
              evidence: { video: null, screenshots: ['s1'] },
              transcript: 'this button should go in the header',
              confidence: 0.9,
              agent_prompt: 'On /pricing.html move button.cta into the header. See screenshots/s1.png.',
              pinned: false,
            },
          ],
        }),
      ),
  });
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { token } = await pair(serviceWorker, openExtensionPage, host);
    const { pricing, panel, sessionId } = await startRecording(context, serviceWorker, site, openExtensionPage);
    // After startRecording, whose scripted transcript rewrites devOverrides.
    await serviceWorker.evaluate(async (base) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-host',
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
      });
    }, stub.baseURL);
    await drawAnnotation(pricing, panel, 1);

    // While recording, the agent sees the Annotation as a Signal.
    const agent = await McpClient.connect(host.url);
    const origin = site.primaryOrigin;
    await expect
      .poll(
        async () =>
          (await agent.json<{ signals: { kind: string }[] }>('read_items', { url: origin })).signals.map((s) => s.kind),
        { timeout: 15_000 },
      )
      .toEqual(['annotation']);

    await panel.waitForTimeout(2500);
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });

    // The host has the item (Change Items supersede the Signal), with the real screenshot id behind the alias.
    type AgentItem = {
      id: string;
      title: string;
      agent_prompt: string;
      screenshots: string[];
      locations: { selector: string }[];
    };
    await expect
      .poll(async () => (await host.get<unknown[]>(`/api/items?session_id=${sessionId}`, token)).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const open = await agent.json<{ items: AgentItem[]; signals: unknown[] }>('read_items', { url: origin });
    expect(open.signals).toEqual([]);
    expect(open.items).toHaveLength(1);
    const [item] = open.items;
    expect(item!.title).toBe("Move 'Get started' into the header");
    expect(item!.locations[0]!.selector).toBe('button.cta');
    expect(item!.screenshots).toHaveLength(1);
    expect(item!.agent_prompt).toContain(`screenshots/${item!.screenshots[0]}.png`);
    const shot = await agent.call('get_screenshot', { id: item!.screenshots[0] });
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    // A review edit reaches the host too, under the same item id.
    const card = review.getByTestId('change-item').first();
    await card.getByTestId('edit-item').click();
    await card.getByTestId('edit-title').fill('Put Get started in the header');
    await card.getByTestId('save-item').click();
    await expect
      .poll(async () => (await agent.json<{ item: { title: string } }>('get_item', { id: item!.id })).item.title, {
        timeout: 15_000,
      })
      .toBe('Put Get started in the header');

    // E13: the agent says it started: the card shows In work, with the agent's MCP client name; it is no longer open.
    const shown = card.getByTestId('item-resolution');
    const started = await agent.json<{ status: string; agent: string }>('start_item', { id: item!.id });
    expect(started).toMatchObject({ status: 'in_progress', agent: 'inkup-e2e' });
    await expect(shown).toHaveAttribute('data-status', 'in_progress', { timeout: 15_000 });
    await expect(shown.getByTestId('item-resolution-label')).toHaveText('In work');
    await expect(shown.getByTestId('item-resolution-by')).toHaveText('inkup-e2e · just now');
    await expect(shown.getByTestId('item-resolution-note')).toHaveCount(0);
    expect((await agent.json<{ items: unknown[] }>('read_items', { url: origin })).items).toEqual([]);
    expect(
      (await agent.json<{ items: { id: string }[] }>('read_items', { url: origin, status: 'in_progress' })).items.map(
        (i) => i.id,
      ),
    ).toEqual([item!.id]);

    const note = 'Moved button.cta into <header> in pricing.html.';
    await agent.json('resolve_item', { id: item!.id, status: 'resolved', note });
    await expect(shown).toHaveAttribute('data-status', 'resolved', { timeout: 15_000 });
    await expect(shown.getByTestId('item-resolution-label')).toHaveText('Done');
    await expect(shown.getByTestId('item-resolution-note')).toHaveText(note);
    await expect(shown.getByTestId('item-resolution-by')).toHaveText('inkup-e2e · just now');
    // A done item cannot be started again.
    const reopened = await agent.call('start_item', { id: item!.id });
    expect(reopened.isError).toBe(true);

    const resolved = await agent.json<{ items: (AgentItem & { resolution: { note: string } })[] }>('read_items', {
      url: origin,
      status: 'resolved',
    });
    expect(resolved.items[0]!.resolution.note).toBe(note);
    expect((await agent.json<{ items: unknown[] }>('read_items', { url: origin })).items).toEqual([]);
  } finally {
    await host.kill();
    data.remove();
    await stub.close();
  }
});

test('a command from the host starts a Session in the browser, and the host shows it live until stopped', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  type HostState = {
    clients: { id: string; connected: boolean }[];
    sessions: { id: string; live: boolean; paused: boolean; client_id: string }[];
    timeline: { session_id: string } | null;
  };
  type Outcome = { ok: boolean; session_id: string | null; message: string | null };
  try {
    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    await pricing.bringToFront();
    const state = () => host.get<HostState>('/api/state', token);
    const [client] = (await state()).clients;
    expect(client).toMatchObject({ connected: true });
    const command = (body: object) => host.post<Outcome>(`/api/clients/${client!.id}/commands`, token, body);

    // Nothing is recording: the browser refuses a pause and says why.
    expect(await command({ command: 'pause' })).toEqual({
      status: 200,
      body: { ok: false, session_id: null, message: 'No Session is recording.' },
    });

    const started = await command({ command: 'start_session' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, message: null });
    const sessionId = started.body.session_id!;
    expect(await activeSessionId(serviceWorker)).toBe(sessionId);
    // Audio only: screen sharing needs a click in the browser.
    const sessions = await storeRows<{ id: string; status: string; video_off_reason: string | null }>(
      options,
      'sessions',
    );
    expect(sessions.find((x) => x.id === sessionId)).toMatchObject({
      status: 'recording',
      video_off_reason: 'unavailable',
    });

    // The host's state model (what the TUI renders) shows the Session live on this client, with its timeline.
    await expect
      .poll(
        async () => {
          const s = await state();
          return { live: s.sessions.find((x) => x.id === sessionId), timeline: s.timeline?.session_id };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        live: expect.objectContaining({ live: true, paused: false, client_id: client!.id }),
        timeline: sessionId,
      });
    const again = await command({ command: 'start_session' });
    expect(again.body).toMatchObject({ ok: false, message: 'A Session is already recording.' });

    expect((await command({ command: 'set_draw_mode', draw_mode: true })).body).toEqual({
      ok: true,
      session_id: sessionId,
      message: null,
    });
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async () =>
            ((await chrome.storage.session.get('activeSession')).activeSession as { draw_mode: boolean }).draw_mode,
        ),
      )
      .toBe(true);

    expect((await command({ command: 'pause' })).body).toMatchObject({ ok: true, session_id: sessionId });
    await expect
      .poll(async () => (await state()).sessions.find((x) => x.id === sessionId)?.paused, { timeout: 15_000 })
      .toBe(true);
    expect((await command({ command: 'resume' })).body).toMatchObject({ ok: true, session_id: sessionId });
    await expect
      .poll(async () => (await state()).sessions.find((x) => x.id === sessionId)?.paused, { timeout: 15_000 })
      .toBe(false);

    const events = await sessionEvents(options, sessionId);
    expect(ofType(events, 'session_pause').map((e) => e.via)).toEqual(['button']);
    expect(ofType(events, 'session_resume')).toHaveLength(1);

    const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    expect((await command({ command: 'stop' })).body).toEqual({ ok: true, session_id: sessionId, message: null });
    await review;
    expect(await activeSessionId(serviceWorker)).toBeNull();
    await expect
      .poll(async () => (await state()).sessions.find((x) => x.id === sessionId)?.live, { timeout: 15_000 })
      .toBe(false);
  } finally {
    await host.kill();
    data.remove();
  }
});
