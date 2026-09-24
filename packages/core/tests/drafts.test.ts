// Slice 5: Draft Items. The pass trigger (fake clock), the incremental draft prompt, pinned-draft merging in
// Process, and the discard-rate metric.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { createDraftTrigger } from '../src/draft-trigger';
import { draftStates, draftStats, draftViews } from '../src/drafts';
import {
  buildDraftPrompt,
  buildProcessPrompt,
  type ChangeItem,
  ChangeItemSchema,
  checkDraftOutput,
  coveredAnnotationIds,
  DraftOutputSchema,
  draftToChangeItem,
  mergePinnedDrafts,
  nextDraftId,
} from '../src/process';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { EventOf, TimelineEvent } from '../src/timeline';

const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));
const [a1, a2] = doc.events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation');
const shotOf = (a: EventOf<'annotation'>) => a.screenshot_id!;

function draft(draft_id: string, t: number, over: Partial<EventOf<'draft_item'>> = {}): EventOf<'draft_item'> {
  return {
    id: `ev-${draft_id}`,
    type: 'draft_item',
    t,
    draft_id,
    pass_id: 'p1',
    model: 'claude-haiku-4-5-20251001',
    title: "Move 'Get started' into the header",
    category: 'layout',
    intent: 'The CTA belongs in the header nav, right of Docs.',
    transcript: 'this button ... should go here',
    locations: [
      { role: 'subject', element: "button 'Get started'", selector: 'button.cta', annotation: 1 },
      { role: 'destination', element: 'header nav', selector: 'nav', annotation: 2 },
    ],
    annotation_ids: [a1!.annotation_id, a2!.annotation_id],
    ...over,
  };
}
const action = (
  draft_id: string,
  t: number,
  act: 'pin' | 'discard',
  source: 'click' | 'voice' = 'click',
): EventOf<'draft_action'> => ({
  id: `act-${draft_id}-${t}`,
  type: 'draft_action',
  t,
  draft_id,
  action: act,
  source,
});
const withEvents = (extra: TimelineEvent[]): SessionDocument => ({
  ...doc,
  events: [...doc.events, ...extra].sort((a, b) => a.t - b.t),
});

describe('draft pass trigger (fake clock)', () => {
  it('fires once ~3 s after the Annotation closes and the speech ends, not before', () => {
    const tr = createDraftTrigger();
    tr.annotationClosed(3000);
    tr.speechStarted(3500);
    expect(tr.take(7000)).toBeNull(); // still speaking
    tr.speechEnded(4200);
    tr.segment(4800); // the transcript result lands after the speech
    expect(tr.take(7700)).toBeNull();
    expect(tr.take(7800)).toBe('annotation');
    expect(tr.inFlight).toBe(true);
    tr.done();
    expect(tr.take(20_000)).toBeNull(); // consumed
  });

  it('is debounced: a second Annotation inside the wait restarts it and both go in one pass', () => {
    const tr = createDraftTrigger();
    tr.annotationClosed(1000);
    tr.annotationClosed(3500);
    expect(tr.take(4100)).toBeNull();
    expect(tr.take(6500)).toBe('annotation');
    tr.done();
    expect(tr.take(9000)).toBeNull();
  });

  it('never runs two passes at once, and queues at most one more', () => {
    const tr = createDraftTrigger();
    tr.annotationClosed(1000);
    expect(tr.take(4000)).toBe('annotation');
    // Three Annotations close while the pass is in flight.
    tr.annotationClosed(4500);
    tr.annotationClosed(5000);
    tr.annotationClosed(5500);
    expect(tr.take(9000)).toBeNull();
    tr.done();
    expect(tr.take(9000)).toBe('annotation');
    tr.done();
    expect(tr.take(20_000)).toBeNull();
  });

  it('falls back every 30 s for speech with no drawing, and not without speech', () => {
    const tr = createDraftTrigger({ startAt: 0 });
    expect(tr.take(31_000)).toBeNull(); // silence only
    tr.segment(10_000);
    expect(tr.take(29_999)).toBeNull();
    expect(tr.take(30_000)).toBe('fallback');
    tr.done();
    tr.speechStarted(40_000);
    tr.speechEnded(41_000);
    expect(tr.take(59_999)).toBeNull();
    expect(tr.take(60_000)).toBe('fallback');
  });

  it('a pause ends open speech, so a pass can still follow', () => {
    const tr = createDraftTrigger();
    tr.annotationClosed(1000);
    tr.speechStarted(1500);
    expect(tr.take(9000)).toBeNull();
    tr.reset(2000);
    expect(tr.take(5000)).toBe('annotation');
  });
});

describe('draft prompt (incremental)', () => {
  const segs = doc.events.filter((e): e is EventOf<'transcript_segment'> => e.type === 'transcript_segment');
  const ids = (xs: TimelineEvent[]) => new Set(xs.map((e) => e.id));

  it('renders only the events since the previous pass, in the §7 format', () => {
    // Pass 1 covered Annotation #1 and the first segment; pass 2 gets Annotation #2 and "should go here…".
    const fresh = doc.events.filter((e) => e.t >= a2!.t && e.type !== 'session_end');
    const p = buildDraftPrompt({ events: doc.events, fresh: ids(fresh), start_url: doc.session.start_url });
    expect(p.empty).toBe(false);
    expect(p.script).toMatch(/^TIMESTAMP QUALITY: word-level\nPAIRING WINDOW: 2s\nLIVE PASS: events since 00:07\.0/);
    expect(p.script).toMatch(/\[00:07\.0\] ANNOTATION #2 /);
    expect(p.script).not.toContain('ANNOTATION #1');
    expect(p.script).toContain(`SPEECH "${segs[1]!.text}"`);
    expect(p.script).not.toContain(`SPEECH "${segs[0]!.text}"`);
    // Earlier Annotations still count for pairing and for the Location check.
    expect(p.context.annotations).toEqual({ 1: a1!.annotation_id, 2: a2!.annotation_id });
    expect(p.script).toContain('RECENT DRAFT ITEMS (already shown to the reviewer; do not repeat them):\n- none yet');
    expect(p.system).toContain('Draft only from these');
  });

  it('carries only the last 2 Draft Items, with their state, and never screenshots', () => {
    const extra = [
      draft('d1', 3000, {
        title: 'First',
        annotation_ids: [a1!.annotation_id],
        locations: [{ role: 'subject', element: 'x', selector: null, annotation: 1 }],
      }),
      draft('d2', 3100, {
        title: 'Second',
        annotation_ids: [a1!.annotation_id],
        locations: [{ role: 'subject', element: 'x', selector: null, annotation: 1 }],
      }),
      action('d2', 3200, 'discard', 'voice'),
      draft('d3', 3300, {
        title: 'Third',
        annotation_ids: [a1!.annotation_id],
        locations: [{ role: 'subject', element: "button 'Get started'", selector: 'button.cta', annotation: 1 }],
      }),
      action('d3', 3400, 'pin'),
    ];
    const events = withEvents(extra).events;
    const p = buildDraftPrompt({
      events,
      fresh: ids(events.filter((e) => e.t >= a2!.t)),
      start_url: doc.session.start_url,
    });
    expect(p.script).not.toContain('"First"');
    expect(p.script).toContain(
      '- d2 "Second" (layout) · subject x #1 · DISCARDED by the reviewer: do not produce this reading again',
    );
    expect(p.script).toContain(
      `- d3 "Third" (layout) · subject button 'Get started' (button.cta) #1 · PINNED by the reviewer`,
    );
    expect(p.script).not.toMatch(/DRAFT d\d/); // drafts are context, not new events
    expect(JSON.stringify(p)).not.toMatch(/image|base64/);
  });

  it('is empty when nothing new was drawn or said (a Voice Command alone is not content)', () => {
    const cmdSeg = {
      ...segs[0]!,
      id: 'c1',
      segment_id: 'cmd',
      t: 12_000,
      t_end: 12_400,
      text: 'pin that',
      words: null,
    };
    const cmd: TimelineEvent = {
      id: 'c2',
      type: 'voice_command',
      t: 12_000,
      t_end: 12_400,
      command: 'pin_that',
      phrase: 'pin that',
      segment_id: 'cmd',
      target: null,
    };
    const events = withEvents([cmdSeg, cmd]).events;
    expect(buildDraftPrompt({ events, fresh: ids([cmdSeg, cmd]), start_url: doc.session.start_url }).empty).toBe(true);
    expect(buildDraftPrompt({ events, fresh: new Set(), start_url: doc.session.start_url }).empty).toBe(true);
  });

  it('checks Annotation numbers, maps a draft to the Annotations it covers, and numbers drafts', () => {
    const ctx = { annotations: { 1: 'ann-1', 2: 'ann-2' } };
    const out = DraftOutputSchema.parse({
      items: [
        {
          title: 't',
          category: 'layout',
          intent: 'i',
          transcript: '',
          locations: [
            { role: 'subject', element: 'e', selector: null, annotation: 2 },
            { role: 'reference', element: 'f', selector: null, annotation: 1 },
          ],
        },
      ],
    });
    expect(checkDraftOutput(out.items, ctx)).toEqual([]);
    expect(coveredAnnotationIds(out.items[0]!, ctx)).toEqual(['ann-1', 'ann-2']);
    expect(
      checkDraftOutput(
        [{ ...out.items[0]!, locations: [{ role: 'subject', element: 'e', selector: null, annotation: 7 }] }],
        ctx,
      ),
    ).toEqual(['items.0.locations.0.annotation: there is no Annotation #7']);
    expect(() =>
      DraftOutputSchema.parse({
        items: [{ ...out.items[0]!, locations: [{ role: 'reference', element: 'e', selector: null, annotation: 1 }] }],
      }),
    ).toThrow(/subject/);
    expect(nextDraftId([])).toBe('d1');
    expect(nextDraftId([draft('d1', 1), draft('d7', 2)])).toBe('d8');
  });
});

describe('pinned Draft Items in Process', () => {
  const modelItem = (over: Partial<ChangeItem> = {}): ChangeItem =>
    ChangeItemSchema.parse({
      id: 'item_0001',
      title: 'Relocate the CTA',
      category: 'style',
      intent: 'Model rewrite.',
      locations: [
        {
          role: 'subject',
          selector: 'button.cta',
          element: "button 'Get started'",
          url: '/pricing.html',
          screenshot: shotOf(a1!),
          annotation: 1,
        },
        {
          role: 'destination',
          selector: 'nav',
          element: 'nav',
          url: '/pricing.html',
          screenshot: shotOf(a2!),
          annotation: 2,
        },
      ],
      evidence: { video: { start: 1, end: 9 }, screenshots: [shotOf(a1!), shotOf(a2!)] },
      transcript: 'this button ... should go here',
      confidence: 0.4,
      ambiguity: 'unsure',
      agent_prompt: `Do it. screenshots/${shotOf(a1!)}.png screenshots/${shotOf(a2!)}.png`,
      pinned: false,
      ...over,
    });
  const speechOnly = (over: Partial<ChangeItem> = {}) =>
    modelItem({
      id: 'item_0002',
      title: 'Check the header height',
      category: 'question',
      intent: 'Is the header too tall?',
      locations: [
        { role: 'subject', selector: null, element: 'page', url: '/pricing.html', screenshot: null, annotation: null },
      ],
      evidence: { video: { start: 12, end: 13 }, screenshots: [] },
      confidence: 0.8,
      ambiguity: undefined,
      agent_prompt: 'Check it.',
      ...over,
    });
  const pinnedEvents = withEvents([draft('d1', 9800), action('d1', 11_000, 'pin', 'voice')]).events;

  it('the model left the pinned draft out: it is converted in code, and a rewrite of it is dropped', () => {
    const r = mergePinnedDrafts([modelItem(), speechOnly()], pinnedEvents, doc.session.start_url);
    expect(r.converted).toEqual(['d1']);
    expect(r.dropped).toEqual(['item_0001']);
    expect(r.items.map((i) => [i.title, i.pinned])).toEqual([
      ["Move 'Get started' into the header", true],
      ['Check the header height', false],
    ]);
    const pinned = r.items[0]!;
    expect(ChangeItemSchema.parse(pinned)).toEqual(pinned);
    expect(pinned.id).toBe('item_0003');
    expect(r.pinned).toEqual({ d1: 'item_0003' });
    expect(pinned.locations.map((l) => [l.role, l.selector, l.annotation, l.screenshot])).toEqual([
      ['subject', 'button.cta', 1, shotOf(a1!)],
      ['destination', 'nav', 2, shotOf(a2!)],
    ]);
    expect(pinned.evidence).toEqual({
      video: { start: Math.round(a1!.t / 100) / 10, end: Math.round(a2!.t_end / 100) / 10 },
      screenshots: [shotOf(a1!), shotOf(a2!)],
    });
    expect(pinned.agent_prompt).toContain(`screenshots/${shotOf(a2!)}.png`);
    expect(pinned.confidence).toBe(1);
  });

  it('the model kept it pinned: its item stays, with the draft title, category and intent, and no "check me"', () => {
    const r = mergePinnedDrafts([modelItem({ pinned: true }), speechOnly()], pinnedEvents, doc.session.start_url);
    expect(r.converted).toEqual([]);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      id: 'item_0001',
      title: "Move 'Get started' into the header",
      category: 'layout',
      intent: 'The CTA belongs in the header nav, right of Docs.',
      pinned: true,
      confidence: 0.6,
    });
    expect(r.items[0]!.ambiguity).toBeUndefined();
    expect(r.items[0]!.agent_prompt).toBe(modelItem().agent_prompt);
  });

  it('an item that only overlaps the pinned cover stays; a pin the model invented is removed', () => {
    const overlap = modelItem({
      id: 'item_0005',
      locations: [modelItem().locations[0]!],
      evidence: { video: { start: 1, end: 2 }, screenshots: [shotOf(a1!)] },
      agent_prompt: `x screenshots/${shotOf(a1!)}.png`,
    });
    const r = mergePinnedDrafts([overlap, speechOnly({ pinned: true })], pinnedEvents, doc.session.start_url);
    expect(r.items.map((i) => [i.id, i.pinned])).toEqual([
      ['item_0005', false],
      ['item_0006', true],
      ['item_0002', false],
    ]);
  });

  it('a pinned draft discarded afterwards is not pinned; with no pins nothing changes', () => {
    const events = withEvents([draft('d1', 9800), action('d1', 11_000, 'pin'), action('d1', 11_500, 'discard')]).events;
    expect(mergePinnedDrafts([modelItem()], events, doc.session.start_url).items).toEqual([modelItem()]);
    expect(mergePinnedDrafts([modelItem(), speechOnly()], doc.events, doc.session.start_url).items).toEqual([
      modelItem(),
      speechOnly(),
    ]);
  });

  it('a speech-only draft (no Annotation) converts to a page Location', () => {
    const d = draft('d4', 13_000, {
      title: 'Tighten the header',
      category: 'style',
      locations: [{ role: 'subject', element: 'page', selector: null, annotation: null }],
      annotation_ids: [],
    });
    const item = draftToChangeItem(d, doc.events, doc.session.start_url, 'item_0009');
    expect(item).toMatchObject({
      id: 'item_0009',
      pinned: true,
      evidence: { video: null, screenshots: [] },
      locations: [{ role: 'subject', selector: null, url: '/pricing.html', annotation: null }],
    });
  });

  it('the Process script lists pinned drafts as fixed items and discarded ones as rejected readings', () => {
    const d2 = draft('d2', 10_500, {
      title: 'Make the nav bigger',
      category: 'style',
      locations: [{ role: 'subject', element: 'header nav', selector: 'nav', annotation: 2 }],
      annotation_ids: [a2!.annotation_id],
    });
    const { script } = buildProcessPrompt(
      withEvents([draft('d1', 9800), d2, action('d1', 11_000, 'pin', 'voice'), action('d2', 11_200, 'discard')]),
    );
    expect(script).toContain(
      `[00:09.8] DRAFT d1 "Move 'Get started' into the header" (layout) · subject button 'Get started' #1 · destination header nav #2`,
    );
    expect(script).toContain('[00:11.0] DRAFT d1 → PINNED by user');
    expect(script).toMatch(
      /\n\nPINNED DRAFT ITEMS \(fixed: .*\):\n- d1 "Move 'Get started' into the header" \(layout\) · intent: "The CTA belongs in the header nav, right of Docs\." · subject button 'Get started' \(button\.cta\) #1 · destination header nav \(nav\) #2/,
    );
    expect(script).toMatch(
      /\n\nREJECTED DRAFT ITEMS \(negative examples: .*\):\n- the reviewer rejected: d2 "Make the nav bigger" \(style\)/,
    );
  });
});

describe('Draft Item state and the discard rate', () => {
  it('the latest action wins, and the rate counts discards by click and by voice', () => {
    const events = [
      draft('d1', 1),
      draft('d2', 2),
      draft('d3', 3),
      draft('d4', 4),
      action('d1', 5, 'pin'),
      action('d1', 6, 'discard', 'voice'),
      action('d2', 7, 'discard'),
      action('d3', 8, 'pin', 'voice'),
    ];
    expect([...draftStates(events)]).toEqual([
      ['d1', 'discarded'],
      ['d2', 'discarded'],
      ['d3', 'pinned'],
      ['d4', 'shown'],
    ]);
    expect(draftViews(events).map((v) => v.source)).toEqual(['voice', 'click', 'voice', null]);
    expect(draftStats(events)).toEqual({
      drafts: 4,
      pinned: 1,
      discarded: 2,
      discarded_by: { click: 1, voice: 1 },
      discard_rate: 0.5,
    });
    expect(draftStats([]).discard_rate).toBeNull();
  });

  it('session.json rejects an action on an unknown draft, and a draft covering an unknown Annotation', () => {
    expect(SessionDocumentSchema.safeParse(withEvents([draft('d1', 9800), action('d1', 11_000, 'pin')])).success).toBe(
      true,
    );
    const r1 = SessionDocumentSchema.safeParse(withEvents([action('d9', 11_000, 'pin')]));
    expect(r1.error?.issues.map((i) => i.message)).toEqual(['action on unknown draft d9']);
    const r2 = SessionDocumentSchema.safeParse(withEvents([draft('d1', 9800, { annotation_ids: ['nope'] })]));
    expect(r2.error?.issues.map((i) => i.message)).toEqual(['unknown annotation nope']);
  });
});
