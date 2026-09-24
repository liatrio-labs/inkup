// F6 proof (#12): what reaches the Host besides a Session streamed live, and what Forget leaves behind. Against the
// real host binary:
// (a) a Session recorded before pairing is offered as "Upload 1 earlier Session" once paired, and accepting it lands
//     every event and blob on the host once;
// (b) Forget has the host revoke the token: the old token gets 401;
// (c) a Session restored from an export zip while paired reaches the host;
// (d) Forget while the outbox uploads a large backlog: nothing is sent after it, and nothing is on the host twice.
import type { Page } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { buildLongSession } from '../../scripts/gen-long-session.ts';
import { expect, test } from './fixtures';
import { exportAndUnzip } from './helpers/export';
import { HostProcess, tempDataDir } from './helpers/host';
import { drawAnnotation, expectHostMatches, pair, startRecording, stop } from './helpers/host-session';
import { seedSession, storeRows } from './helpers/seed';

test.use({ fakeAudio: 'review-two-notes.wav' });

/** The read API's answer status for `token`. */
async function status(host: HostProcess, path: string, token: string): Promise<number> {
  return (await fetch(`${host.url}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;
}

async function forget(options: Page) {
  await options.getByTestId('host-forget').click();
  await expect(options.getByTestId('host-hint')).toBeVisible({ timeout: 20_000 });
  await expect(options.getByTestId('host-forget-note')).toHaveCount(0);
}

test('a Session recorded before pairing is offered once and uploaded whole; Forget revokes the token on the host', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    // Recorded with no host paired: nothing is queued for one.
    const { pricing, panel, sessionId } = await startRecording(context, serviceWorker, site, openExtensionPage);
    await drawAnnotation(pricing, panel, 1);
    await panel.waitForTimeout(2500);
    await stop(context, panel);
    expect(await storeRows(panel, 'outbox')).toEqual([]);

    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    expect((await host.get<{ id: string }[]>('/api/sessions', token)).map((s) => s.id)).not.toContain(sessionId);
    await expect(options.getByTestId('host-backfill-offer')).toHaveAttribute('data-count', '1');
    await expect(options.getByTestId('host-backfill')).toHaveText('Upload 1 earlier Session');

    // The one-time notice in the side panel: Upload.
    const idle = await openExtensionPage('sidepanel.html');
    const notice = idle.getByTestId('host-backfill-notice');
    await expect(notice).toHaveAttribute('data-count', '1');
    await notice.getByTestId('host-backfill').click();
    await expect(notice).toHaveCount(0);

    await expectHostMatches(options, host, token, sessionId);
    // Nothing more to offer, and the notice does not come back.
    await expect(options.getByTestId('host-backfill-offer')).toHaveCount(0);
    await idle.reload();
    await expect(idle.getByTestId('previous-sessions')).toBeVisible();
    await expect(idle.getByTestId('host-backfill-notice')).toHaveCount(0);

    // Forget: the host revokes the token before the extension drops it.
    expect(await status(host, '/api/sessions', token)).toBe(200);
    await forget(options);
    expect(await status(host, '/api/sessions', token)).toBe(401);
    expect(await status(host, `/blobs/${encodeURIComponent(`${sessionId}:audio`)}`, token)).toBe(401);
    // The Session stays on the host for its agents.
    const agent = host.createAgentToken('checker');
    expect((await host.get<{ id: string }[]>('/api/sessions', agent)).map((s) => s.id)).toContain(sessionId);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('a Session restored from an export zip while paired reaches the host', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { pricing, panel } = await startRecording(context, serviceWorker, site, openExtensionPage);
    await drawAnnotation(pricing, panel, 1);
    await panel.waitForTimeout(2500);
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    const sessionId = new URL(review.url()).searchParams.get('session')!;
    const { zip } = await exportAndUnzip(review, serviceWorker);
    await review.close();

    const list = await openExtensionPage('sessions.html');
    const row = list.locator(`[data-session="${sessionId}"]`);
    await row.getByTestId('delete-session').click();
    await row.getByTestId('confirm-delete').click();
    await expect(list.getByTestId('session-row')).toHaveCount(0);

    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    await list.getByTestId('restore-input').setInputFiles(zip);
    await expect(list.getByTestId('restore-done')).toHaveAttribute('data-session', sessionId);
    await expectHostMatches(options, host, token, sessionId);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Forget while the outbox drains: what is on the wire finishes, nothing is sent after, nothing twice', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(180_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    // A backlog big enough to be mid-drain when Forget is clicked: about 5,000 events and 1,200 screenshots.
    const { doc } = buildLongSession({ minutes: 60, everyMs: 3_000 });
    const blank = await openExtensionPage('sessions.html');
    await expect
      .poll(() => blank.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
      .toBe(true);
    await seedSession(blank, doc);
    await blank.close();
    const sessionId = doc.session.id;

    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    const agent = host.createAgentToken('checker');
    // Every message and blob upload the service worker sends from here on, in order.
    await serviceWorker.evaluate(() => {
      const sent: string[] = [];
      const blobs: string[] = [];
      Object.assign(globalThis, { __sent: sent, __blobs: blobs });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        sent.push((JSON.parse(String(data)) as { type: string }).type);
        return send.call(this, data);
      };
      const fetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (init?.method === 'PUT') {
          sent.push('blob');
          blobs.push(String(input));
        }
        return fetch(input, init);
      };
    });
    await expect(options.getByTestId('host-backfill-offer')).toHaveAttribute('data-count', '1');
    await options.getByTestId('host-backfill').click();
    const onHost = async () =>
      (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, agent).catch(() => [])).length;
    // Forget during the screenshot uploads, which go over HTTP and so do not stop with the WebSocket: every event is
    // on the host, and screenshots are still waiting.
    await expect.poll(onHost, { intervals: [50], timeout: 60_000 }).toBe(doc.events.length);
    await expect
      .poll(
        async () =>
          (await serviceWorker.evaluate(() => (globalThis as unknown as { __sent: string[] }).__sent)).includes('blob'),
        { intervals: [20] },
      )
      .toBe(true);
    expect(
      (await storeRows<{ kind: string }>(options, 'outbox')).filter((r) => r.kind === 'blob').length,
      'still uploading when Forget is clicked',
    ).toBeGreaterThan(100);

    await forget(options);
    expect(await storeRows(options, 'outbox')).toEqual([]);
    expect(await status(host, '/api/sessions', token)).toBe(401);

    // Nothing arrives after Forget: the host's count holds still, and the service worker sent nothing after `forget`.
    const after = await onHost();
    await options.waitForTimeout(3_000);
    expect(await onHost()).toBe(after);
    const sent = await serviceWorker.evaluate(() => (globalThis as unknown as { __sent: string[] }).__sent);
    expect(sent.filter((t) => t === 'forget')).toHaveLength(1);
    expect(sent.slice(sent.indexOf('forget') + 1)).toEqual([]);
    expect(sent.filter((t) => t === 'event').length).toBeGreaterThan(0);
    expect(sent.filter((t) => t === 'blob').length).toBeLessThan(doc.blobs.length);
    const sessions = await host.get<{ id: string; event_count: number }[]>('/api/sessions', agent);
    expect(sessions.find((s) => s.id === sessionId)?.event_count).toBe(after);
    // And nothing twice: no screenshot uploaded twice, every event on the host one of the Session's, once.
    const uploads = await serviceWorker.evaluate(() => (globalThis as unknown as { __blobs: string[] }).__blobs);
    expect(new Set(uploads).size).toBe(uploads.length);
    const ids = (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, agent)).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(doc.events.map((e) => e.id));
    expect(ids.every((id) => known.has(id))).toBe(true);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('Forget while the host is down: the token is revoked once the host is back', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const data = tempDataDir();
  let host = await HostProcess.start(data.dir);
  try {
    const { options, token } = await pair(serviceWorker, openExtensionPage, host);
    await host.kill();
    await options.getByTestId('host-forget').click();
    await expect(options.getByTestId('host-forget-note')).toContainText('could not be reached', { timeout: 20_000 });

    // Back on the same port and data dir: pairing again asks it to revoke the old token first.
    host = await HostProcess.start(data.dir, host.port);
    expect(await status(host, '/api/sessions', token)).toBe(200);
    const again = await pair(serviceWorker, openExtensionPage, host);
    await expect.poll(() => status(host, '/api/sessions', token)).toBe(401);
    expect(await status(host, '/api/sessions', again.token)).toBe(200);
    expect(
      await serviceWorker.evaluate(async () => (await chrome.storage.local.get('hostRevokePending')).hostRevokePending),
    ).toEqual([]);
  } finally {
    await host.kill();
    data.remove();
  }
});
