// The page API's service-worker side (E5): `window.__inkup` calls relayed by the recording tab's content
// script. Every call checks the Session afresh, so a page that fakes the enable event gets nothing but errors.
// An `annotate` is recorded as an Annotation with no Strokes, tagged `source: 'page_api'`, that carries the script's
// comment in `page_api`; a style or text change it asks for is a `style_edit` on that Annotation.
import { rankCandidates } from '@inkup/core/candidates';
import type { PageApiAnnotateInput, PageApiRequest, PageApiResult } from '@/content/page-api';
import { db } from '@/db';
import type { ActiveSession } from '@/settings';
import { draftSignals } from './drafts';
import { appendEvent } from './event-log';
import { cropScreenshot, takeScreenshot } from './screenshots';
import { activeFor, offsetOf } from './session';

const pageApiAnnotations = (s: ActiveSession) =>
  db
    .eventsOfType(s.id, 'annotation')
    .filter((e) => e.source === 'page_api')
    .sortBy('t');

async function annotate(s: ActiveSession, input: PageApiAnnotateInput) {
  const annotationId = crypto.randomUUID();
  const t = offsetOf(s);
  const screenshot_id = await takeScreenshot({
    sessionId: s.id,
    tabId: s.tab_id,
    windowId: s.window_id,
    t0: s.t0,
    trigger: 'page_api',
    annotationId,
    page: input.page,
  });
  const ranking = rankCandidates(input.bbox, input.snapshots);
  const picked = ranking.pick !== null ? ranking.candidates[ranking.pick] : undefined;
  const crop = screenshot_id && picked ? await cropScreenshot(s.id, screenshot_id, annotationId, picked.bbox) : null;
  const index = (await db.eventsOfType(s.id, 'annotation').count()) + 1;
  await appendEvent(s.id, {
    type: 'annotation',
    t,
    t_end: t,
    annotation_id: annotationId,
    index,
    stroke_ids: [],
    close_reason: 'page_api',
    comment: null,
    bbox: input.bbox,
    ...input.page,
    resolution: ranking.resolution,
    candidates: ranking.candidates,
    pick: ranking.pick,
    screenshot_id,
    connector: null,
    ...(crop ? { crop } : {}),
    source: 'page_api',
    page_api: input.note,
  });
  if (input.edit)
    await appendEvent(s.id, {
      type: 'style_edit',
      t,
      annotation_id: annotationId,
      selector: picked?.selector ?? input.selector,
      ...input.edit,
    });
  void draftSignals.annotationClosed();
  return { annotation: index, selector: input.selector };
}

export async function pageApiCall(tabId: number | undefined, req: PageApiRequest): Promise<PageApiResult> {
  const s = await activeFor(tabId, { whilePaused: true });
  if (!s) return { ok: false, error: '__inkup: no Session is recording this tab' };
  try {
    switch (req.method) {
      case 'status':
        return {
          ok: true,
          result: {
            recording: true,
            paused: s.paused !== null,
            session_id: s.id,
            url: s.tab_url,
            page_api_annotations: (await pageApiAnnotations(s)).length,
          },
        };
      case 'list':
        return {
          ok: true,
          result: (await pageApiAnnotations(s)).map((e) => ({
            annotation: e.index,
            selector: e.candidates[e.pick ?? -1]?.selector ?? null,
            comment: e.page_api?.comment ?? '',
            t: e.t,
          })),
        };
      case 'annotate':
        if (s.paused) return { ok: false, error: '__inkup.annotate: the Session is paused' };
        return { ok: true, result: await annotate(s, req.input) };
    }
  } catch (err) {
    return { ok: false, error: `__inkup: ${err instanceof Error ? err.message : String(err)}` };
  }
}
