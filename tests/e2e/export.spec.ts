// Slice 4 proof (docs/PLAN.md): tab video from the panel's Start click, close-panel = Stop, and the export zip.
// The screen picker auto-selects the "Pricing Fixture" tab (--auto-select-tab-capture-source-by-title). Process
// runs against the local Anthropic stub; the zip is unpacked with `unzip` and its recording.webm is played in a
// <video> to check its duration and seeking.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { promptCitations } from '../../packages/core/src/export/bundle.ts';
import { expectedMediaDuration, pauseGaps, sessionToMedia } from '../../packages/core/src/media-time.ts';
import type { ChangeItem } from '../../packages/core/src/process/change-item.ts';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

/** The fields of a stored Session row these tests read. */
interface SessionRow {
  status: string;
  audio: { blob_id: string } | null;
  video: { start_offset_ms: number; duration_ms: number } | null;
  video_off_reason?: string;
  media_deleted_at?: string;
}

async function sessionRow(page: Page, id: string): Promise<SessionRow> {
  return page.evaluate(async (sid) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<SessionRow>((res, rej) => {
      const r = idb.transaction('sessions').objectStore('sessions').get(sid);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }, id);
}

async function blobKinds(page: Page, id: string): Promise<string[]> {
  return page.evaluate(async (sid) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<string[]>((res, rej) => {
      const r = idb.transaction('blobs').objectStore('blobs').index('session_id').getAll(sid);
      r.onsuccess = () => res((r.result as { kind: string }[]).map((b) => b.kind).sort());
      r.onerror = () => rej(r.error);
    });
  }, id);
}

async function startSession(
  context: import('@playwright/test').BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  openExtensionPage: (p: string) => Promise<Page>,
) {
  await useScriptedTranscript(sw, 'pricing-cta.json');
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(sw))!;
  return { pricing, panel, sessionId };
}

/** Clicks Export, waits for chrome.downloads to finish, and unzips the file into a fresh directory. */
async function exportAndUnzip(review: Page, sw: Worker): Promise<{ dir: string; files: string[]; zip: string }> {
  await review.evaluate(() => delete document.body.dataset.exportDownloadId);
  await review.getByTestId('export-zip').click();
  await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
  const item = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!, id);
  expect(item.state).toBe('complete');
  // Playwright stores downloads under a generated name; the page reports the name it asked for.
  await expect(review.getByTestId('export-done')).toContainText(/review-\d{4}-\d\d-\d\d-pricing-fixture\.zip/);
  const dir = mkdtempSync(join(tmpdir(), 'var-export-'));
  execFileSync('unzip', ['-q', item.filename, '-d', dir]);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort();
  return { dir, files, zip: item.filename };
}

/** Loads a WebM into a <video> in an extension page: its duration, and where a seek to the middle lands. */
async function probeVideo(page: Page, file: string) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video failed to load'));
    });
    const duration = video.duration;
    const target = duration / 2;
    const seeked = new Promise((res) => (video.onseeked = res));
    video.currentTime = target;
    await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
    return {
      duration,
      target,
      landed: video.currentTime,
      seekableEnd: video.seekable.length ? video.seekable.end(0) : 0,
      width: video.videoWidth,
    };
  }, b64);
}

test('Start with video, draw, pause, resume, Stop, Process, edit a title, Export: the zip is a working handoff', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const EDITED = 'Put the Get started button in the site header';
  // Two items citing the Annotation's screenshot; the first's time range starts after the resume, so the player
  // has to skip the pause to land on it.
  const stub = await startAnthropicStub({
    onMessage: (req) => {
      const script = scriptOf(req);
      const shot = /screenshot (s\d+)/.exec(script)?.[1] ?? 's1';
      const resume = /\[(\d\d):(\d\d\.\d)\] RESUME/.exec(script);
      const after = resume ? Number(resume[1]) * 60 + Number(resume[2]) + 1 : 3;
      const item = (id: string, title: string, start: number, extra = {}) => ({
        id,
        title,
        category: 'layout',
        intent: 'The primary CTA should sit in the site header instead of the hero card.',
        locations: [
          {
            role: 'subject',
            selector: 'button.cta',
            element: "button 'Get started'",
            url: '/pricing.html',
            screenshot: shot,
            annotation: 1,
          },
        ],
        evidence: { video: { start, end: start + 1.5 }, screenshots: [shot] },
        transcript: 'this button should go in the header',
        confidence: 0.85,
        agent_prompt: `On /pricing.html move button.cta into the header. See screenshots/${shot}.png for the circled button.`,
        pinned: false,
        ...extra,
      });
      return messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            item('item_0001', "Move 'Get started' into the header", after),
            item('item_0002', 'Make the header CTA smaller', 2.5, { category: 'style' }),
          ],
        }),
      );
    },
  });
  try {
    const { pricing, panel, sessionId } = await startSession(context, serviceWorker, site, openExtensionPage);
    // After startSession, which replaces the dev overrides with the scripted transcript.
    await serviceWorker.evaluate(async (base) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-export-key',
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
      });
    }, stub.baseURL);
    await expect(panel.getByTestId('video-status')).toHaveAttribute('data-state', 'recording');

    // Draw around the CTA while the scripted speech says "this button should go in the header".
    await panel.getByTestId('draw-toggle').click();
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
    await expect(panel.getByTestId('captions')).toContainText('this button', { timeout: 10_000 });

    // Pause for ~3 s: the video pauses with the Session.
    await panel.getByTestId('pause').click();
    await expect(panel.getByTestId('status')).toHaveText('Paused');
    await panel.waitForTimeout(3000);
    await panel.getByTestId('resume').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await panel.waitForTimeout(3000);

    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    const stopClickedAt = Date.now();
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await expect(review.getByTestId('evidence-video')).toBeVisible({ timeout: 20_000 });

    // Process through the stub.
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(2, { timeout: 20_000 });

    // Selecting the first item seeks the video to its time, minus the start offset and the pause.
    const row = await sessionRow(review, sessionId);
    const events = await review.evaluate(async (sid) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      return new Promise<TimelineEvent[]>((res) => {
        const r = idb.transaction('events').objectStore('events').index('session_id').getAll(sid);
        r.onsuccess = () => res(r.result);
      });
    }, sessionId);
    const gaps = pauseGaps(events);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.end - gaps[0]!.start).toBeGreaterThan(2500);
    const first = review.locator('[data-testid="change-item"][data-item-id="item_0001"]');
    await expect(first.getByTestId('item-title')).toHaveText("Move 'Get started' into the header");
    // Each Location that has a screenshot shows it inside its own card, under its row, with the Strokes drawn on it.
    for (const loc of await review.getByTestId('item-location').all()) {
      await expect(loc.getByTestId('evidence-shot').locator('img')).toBeVisible();
      await expect(
        loc.getByTestId('evidence-shot').getByTestId('stroke-overlay').locator('path').first(),
      ).toBeAttached();
    }
    await first.getByTestId('item-title').click();
    const run = await review.evaluate(async (sid) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      return new Promise<{ items: ChangeItem[] }[]>((res) => {
        const r = idb.transaction('processRuns').objectStore('processRuns').index('session_id').getAll(sid);
        r.onsuccess = () => res(r.result);
      });
    }, sessionId);
    const start = run.at(-1)!.items.find((i) => i.id === 'item_0001')!.evidence.video!.start * 1000;
    expect(start).toBeGreaterThan(gaps[0]!.end);
    const expectedAt = sessionToMedia(start, { start_offset_ms: row.video!.start_offset_ms, gaps }) / 1000;
    await expect
      .poll(() => review.getByTestId('evidence-video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(expectedAt, 0);

    // Edit that item's title (logged as an item_edit), and a transcript segment.
    await first.getByTestId('edit-item').click();
    await first.getByTestId('edit-title').fill(EDITED);
    await first.getByTestId('save-item').click();
    await expect(review.getByTestId('item-title').filter({ hasText: EDITED })).toHaveCount(1);
    const segment = review.getByTestId('segment-text').first();
    await segment.fill('this button should go in the site header');
    await segment.blur();
    await expect(review.getByText('Edited. Heard:')).toBeVisible();

    // Export.
    const { dir, files } = await exportAndUnzip(review, serviceWorker);
    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    const shots = [...new Set(doc.events.flatMap((e) => (e.type === 'screenshot' ? [e.screenshot_id] : [])))];
    expect(shots.length).toBeGreaterThan(0);
    // Each Annotation's element crop (E4) goes along as screenshots/<id>.crop.png.
    const crops = doc.events.flatMap((e) => (e.type === 'annotation' && e.crop ? [e.crop.path] : []));
    expect(crops.length).toBeGreaterThan(0);
    expect(files).toEqual(
      [
        'audio.webm',
        'recording.webm',
        'review.md',
        ...shots.map((id) => `screenshots/${id}.png`),
        ...crops,
        'session.json',
      ].sort(),
    );
    expect(doc.media.video).toMatchObject({ path: 'recording.webm', seekable: true });
    expect(doc.change_items!.map((i) => i.title)).toContain(EDITED);
    expect(doc.process_run!.acceptance).toEqual({ generated: 2, unedited: 1, rate: 0.5 });
    expect(doc.events.filter((e) => e.type === 'item_edit')).toHaveLength(1);
    expect(doc.events.filter((e) => e.type === 'transcript_edit')).toHaveLength(1);
    expect(readFileSync(join(dir, 'session.json'), 'utf8')).not.toContain('sk-ant-');
    // Every screenshot an agent_prompt cites is in the folder.
    for (const item of doc.change_items!) {
      const cited = promptCitations(item.agent_prompt);
      expect(cited.length).toBeGreaterThan(0);
      for (const id of cited)
        expect(existsSync(join(dir, 'screenshots', `${id}.png`)), `screenshots/${id}.png`).toBe(true);
    }
    const md = readFileSync(join(dir, 'review.md'), 'utf8');
    expect(md).toContain(`. ${EDITED}\n`);
    expect(md).toMatch(/\(recording\.webm#t=[\d.]+,[\d.]+\)/);
    expect(md).toContain('this button should go in the site header');
    for (const id of shots.filter((id) => doc.change_items!.some((i) => i.evidence.screenshots.includes(id))))
      expect(md).toContain(`](screenshots/${id}.png)`);

    // recording.webm lasts from its start to Stop, minus the pause, and seeks. The recorder stops after the Stop
    // click and before session_end, which is logged once audio and video are finalized (seconds on a slow
    // machine), so the duration lies between the two, even when the page stopped repainting long before. The
    // file also starts with the latest frame captured before the recorder started, up to one refresh frame
    // (about 1 s on a static page) early, and the panel pauses its recorder a moment after the logged pause:
    // measured 0.1-0.6 s over the Stop mapping on a 2-CPU container, hence 1.5 s of slack above, 1 s below.
    const clock = { start_offset_ms: doc.media.video!.start_offset_ms, gaps };
    const atClick = expectedMediaDuration(stopClickedAt - doc.session.t0, clock) / 1000;
    const atEnd = expectedMediaDuration(doc.session.duration_ms!, clock) / 1000;
    const probe = await probeVideo(review, join(dir, 'recording.webm'));
    await test.info().attach('video-probe.json', {
      body: JSON.stringify({ ...probe, atClick, atEnd, session_s: doc.session.duration_ms! / 1000 }),
      contentType: 'application/json',
    });
    expect(Number.isFinite(probe.duration)).toBe(true);
    expect(probe.duration).toBeGreaterThan(atClick - 1);
    expect(probe.duration).toBeLessThan(atEnd + 1.5);
    expect(probe.duration).toBeLessThan(doc.session.duration_ms! / 1000 - 2);
    expect(Math.abs(probe.landed - probe.target)).toBeLessThan(0.5);
    expect(probe.seekableEnd).toBeGreaterThan(probe.duration * 0.9);
    expect(probe.width).toBeLessThanOrEqual(1280);

    // After the export, drop the media: transcript, items and screenshots stay.
    await review.getByTestId('delete-media').click();
    await expect(review.getByTestId('media-deleted')).toBeVisible();
    const after = await sessionRow(review, sessionId);
    expect(after.audio).toBeNull();
    expect(after.video).toBeNull();
    expect(after.media_deleted_at).toEqual(expect.any(String));
    expect(await blobKinds(review, sessionId)).toEqual(
      [...shots.map(() => 'screenshot'), ...crops.map(() => 'screenshot_crop')].sort(),
    );
    await expect(review.getByTestId('change-item')).toHaveCount(2);
    await expect(review.getByTestId('transcript-segment')).toHaveCount(1);

    // The other item edits, through the UI: keyboard drag, split, delete, merge. Each is one logged item_edit.
    const ids = () =>
      review.getByTestId('change-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-item-id')));
    const before = await ids();
    await review.getByTestId('drag-handle').first().focus();
    await review.keyboard.press('Space');
    await review.keyboard.press('ArrowDown');
    await review.keyboard.press('Space');
    await expect.poll(ids).toEqual([...before].reverse());
    await review.locator('[data-testid="change-item"][data-item-id="item_0002"]').getByTestId('split-item').click();
    await expect(review.locator('[data-testid="change-item"][data-item-id="item_0003"]')).toHaveCount(1);
    await review.locator('[data-testid="change-item"][data-item-id="item_0003"]').getByTestId('delete-item').click();
    await expect(review.getByTestId('change-item')).toHaveCount(2);
    await review.getByTestId('select-item').nth(0).check();
    await review.getByTestId('select-item').nth(1).check();
    await review.getByTestId('merge-items').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1);
    const ops = (
      await review.evaluate(async (sid) => {
        const idb = await new Promise<IDBDatabase>((res) => {
          const r = indexedDB.open('inkup');
          r.onsuccess = () => res(r.result);
        });
        return new Promise<(TimelineEvent & { seq: number })[]>((res) => {
          const r = idb.transaction('events').objectStore('events').index('session_id').getAll(sid);
          r.onsuccess = () => res(r.result);
        });
      }, sessionId)
    )
      .filter((e): e is EventOf<'item_edit'> & { seq: number } => e.type === 'item_edit')
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.edit.op);
    expect(ops).toEqual(['edit', 'reorder', 'split', 'delete', 'merge']);
  } finally {
    await stub.close();
  }
});

test('closing the side panel mid-Session is Stop: the Session ends with its audio and video', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  const { panel, sessionId } = await startSession(context, serviceWorker, site, openExtensionPage);
  await expect(panel.getByTestId('video-status')).toHaveAttribute('data-state', 'recording');
  await expect
    .poll(() =>
      serviceWorker.evaluate(
        async () =>
          (
            (await chrome.storage.session.get('activeSession')).activeSession as
              | { video?: { start_offset_ms?: number } }
              | undefined
          )?.video?.start_offset_ms ?? null,
      ),
    )
    .not.toBeNull();
  // Closing the panel keeps the chunks already in Dexie; the last, unwritten one is lost. The first chunk lands a
  // timeslice after the start on a fast machine, but seconds later on a loaded 2-CPU runner: wait for it.
  await expect.poll(() => blobKinds(panel, sessionId), { timeout: 15_000 }).toContain('video_chunk');
  await panel.waitForTimeout(3000);

  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.close();
  const review = await reviewPromise;
  await expect.poll(async () => (await sessionRow(review, sessionId))?.status, { timeout: 20_000 }).toBe('ended');
  const row = await sessionRow(review, sessionId);
  expect(row.audio).toMatchObject({ blob_id: `${sessionId}:audio` });
  expect(row.video).toMatchObject({ blob_id: `${sessionId}:video`, seekable: true, path: 'recording.webm' });
  expect(row.video!.duration_ms).toBeGreaterThan(1500);
  expect(await blobKinds(review, sessionId)).toEqual(expect.arrayContaining(['audio', 'video']));
  expect(await blobKinds(review, sessionId)).not.toContain('video_chunk');
  const events = await review.evaluate(async (sid) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    return new Promise<TimelineEvent[]>((res) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(sid);
      r.onsuccess = () => res(r.result);
    });
  }, sessionId);
  expect(events.find((e) => e.type === 'session_end')).toMatchObject({ reason: 'panel_closed' });
  expect(
    await serviceWorker.evaluate(async () => (await chrome.storage.session.get('activeSession')).activeSession ?? null),
  ).toBeNull();
});

test.describe('picker cancelled', () => {
  test('the Session starts with video off, the panel says so, and nothing is recorded as video', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    // Chromium has no switch that cancels the generic picker (without a match it waits). Chrome's Cancel button
    // rejects getDisplayMedia with NotAllowedError, so the panel gets exactly that.
    await context.addInitScript(() => {
      if (!location.pathname.endsWith('/sidepanel.html')) return;
      navigator.mediaDevices.getDisplayMedia = () =>
        Promise.reject(new DOMException('Permission denied by user', 'NotAllowedError'));
    });
    const { panel, sessionId } = await startSession(context, serviceWorker, site, openExtensionPage);
    await expect(panel.getByTestId('video-status')).toHaveAttribute('data-state', 'off');
    await expect(panel.getByTestId('video-status')).toContainText('Video off');
    await panel.waitForTimeout(1500);
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await expect.poll(async () => (await sessionRow(review, sessionId))?.status).toBe('ended');
    const row = await sessionRow(review, sessionId);
    expect(row.video).toBeNull();
    expect(row.video_off_reason).toBe('picker_cancelled');
    expect(row.audio).not.toBeNull();
    await expect(review.getByTestId('evidence-audio')).toBeVisible();

    // The export has no recording.webm, and review.md says why.
    const { dir, files } = await exportAndUnzip(review, serviceWorker);
    expect(files).not.toContain('recording.webm');
    expect(files).toEqual(expect.arrayContaining(['audio.webm', 'review.md', 'session.json']));
    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    expect(doc.media.video).toBeNull();
    expect(doc.session.video_off_reason).toBe('picker_cancelled');
    expect(readFileSync(join(dir, 'review.md'), 'utf8')).toContain('Video: none (the screen picker was cancelled).');
  });
});
