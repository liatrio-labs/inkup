// E11: comment-box dictation and Process without a model. Speech dictated into a comment box (a `target` on its
// segments) is that comment's text, never the Session transcript: Process, the review page and review.md do not read
// it, and a re-run leaves out what was said in those spans. A Session of typed comments (or any Session without a key)
// becomes one Change Item per Annotation and Text Comment, built in code.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { type ElementSnapshot, objectSelectRanking } from '../src/candidates';
import { renderReviewMarkdown } from '../src/export/review-md';
import { annotationToChangeItem, buildProcessPrompt, guessCategory, needsModel, processInCode } from '../src/process';
import { applyTranscriptEdits } from '../src/review-edits';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import { type EventOf, type TimelineEvent, TimelineEventSchema } from '../src/timeline';
import { activeTranscript } from '../src/transcription-runs';

const START = 'http://localhost:4401/pricing.html';
const page = { url: START, scroll: { x: 0, y: 0 }, viewport: { width: 1280, height: 720 }, dpr: 2 };

const cta: ElementSnapshot = {
  key: 'e0',
  parent: null,
  depth: 5,
  tag: 'button',
  role: 'button',
  name: 'Get started',
  text: 'Get started',
  selector: '[data-testid="hero-cta"]',
  testid: 'hero-cta',
  id: null,
  classes: ['cta'],
  bbox: { x: 600, y: 300, width: 160, height: 56 },
  stroke_hit: false,
};

const parse = (e: unknown) => TimelineEventSchema.parse(e);

function pick(index: number, t: number, comment: string | null, id = `a${index}`): EventOf<'annotation'> {
  return parse({
    id: `ev-${id}`,
    type: 'annotation',
    t,
    t_end: t + 2000,
    annotation_id: id,
    index,
    stroke_ids: [],
    close_reason: 'object_select',
    comment,
    bbox: cta.bbox,
    ...page,
    ...objectSelectRanking(cta),
    screenshot_id: `shot-${id}`,
    connector: null,
  }) as EventOf<'annotation'>;
}

/** A drawn circle around nothing in particular: a region. */
function drawn(index: number, t: number, comment: string | null): EventOf<'annotation'> {
  return parse({
    id: `ev-d${index}`,
    type: 'annotation',
    t,
    t_end: t + 1500,
    annotation_id: `d${index}`,
    index,
    stroke_ids: [`s${index}`],
    close_reason: 'draw_toggle',
    comment,
    bbox: { x: 40, y: 500, width: 300, height: 120 },
    ...page,
    resolution: 'region',
    candidates: [],
    pick: null,
    screenshot_id: `shot-d${index}`,
    connector: null,
  }) as EventOf<'annotation'>;
}

function textComment(t: number, text: string): EventOf<'text_comment'> {
  return parse({
    id: 'ev-tc',
    type: 'text_comment',
    t,
    t_end: t + 3000,
    comment_id: 'c1',
    index: 1,
    selected_text: 'Ship reviews in minutes',
    anchor: { exact: 'Ship reviews in minutes', prefix: 'Pricing Fixture ', suffix: ' Record a spoken review' },
    element: {
      selector: '#hero-title',
      tag: 'h1',
      role: 'heading',
      name: 'Ship reviews in minutes',
      text: 'Ship reviews in minutes',
      testid: null,
      id: 'hero-title',
      classes: [],
      bbox: { x: 40, y: 80, width: 600, height: 48 },
    },
    comment: text,
    bbox: { x: 40, y: 80, width: 420, height: 48 },
    ...page,
    screenshot_id: 'shot-tc',
  }) as EventOf<'text_comment'>;
}

const segment = (
  id: string,
  t: number,
  t_end: number,
  text: string,
  target: EventOf<'transcript_segment'>['target'] = null,
  run_id: string | null = null,
): TimelineEvent =>
  parse({
    id: `ev-${id}`,
    type: 'transcript_segment',
    t,
    t_end,
    segment_id: id,
    text,
    engine: 'scripted',
    local: true,
    timestamp_quality: 'approximate',
    words: null,
    confidence: null,
    run_id,
    target,
  });

const start = (voice: boolean): TimelineEvent =>
  parse({
    id: 'ev-start',
    type: 'session_start',
    t: 0,
    tab_id: 1,
    url: START,
    title: 'Pricing',
    t0: 1_790_000_000_000,
    voice,
  });

/** Fixture (a)'s session and media, with these events. */
function doc(events: TimelineEvent[]): SessionDocument {
  const base = JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8'));
  const end = Math.max(...events.map((e) => ('t_end' in e && typeof e.t_end === 'number' ? e.t_end : e.t))) + 1000;
  // Without screenshot blobs to go with them: the document checks every cited screenshot exists.
  const bare = events.map((e) => (e.type === 'annotation' ? { ...e, screenshot_id: null } : e));
  return SessionDocumentSchema.parse({
    ...base,
    change_items: undefined,
    events: [...bare, { id: 'ev-end', type: 'session_end', t: end, reason: 'stop', duration_ms: end }],
  });
}

describe('dictated speech is its comment, not the transcript', () => {
  it('activeTranscript leaves out segments with a target', () => {
    const events = [
      segment('g1', 1000, 2000, 'look at this'),
      segment('g2', 3000, 4000, 'make this roomier', { annotation_id: 'a1' }),
      segment('g3', 5000, 6000, 'this should say Pricing plans', { comment_id: 'c1' }),
    ];
    expect(
      activeTranscript(events)
        .filter((e) => e.type === 'transcript_segment')
        .map((e) => e.segment_id),
    ).toEqual(['g1']);
  });

  it('a re-run leaves out what was said inside a dictated span', () => {
    const run = parse({
      id: 'ev-run',
      type: 'transcription_run',
      t: 9000,
      run_id: 'r1',
      engine: 'whisper',
      model: 'base',
      local: true,
      timestamp_quality: 'word',
      segment_count: 2,
      created_at: '2026-09-23T10:02:00.000Z',
    });
    const events = [
      segment('g1', 1000, 2000, 'look at this'),
      segment('g2', 3000, 4000, 'make this roomier', { annotation_id: 'a1' }),
      run,
      segment('r-1', 1000, 2000, 'look at this', null, 'r1'),
      segment('r-2', 3100, 3900, 'make this roomier', null, 'r1'),
    ];
    expect(
      activeTranscript(events)
        .filter((e) => e.type === 'transcript_segment')
        .map((e) => e.segment_id),
    ).toEqual(['r-1']);
  });

  it('Process, review.md and the script never see dictated words as speech', () => {
    const d = doc([
      start(true),
      pick(1, 3000, 'make this roomier'),
      segment('g1', 3200, 4500, 'make this roomier', { annotation_id: 'a1' }),
    ]);
    expect(buildProcessPrompt(d).script).not.toContain('SPEECH');
    expect(renderReviewMarkdown(d, { include: { video: false, audio: false } })).not.toMatch(/\] make this roomier/);
    expect(needsModel(applyTranscriptEdits(d.events))).toBe(false);
  });
});

describe('Process without a model', () => {
  it('a Session of typed comments needs no model; speech or an uncommented Annotation does', () => {
    expect(needsModel([pick(1, 1000, 'Make this roomier'), drawn(2, 5000, 'Too much empty space')])).toBe(false);
    expect(needsModel([pick(1, 1000, 'Make this roomier'), drawn(2, 5000, null)])).toBe(true);
    expect(needsModel([pick(1, 1000, 'Make this roomier'), segment('g1', 8000, 9000, 'and the footer is off')])).toBe(
      true,
    );
  });

  it('pick + typed, text comment + typed, draw + typed note: three items with the typed text, in time order', () => {
    const events = [
      start(false),
      pick(1, 1000, 'Make this roomier'),
      textComment(4000, 'This should say Pricing plans'),
      drawn(2, 9000, 'Too much empty space here'),
    ];
    const { items } = processInCode(applyTranscriptEdits(events), START);
    expect(items.map((i) => i.id)).toEqual(['item_0001', 'item_0002', 'item_0003']);
    expect(items.map((i) => i.intent)).toEqual([
      'Make this roomier',
      'Replace the text "Ship reviews in minutes" with "Pricing plans".',
      'Too much empty space here',
    ]);
    const [p, , d] = items;
    expect(p!.locations[0]).toMatchObject({
      role: 'subject',
      selector: '[data-testid="hero-cta"]',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: 'shot-a1',
      annotation: 1,
    });
    expect(p!.category).toBe('style');
    expect(p!.agent_prompt).toContain('screenshots/shot-a1.png');
    expect(p!.agent_prompt).toContain('Make this roomier');
    expect(p!.evidence).toEqual({ video: { start: 1, end: 3 }, screenshots: ['shot-a1'] });
    expect(d!.locations[0]).toMatchObject({ selector: null, element: 'region of the page', annotation: 2 });
    expect(items[1]!.category).toBe('copy');
  });

  it('without a key a mixed Session still gets an item per Annotation, speech quoted, a bare one flagged', () => {
    const events = [
      start(true),
      pick(1, 1000, null),
      segment('g1', 1200, 2500, 'make this one bigger'),
      drawn(2, 6000, null),
      segment('g9', 20_000, 21_000, 'overall it looks fine'),
    ];
    const { items } = processInCode(applyTranscriptEdits(events), START);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      intent: 'make this one bigger',
      transcript: 'make this one bigger',
      confidence: 0.8,
    });
    expect(items[1]).toMatchObject({
      category: 'question',
      confidence: 0.3,
      ambiguity: 'Nothing was said or typed about this Annotation.',
    });
  });

  it('guessCategory reads the comment', () => {
    expect(guessCategory('Is this needed?')).toBe('question');
    expect(guessCategory('The link is broken')).toBe('bug');
    expect(guessCategory('Should say Pricing')).toBe('copy');
    expect(guessCategory('Move it to the left')).toBe('layout');
    expect(guessCategory('Make the font bold')).toBe('style');
    expect(guessCategory('Add a testimonial')).toBe('content');
  });

  it('annotationToChangeItem prefers a page API comment', () => {
    const a = { ...pick(1, 1000, null), source: 'page_api' as const, page_api: { comment: 'Tighten the padding' } };
    expect(annotationToChangeItem(a as EventOf<'annotation'>, [], START, 'item_0001').intent).toBe(
      'Tighten the padding',
    );
  });

  it('the script says a Session had no voice', () => {
    expect(buildProcessPrompt(doc([start(false), pick(1, 1000, 'Make this roomier')])).script).toContain('NO VOICE');
  });
});
