// Screenshots (PRD P0-6, ADR 0003): captureVisibleTab from the service worker, at most one per 500ms across all
// triggers. Requests are serialized, so the throttle sees them in order. captureVisibleTab shoots the window's
// active tab, so nothing is captured while the reviewer is looking at another tab (a tab_switch is logged).
//
// The recorded page context must describe the image: the review page maps Strokes into it by its scroll. So
// the scroll is read again right after the capture, and a capture whose scroll moved in between is dropped.
//
// The page's floating toolbar and the Text Comment chip are never in a screenshot: they hide for the capture frame and
// show again right after. The ink and the page's own text selection stay on screen.
//
// The page's colour under the toolbar or the pen, where computed styles cannot tell (an image, a gradient, a video:
// plan E8), is sampled from a capture too (`sampleBackground`). Samples join the same queue, so they never overlap a
// screenshot, are skipped within a second of any capture, and a screenshot waits out 500 ms after a sample: together
// they stay inside Chrome's two captures a second.
//
// A page whose viewport the toolbar resized (plan E6) is shot as exactly that viewport (./viewport.ts captureTab):
// the frame host's frame cropped out of the tab.
import { unusedAnnotationShots } from '@inkup/core/annotation-shot';
import { mean, type Rgb } from '@inkup/core/contrast';
import { cropBlobId, cropRect } from '@inkup/core/crop';
import type { Rect } from '@inkup/core/geometry';
import { screenshotPath } from '@inkup/core/session-document';
import { createScreenshotThrottle, type ThrottlePolicy } from '@inkup/core/throttle';
import type { EventOf } from '@inkup/core/timeline';
import { db } from '@/db';
import { notifyOutbox, outboxEnabled, queueBlobs } from '@/db/outbox';
import { sendMessage } from '@/messaging';
import { activeSession, toolbarTabs } from '@/session-state';
import { effectiveUrl } from '@/viewport/frame-host';
import { appendEvent } from './event-log';
import { captureTab, isFramed } from './viewport';

const throttle = createScreenshotThrottle(500);
let queue: Promise<unknown> = Promise.resolve();
/** Epoch ms of the last capture of any kind, and of the last background sample. */
let lastCaptureAt = 0;
let lastSampleAt = 0;
const SAMPLE_AFTER_CAPTURE_MS = 1000;
const CAPTURE_AFTER_SAMPLE_MS = 500;

type Trigger = EventOf<'screenshot'>['trigger'];
// An Annotation waits for its own image: its Strokes are held on screen until then, and a reused image would
// show another Annotation's Strokes, or none.
const POLICY: Record<Trigger, ThrottlePolicy> = {
  annotation: 'defer',
  click: 'drop',
  navigation: 'defer',
  voice_command: 'defer',
  panel: 'defer',
  shortcut: 'defer',
  text_comment: 'defer',
  page_api: 'defer',
};

export interface ShotContext {
  sessionId: string;
  tabId: number;
  windowId: number;
  t0: number;
  trigger: Trigger;
  annotationId: string | null;
  /** Page context read by the page in the turn it asked for the shot; omitted, it is read just before the capture. */
  page?: PageContext;
  /** URL to record when the page context cannot be read (restricted pages). */
  fallbackUrl?: string;
}

export type PageContext = Pick<EventOf<'screenshot'>, 'url' | 'scroll' | 'viewport' | 'dpr'>;

const stripHash = (u: string) => u.split('#')[0];

/** Returns the screenshot id (new, or reused inside the debounce window), or null when nothing was captured. */
export function takeScreenshot(ctx: ShotContext): Promise<string | null> {
  const run = queue.then(() => capture(ctx));
  queue = run.catch(() => {});
  return run;
}

async function capture(ctx: ShotContext): Promise<string | null> {
  let decision = throttle.decide(Date.now(), POLICY[ctx.trigger]);
  if (decision.action === 'wait') {
    await new Promise((r) => setTimeout(r, decision.action === 'wait' ? decision.ms : 0));
    decision = throttle.decide(Date.now(), POLICY[ctx.trigger]);
  }
  if (decision.action === 'reuse') return decision.id;
  if (decision.action !== 'capture') return null;
  const now = Date.now();
  const [active] = await chrome.tabs.query({ active: true, windowId: ctx.windowId });
  if (active?.id !== ctx.tabId) return null;
  const page = ctx.page ??
    (await readPageContext(ctx.tabId)) ?? { ...UNKNOWN_PAGE, url: ctx.fallbackUrl ?? active.url ?? '' };
  // A shot the page asked for, of a page that has already navigated away, would show the wrong page.
  const activeUrl = effectiveUrl(active.url);
  if (ctx.page && activeUrl && stripHash(activeUrl) !== stripHash(page.url)) return null;
  let shot: { blob: Blob; scale: number };
  // The Session's tab may show the Text Comment chip, so it is asked to hide whatever it shows, as are toolbar tabs.
  const toolbar =
    (await toolbarTabs.getValue()).includes(ctx.tabId) || (await activeSession.getValue())?.tab_id === ctx.tabId;
  try {
    if (toolbar) await hideToolbar(ctx.tabId, true);
    const wait = lastSampleAt + CAPTURE_AFTER_SAMPLE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCaptureAt = Date.now();
    shot = await captureTab(ctx.tabId, ctx.windowId);
  } catch (e) {
    console.warn('captureVisibleTab failed', e);
    throttle.record(now, null);
    return null;
  } finally {
    if (toolbar) void hideToolbar(ctx.tabId, false);
  }
  // Unreadable after the capture (a restricted page, or one unloading): nothing says it moved.
  const after = await readPageContext(ctx.tabId);
  if (
    after &&
    (stripHash(after.url) !== stripHash(page.url) ||
      after.scroll.x !== page.scroll.x ||
      after.scroll.y !== page.scroll.y)
  ) {
    console.warn(`dropped a ${ctx.trigger} screenshot: the page scrolled or navigated during the capture`);
    throttle.record(now, null);
    return null;
  }
  const { blob } = shot;
  const id = crypto.randomUUID();
  const t = Math.max(0, now - ctx.t0);
  await db.blobs.add({
    id,
    session_id: ctx.sessionId,
    kind: 'screenshot',
    mime: blob.type || 'image/png',
    size: blob.size,
    t,
    seq: 0,
    blob,
  });
  await queueBlobs(ctx.sessionId, [id]);
  await appendEvent(ctx.sessionId, {
    type: 'screenshot',
    t,
    screenshot_id: id,
    path: screenshotPath(id),
    mime: blob.type || 'image/png',
    trigger: ctx.trigger,
    annotation_id: ctx.annotationId,
    ...page,
    // Shown scaled down in the frame host: the image has fewer px per CSS px than the page's own ratio.
    ...(shot.scale !== 1 ? { dpr: page.dpr * shot.scale } : {}),
  });
  throttle.record(now, id);
  return id;
}

/**
 * The Annotation's element crop (E4): its screenshot cut to the picked element's box plus 16 CSS px, stored as a
 * second PNG (`<screenshot_id>.crop`, kind screenshot_crop) and queued for the Host. Null when the element is off
 * screen in that image, or the context has no OffscreenCanvas.
 */
export async function cropScreenshot(
  sessionId: string,
  screenshotId: string,
  annotationId: string,
  bbox: Rect,
): Promise<EventOf<'annotation'>['crop'] | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const [shot, row] = await Promise.all([
      db
        .eventsOfType(sessionId, 'screenshot')
        .filter((e) => e.screenshot_id === screenshotId)
        .first(),
      db.blobs.get(screenshotId),
    ]);
    if (!shot || !row) return null;
    const bitmap = await createImageBitmap(row.blob);
    const rect = cropRect(bbox, {
      scroll: shot.scroll,
      viewport: shot.viewport,
      image: { width: bitmap.width, height: bitmap.height },
    });
    if (!rect) return null;
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    canvas.getContext('2d')!.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    // Two Annotations can share a screenshot (one closed by a navigation takes the click's): each gets its own crop.
    const id = (await db.blobs.get(cropBlobId(screenshotId)))
      ? `${cropBlobId(screenshotId)}-${annotationId.slice(0, 8)}`
      : cropBlobId(screenshotId);
    await db.blobs.put({
      id,
      session_id: sessionId,
      kind: 'screenshot_crop',
      mime: 'image/png',
      size: blob.size,
      t: row.t,
      seq: 0,
      blob,
    });
    await queueBlobs(sessionId, [id]);
    return { blob_id: id, path: screenshotPath(id), rect };
  } catch (e) {
    console.warn('element crop failed', e);
    return null;
  }
}

/**
 * Withdraws screenshots of the Session that no Annotation uses (#22): the image, its `screenshot` event and any of
 * their outbox rows not sent yet. While paired, the Host is told to delete whatever of them it already has; the row
 * goes after the blob's, so an upload in progress lands first. A screenshot some Annotation uses is kept.
 */
export async function discardScreenshots(sessionId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const outbox = await outboxEnabled();
  const discarded = await db.transaction('rw', db.events, db.blobs, db.outbox, async () => {
    const wanted = new Set(ids);
    const [shots, users] = await Promise.all([
      db
        .eventsOfType(sessionId, 'screenshot')
        .filter((e) => wanted.has(e.screenshot_id))
        .toArray(),
      db.events
        .where('session_id')
        .equals(sessionId)
        .filter(
          (e) =>
            (e.type === 'annotation' || e.type === 'text_comment') && !!e.screenshot_id && wanted.has(e.screenshot_id),
        )
        .toArray(),
    ]);
    const gone = new Set(unusedAnnotationShots([...shots, ...users]));
    if (gone.size === 0) return [];
    const seqs = new Set(shots.filter((e) => gone.has(e.screenshot_id)).map((e) => e.seq!));
    await db.events.bulkDelete([...seqs]);
    await db.blobs
      .where('id')
      .anyOf([...gone])
      .filter((b) => b.session_id === sessionId)
      .delete();
    await db.outbox
      .where('session_id')
      .equals(sessionId)
      .filter((r) => (r.kind === 'event' && seqs.has(r.event_seq)) || (r.kind === 'blob' && gone.has(r.blob_id)))
      .delete();
    if (outbox) {
      const now = Date.now();
      await db.outbox.bulkAdd(
        [...gone].map((blob_id) => ({
          kind: 'screenshot_discard' as const,
          session_id: sessionId,
          blob_id,
          created_at: now,
        })),
      );
    }
    return [...gone];
  });
  if (outbox && discarded.length) notifyOutbox();
  return discarded;
}

/** At Stop: every screenshot of the Session that no Annotation ended up using goes (#22). */
export async function sweepUnusedScreenshots(sessionId: string): Promise<string[]> {
  const events = await db.events
    .where('session_id')
    .equals(sessionId)
    .filter((e) => e.type === 'screenshot' || e.type === 'annotation' || e.type === 'text_comment')
    .toArray();
  return discardScreenshots(sessionId, unusedAnnotationShots(events));
}

/** A rect of the page, in its viewport's CSS px, to sample; `ring` > 0 samples only a band that wide around it. */
export interface SampleInput {
  rect: Rect;
  viewport: { width: number; height: number };
  ring: number;
}

/** The mean colour of the rect (or the band around it) in a fresh capture of the tab; null when skipped or failed. */
export function sampleBackground(tabId: number, windowId: number, input: SampleInput): Promise<Rgb | null> {
  const run = queue.then(() => sample(tabId, windowId, input));
  queue = run.catch(() => {});
  return run;
}

async function sample(tabId: number, windowId: number, { rect, viewport, ring }: SampleInput): Promise<Rgb | null> {
  if (
    typeof OffscreenCanvas === 'undefined' ||
    Date.now() - lastCaptureAt < SAMPLE_AFTER_CAPTURE_MS ||
    viewport.width <= 0
  )
    return null;
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id !== tabId) return null;
  try {
    lastCaptureAt = lastSampleAt = Date.now();
    const bitmap = await createImageBitmap((await captureTab(tabId, windowId)).blob);
    const px = bitmap.width / viewport.width;
    const outer = {
      x: Math.max(0, Math.floor((rect.x - ring) * px)),
      y: Math.max(0, Math.floor((rect.y - ring) * px)),
    };
    const w = Math.min(bitmap.width, Math.ceil((rect.x + rect.width + ring) * px)) - outer.x;
    const h = Math.min(bitmap.height, Math.ceil((rect.y + rect.height + ring) * px)) - outer.y;
    if (w <= 0 || h <= 0) return null;
    const ctx = new OffscreenCanvas(w, h).getContext('2d')!;
    ctx.drawImage(bitmap, outer.x, outer.y, w, h, 0, 0, w, h);
    bitmap.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    // Inside the rect is the toolbar itself when sampling a band: left out.
    const inner =
      ring > 0
        ? {
            x0: rect.x * px - outer.x,
            y0: rect.y * px - outer.y,
            x1: (rect.x + rect.width) * px - outer.x,
            y1: (rect.y + rect.height) * px - outer.y,
          }
        : null;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
    const colors: Rgb[] = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (inner && x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1) continue;
        const i = (y * w + x) * 4;
        colors.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
      }
    }
    return colors.length ? mean(colors) : null;
  } catch (e) {
    console.warn('background sample failed', e);
    return null;
  }
}

/** Asks the tab's toolbar to hide (resolves once it is off screen, or after 500 ms) or show again. */
function hideToolbar(tabId: number, hidden: boolean): Promise<unknown> {
  return Promise.race([
    sendMessage('toolbarCapture', hidden, tabId).catch(() => {}),
    new Promise((r) => setTimeout(r, 500)),
  ]);
}

const UNKNOWN_PAGE: PageContext = { url: '', scroll: { x: 0, y: 0 }, viewport: { width: 0, height: 0 }, dpr: 1 };

/**
 * The tab's page context, or null where nothing of ours runs (another extension's page, chrome://, a page that is
 * unloading). Scripts cannot be injected into our own extension pages, so those answer from their overlay.
 */
async function readPageContext(tabId: number): Promise<PageContext | null> {
  try {
    // Under the frame host the page is in the frame; the tab's top document is ours.
    if (await isFramed(tabId)) throw new Error('framed');
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        scroll: { x: scrollX, y: scrollY },
        viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio || 1,
      }),
    });
    return (r?.result as PageContext | undefined) ?? null;
  } catch {
    return Promise.race([
      sendMessage('contentPageContext', undefined, tabId).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
  }
}
