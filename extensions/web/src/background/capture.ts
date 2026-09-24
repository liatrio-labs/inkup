// What the Session records besides its lifecycle: Strokes, Annotations (with Connector ends), clicks, scroll
// settles, transcript segments (and the Speech Boundaries they carry), VAD speech spans, navigations and tab
// switches. Nothing is recorded while the Session is paused.
import { objectSelectRanking, rankCandidates } from '@inkup/core/candidates';
import { toOffset } from '@inkup/core/clock';
import { speechBoundaryAt } from '@inkup/core/speech-boundary';
import type { ConnectorEndSchema, DictationTarget } from '@inkup/core/timeline';
import type { z } from 'zod';
import type { Fallback } from '@/adapters/transcription';
import { db } from '@/db';
import {
  type AnnotationInput,
  type AnnotationShotInput,
  type ClickInput,
  type ClickPage,
  type ConnectorEndInput,
  type ObjectSelectInput,
  type OverlayClearedInput,
  type ScrollSettleInput,
  type SegmentInput,
  type StrokeInput,
  sendMessage,
  type TextCommentInput,
} from '@/messaging';
import { type ActiveSession, devOverrides } from '@/settings';
import { effectiveUrl, framedUrl } from '@/viewport/frame-host';
import { draftSignals } from './drafts';
import { appendEvent } from './event-log';
import { CONTENT_SCRIPT } from './inject';
import { cropScreenshot, discardScreenshots, takeScreenshot } from './screenshots';
import { activeFor, getActive, notifyContent, offsetOf, patchActive, signalContent } from './session';
import { modeOf } from './target-tab';

export async function recordStroke(tabId: number | undefined, stroke: StrokeInput): Promise<void> {
  // Strokes arrive when their Annotation closes; one closed by `pause` still belongs to the Session.
  const s = await activeFor(tabId, { whilePaused: true });
  if (!s) return;
  await appendEvent(s.id, { type: 'stroke', ...stroke });
}

const rankEnd = (end: ConnectorEndInput): z.infer<typeof ConnectorEndSchema> => {
  const r = rankCandidates(end.bbox, end.snapshots);
  return { point: end.point, bbox: end.bbox, resolution: r.resolution, candidates: r.candidates, pick: r.pick };
};

/**
 * The screenshot for an Annotation. One closed by a navigation cannot be shot any more once the next page is
 * showing: it takes the latest screenshot of its page taken since it began (the click on the link, usually).
 */
async function annotationScreenshot(s: ActiveSession, input: AnnotationInput): Promise<string | null> {
  const page = { url: input.url, scroll: input.scroll, viewport: input.viewport, dpr: input.dpr };
  if (input.close_reason === 'navigation') {
    // The click on the link usually arrives just before this; wait for its screenshot to land.
    await clickShots;
    const tab = await chrome.tabs.get(s.tab_id).catch(() => null);
    if (!tab || effectiveUrl(tab.url) !== input.url || tab.status !== 'complete') {
      const shots = await db
        .eventsOfType(s.id, 'screenshot')
        .filter((e) => e.url === input.url && e.t >= input.t)
        .sortBy('t');
      // Its own shot, taken after a Stroke, if it landed before the page went away.
      return (
        (shots.filter((e) => e.annotation_id === input.annotation_id).at(-1) ?? shots.at(-1))?.screenshot_id ?? null
      );
    }
  }
  return takeScreenshot({
    sessionId: s.id,
    tabId: s.tab_id,
    windowId: s.window_id,
    t0: s.t0,
    trigger: 'annotation',
    annotationId: input.annotation_id,
    page,
  });
}

/**
 * The Annotation's screenshot, asked for by the page shortly after each Stroke's pointer-up while the Strokes
 * are on screen. `page` is read by the page in the turn it asks.
 */
export async function captureAnnotation(
  tabId: number | undefined,
  input: AnnotationShotInput,
): Promise<{ screenshot_id: string | null }> {
  // e2e (E9): a capture that never answers must not leave the Strokes on the page.
  if ((await devOverrides.getValue())?.hangAnnotationShots) return new Promise(() => {});
  const s = await activeFor(tabId, { whilePaused: true });
  if (!s) return { screenshot_id: null };
  return {
    screenshot_id: await takeScreenshot({
      sessionId: s.id,
      tabId: s.tab_id,
      windowId: s.window_id,
      t0: s.t0,
      trigger: 'annotation',
      annotationId: input.annotation_id,
      page: input.page,
    }),
  };
}

export async function closeAnnotation(
  tabId: number | undefined,
  input: AnnotationInput,
): Promise<{ screenshot_id: string | null; index: number }> {
  const s = await activeFor(tabId, { whilePaused: true });
  if (!s) return { screenshot_id: null, index: 0 };
  const screenshot_id = input.screenshot_id !== undefined ? input.screenshot_id : await annotationScreenshot(s, input);
  const ranking = rankCandidates(input.bbox, input.snapshots);
  const picked = ranking.pick !== null ? ranking.candidates[ranking.pick] : undefined;
  const crop =
    screenshot_id && picked ? await cropScreenshot(s.id, screenshot_id, input.annotation_id, picked.bbox) : null;
  const index = (await db.eventsOfType(s.id, 'annotation').count()) + 1;
  await appendEvent(s.id, {
    type: 'annotation',
    t: input.t,
    t_end: input.t_end,
    annotation_id: input.annotation_id,
    index,
    stroke_ids: input.stroke_ids,
    close_reason: input.close_reason,
    comment: input.comment?.trim() || null,
    bbox: input.bbox,
    url: input.url,
    scroll: input.scroll,
    viewport: input.viewport,
    dpr: input.dpr,
    resolution: ranking.resolution,
    candidates: ranking.candidates,
    pick: ranking.pick,
    screenshot_id,
    connector: input.connector
      ? {
          stroke_ids: input.connector.stroke_ids,
          tail: rankEnd(input.connector.tail),
          head: rankEnd(input.connector.head),
        }
      : null,
    ...(crop ? { crop } : {}),
  });
  void draftSignals.annotationClosed();
  return { screenshot_id, index };
}

/**
 * An element picked with Object Select (E7): an Annotation of its own, with no Strokes and the element as its one
 * definite Candidate, from the pick to when the reviewer was done with it (speech in that span is about it). The page
 * closed any open drawn Annotation at the pick, and its screenshot (with the pick's outline) was taken then.
 */
export async function objectSelect(
  tabId: number | undefined,
  input: ObjectSelectInput & { screenshot_id: string | null },
): Promise<{ index: number }> {
  // Recorded while paused or stopping too: the pause or Stop ends the pick in progress.
  const s = await getActive();
  if (!s || s.tab_id !== tabId) return { index: 0 };
  const ranking = objectSelectRanking(input.element);
  const crop = input.screenshot_id
    ? await cropScreenshot(s.id, input.screenshot_id, input.annotation_id, input.element.bbox)
    : null;
  const index = (await db.eventsOfType(s.id, 'annotation').count()) + 1;
  await appendEvent(s.id, {
    type: 'annotation',
    t: input.t,
    t_end: Math.max(input.t, input.t_end),
    annotation_id: input.annotation_id,
    index,
    stroke_ids: [],
    close_reason: 'object_select',
    comment: input.comment,
    bbox: input.element.bbox,
    ...input.page,
    ...ranking,
    screenshot_id: input.screenshot_id,
    connector: null,
    ...(crop ? { crop } : {}),
  });
  void draftSignals.annotationClosed();
  return { index };
}

/** An Object Select pick dropped with Esc or Clear all (#22): its screenshot goes now, unless an Annotation uses it. */
export async function dropPick(tabId: number | undefined, input: { screenshot_id: string }): Promise<void> {
  const s = await getActive();
  if (!s || s.tab_id !== tabId) return;
  await discardScreenshots(s.id, [input.screenshot_id]);
}

// Click screenshots still in flight. Set synchronously when a press or click arrives, so an Annotation closed
// by the navigation that click starts, and the navigation's own screenshot, can wait for it.
let clickShots: Promise<unknown> = Promise.resolve();
/** When the last press on an interactive element asked for a click screenshot, per tab. */
const pressedAt = new Map<number, number>();
const PRESS_COVERS_MS = 2000;

function shootClick(tabId: number | undefined, page: ClickPage): Promise<void> {
  const run = (async () => {
    const s = await activeFor(tabId);
    if (s)
      await takeScreenshot({
        sessionId: s.id,
        tabId: s.tab_id,
        windowId: s.window_id,
        t0: s.t0,
        trigger: 'click',
        annotationId: null,
        page,
      });
  })();
  clickShots = Promise.all([clickShots, run.catch(() => {})]);
  return run;
}

/** The click screenshot, taken at the press: a link click navigates on release, often before a shot could land. */
export function pressInteractive(tabId: number | undefined, page: ClickPage): Promise<void> {
  if (tabId !== undefined) pressedAt.set(tabId, Date.now());
  return shootClick(tabId, page);
}

/** Logs the click. A click with no press just before it (keyboard activation) is screenshotted now. */
export async function recordClick(tabId: number | undefined, input: ClickInput): Promise<void> {
  const pressed = tabId !== undefined && Date.now() - (pressedAt.get(tabId) ?? 0) < PRESS_COVERS_MS;
  if (tabId !== undefined) pressedAt.delete(tabId);
  const shot = pressed
    ? Promise.resolve()
    : shootClick(tabId, { url: input.url, scroll: input.scroll, viewport: input.viewport, dpr: input.dpr });
  const s = await activeFor(tabId);
  if (s) await appendEvent(s.id, { type: 'click', ...input });
  await shot;
}

export async function recordScrollSettle(tabId: number | undefined, input: ScrollSettleInput): Promise<void> {
  const s = await activeFor(tabId);
  if (s) await appendEvent(s.id, { type: 'scroll_settle', ...input });
}

/** Clear all (E9) on the recording tab: logged as it came (paused too: the reviewer may clear up while paused). */
export async function overlayCleared(tabId: number | undefined, input: OverlayClearedInput): Promise<void> {
  const s = await activeFor(tabId, { whilePaused: true });
  if (s) await appendEvent(s.id, { type: 'overlay_cleared', ...input });
}

/** A Text Comment (E3): numbered, screenshotted with the selection on screen (the page hides the chip), and logged. */
export async function recordTextComment(
  tabId: number | undefined,
  input: TextCommentInput,
): Promise<{ screenshot_id: string | null; index: number }> {
  const s = await activeFor(tabId);
  if (!s) return { screenshot_id: null, index: 0 };
  const page = { url: input.url, scroll: input.scroll, viewport: input.viewport, dpr: input.dpr };
  const screenshot_id = await takeScreenshot({
    sessionId: s.id,
    tabId: s.tab_id,
    windowId: s.window_id,
    t0: s.t0,
    trigger: 'text_comment',
    annotationId: null,
    page,
  });
  const index = (await db.eventsOfType(s.id, 'text_comment').count()) + 1;
  await appendEvent(s.id, { type: 'text_comment', ...input, index, screenshot_id });
  return { screenshot_id, index };
}

/** Panel Snap button, the `snap` Voice Command, or the Alt+Shift+S shortcut. */
export async function snap(trigger: 'panel' | 'voice_command' | 'shortcut'): Promise<{ screenshot_id: string | null }> {
  const s = await getActive();
  if (!s || s.stopping || s.paused) return { screenshot_id: null };
  return {
    screenshot_id: await takeScreenshot({
      sessionId: s.id,
      tabId: s.tab_id,
      windowId: s.window_id,
      t0: s.t0,
      trigger,
      annotationId: null,
      fallbackUrl: s.tab_url,
    }),
  };
}

/**
 * A transcript segment. It is also a Speech Boundary: an Annotation that began before it closes. One dictated into a
 * comment box (E11, `target`) is that comment's text: logged with its target, and its words go to the page's box.
 */
export async function recordSegment({ target = null, ...segment }: SegmentInput): Promise<void> {
  const s = await getActive();
  if (!s || s.paused) return;
  if (target) {
    await appendEvent(s.id, { type: 'transcript_segment', ...segment, run_id: null, target });
    await sendMessage('contentDictation', { target, text: segment.text, final: true }, s.tab_id).catch(() => {});
    return;
  }
  await appendEvent(s.id, { type: 'transcript_segment', ...segment, run_id: null, target: null });
  void draftSignals.segment();
  if (!s.stopping)
    void signalContent(s, { reason: 'speech_boundary', t: offsetOf(s), if_opened_before: speechBoundaryAt(segment) });
}

/** An interim caption of a comment box's dictation (E11), for the page's box to show. */
export async function relayBoxInterim(input: { target: DictationTarget; text: string }): Promise<void> {
  const s = await getActive();
  if (s && !s.paused && !s.stopping)
    await sendMessage('contentDictation', { ...input, final: false }, s.tab_id).catch(() => {});
}

export async function recordSpeechActivity(span: { t: number; t_end: number }): Promise<void> {
  const s = await getActive();
  if (!s || s.paused || s.stopping) return;
  await appendEvent(s.id, { type: 'speech_activity', t: span.t, t_end: Math.max(span.t, span.t_end) });
  void draftSignals.speechEnded();
}

/** The VAD heard speech begin: no Draft Item pass starts while the reviewer is talking. */
export async function recordSpeechStart(): Promise<void> {
  const s = await getActive();
  if (!s || s.paused || s.stopping) return;
  void draftSignals.speechStarted();
}

export async function recordFallback({ session_id, ...f }: Fallback & { session_id: string }): Promise<void> {
  const row = await db.sessions.get(session_id);
  if (row?.status !== 'recording') return;
  await appendEvent(session_id, {
    type: 'transcription_fallback',
    t: toOffset(row.t0, Date.now()),
    from: f.from,
    to: f.to,
    reason: f.reason,
  });
  // Mid-Session changes update the panel; at Start, offscreenStart's reply carries the same state. A paid tier
  // that fell back sends what transcribes now (`info`); Web Speech's own mode changes only name the target.
  const info = f.info;
  const captions = info ? info.captions : f.to === 'none' ? 'unavailable' : 'live';
  const next = await patchActive((s) =>
    s.id !== session_id
      ? s
      : {
          ...s,
          captions,
          transcription: info
            ? { engine: info.engine, local: info.local, timestamp_quality: info.timestamp_quality }
            : s.transcription
              ? { ...s.transcription, local: f.to !== 'webspeech-server' }
              : s.transcription,
          ...(captions === 'unavailable'
            ? { commands: 'unavailable' as const, commands_note: 'Voice Commands need live captions.' }
            : {}),
        },
  );
  // During Start the transcription info is not known yet; offscreenStart's reply records it.
  if (next?.id === session_id && next.transcription)
    await db.sessions.update(session_id, { transcription: next.transcription });
}

// ---- Navigation and tab switches (PRD P0-1, P0-2, P0-6) ----------------------------------------------------

/**
 * Makes sure the page has a working content script. The manifest injects it at document_idle, which can land a
 * moment after the load completes, so this waits for it before injecting a copy itself (two copies would draw
 * two overlays). Each push reads the Session afresh: this runs after the navigation screenshot, and the
 * reviewer may have turned drawing on meanwhile, which a state read before the screenshot would turn off again.
 */
async function ensureContentScript(s: ActiveSession) {
  for (let i = 0; i < 4; i++) {
    const now = await getActive();
    if (now?.id !== s.id || now.tab_id !== s.tab_id || now.stopping) return;
    if (await notifyContent(now.tab_id, now)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  await chrome.scripting.executeScript({ target: { tabId: s.tab_id }, files: [CONTENT_SCRIPT] }).catch(() => {});
}

/**
 * The Session follows its tab. A finished page load, or a same-document URL change (history API), is a
 * navigation: logged, screenshotted once the page is complete, and the panel shows the new title.
 */
export async function onTabUpdated(
  tabId: number,
  change: { status?: string; url?: string; title?: string },
  tab: chrome.tabs.Tab,
): Promise<void> {
  const s = await getActive();
  if (!s || s.tab_id !== tabId || s.stopping) return;
  // Under the frame host (a resized viewport) the tab shows our page; the page under review is the framed one, and
  // the host page mirrors its navigations into its own URL, which lands here as a same-document change.
  const url = effectiveUrl(tab.url) ?? s.tab_url;
  const title = tab.title ?? '';
  const loaded = change.status === 'complete';
  const spa = change.url !== undefined && tab.status === 'complete' && effectiveUrl(change.url) !== s.last_url;
  if (!loaded && !spa) {
    if (change.title !== undefined) await patchActive((a) => ({ ...a, tab_title: change.title! }));
    return;
  }
  // Our own pages mount the overlay themselves; on 'no_overlay' pages nothing of ours runs, so no drawing.
  const mode = modeOf(url);
  const pageMode = mode === 'not_a_target' ? 'no_overlay' : mode;
  const next = await patchActive((a) => ({
    ...a,
    tab_url: url,
    tab_title: title || a.tab_title,
    last_url: url,
    mode: pageMode,
    draw_mode: pageMode === 'no_overlay' ? false : a.draw_mode,
    select_mode: pageMode === 'no_overlay' ? null : a.select_mode,
  }));
  if (!next) return;
  // The first load of the start page is not a navigation.
  const isStart =
    loaded && url === s.last_url && (await db.eventsOfType(s.id, 'navigation').count()) === 0 && offsetOf(s) < 3000;
  if (s.paused || isStart) return;
  await appendEvent(s.id, {
    type: 'navigation',
    t: offsetOf(s),
    url,
    title,
    overlay: pageMode === 'no_overlay' ? 'none' : 'page',
  });
  // The click that started this navigation shoots the old page first.
  await clickShots;
  await takeScreenshot({
    sessionId: s.id,
    tabId,
    windowId: s.window_id,
    t0: s.t0,
    trigger: 'navigation',
    annotationId: null,
    fallbackUrl: url,
  });
  // The frame host's frame gets its content script from the probe (./viewport.ts), not here.
  if (loaded && pageMode === 'page' && !framedUrl(tab.url)) await ensureContentScript(next);
}

/**
 * tab_switch: the reviewer activates another tab of the Session's window. Capture stays bound to the Session
 * tab (its content script keeps recording, but screenshots need it visible), and the panel offers "Go back".
 */
export async function onTabActivated({ tabId, windowId }: { tabId: number; windowId: number }): Promise<void> {
  const s = await getActive();
  if (!s || s.window_id !== windowId || s.stopping) return;
  const away = tabId !== s.tab_id;
  if (!away && !s.away) return;
  const other = away ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const title = away ? (other?.title ?? other?.url ?? '') : s.tab_title;
  await patchActive((a) => ({ ...a, away: away ? { tab_id: tabId, title } : null }));
  if (!s.paused)
    await appendEvent(s.id, { type: 'tab_switch', t: offsetOf(s), to_tab_id: tabId, to_title: title, away });
}
